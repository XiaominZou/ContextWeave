#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";

const HOST = process.env.CTX_OPENCLAW_DAEMON_HOST || "127.0.0.1";
const PORT = Number(process.env.CTX_OPENCLAW_DAEMON_PORT || "4318");
const USER_ID = process.env.CTX_OPENCLAW_USER_ID || undefined;

const bindings = new Map();
const sessions = new Map();
const tasks = new Map();
const memories = new Map();
const transcripts = new Map();
let nextMemoryId = 1;

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url) {
      writeJson(response, 400, { error: { code: "BAD_REQUEST", message: "missing url" } });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, {
        ok: true,
        host: HOST,
        port: PORT,
        bindings: bindings.size,
        sessions: sessions.size,
        tasks: tasks.size,
        memories: memories.size,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/bootstrap") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      writeJson(response, 200, {
        bootstrapped: true,
        importedMessages: transcripts.get(binding.sessionId)?.length ?? 0,
        binding,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/ingest") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      appendTranscript(binding.sessionId, body.message);
      maybeUpdateTaskFromMessage(binding, body.message);
      writeJson(response, 200, { ingested: true, binding });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/assemble") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      const task = tasks.get(binding.taskId);
      const relevantMemories = selectRelevantMemories(binding.workspaceId, body.prompt || task?.objective || "");
      const systemPromptAddition = renderPlatformContext({
        binding,
        task,
        relevantMemories,
        tokenBudget: body.tokenBudget,
      });

      if (typeof body.prompt === "string" && body.prompt.trim()) {
        task.objective = body.prompt.trim();
        task.title = summarize(body.prompt);
        task.updatedAt = new Date().toISOString();
      }

      writeJson(response, 200, {
        messages: Array.isArray(body.messages) ? body.messages : [],
        estimatedTokens: estimateMessages(Array.isArray(body.messages) ? body.messages : []) + Math.ceil(systemPromptAddition.length / 4),
        systemPromptAddition,
        binding,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/compact") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      writeJson(response, 200, {
        ok: true,
        compacted: false,
        reason: "platform compaction not implemented; delegate to runtime recommended",
        result: {
          tokensBefore: typeof body.currentTokenCount === "number" ? body.currentTokenCount : estimateMessages(transcripts.get(binding.sessionId) || []),
        },
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/after-turn") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      for (const message of messages) {
        appendTranscript(binding.sessionId, message);
        maybeUpdateTaskFromMessage(binding, message);
      }
      writeJson(response, 200, { ok: true, binding });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/memory/remember") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      if (typeof body.content !== "string" || !body.content.trim()) {
        writeJson(response, 400, { error: { code: "BAD_REQUEST", message: "content is required" } });
        return;
      }
      const record = {
        id: `mem_${nextMemoryId++}`,
        workspaceId: binding.workspaceId,
        userId: USER_ID,
        sessionId: binding.sessionId,
        taskId: binding.taskId,
        ownerRef: USER_ID ? { type: "user", id: USER_ID } : { type: "workspace", id: binding.workspaceId },
        scope: USER_ID ? "user" : "workspace",
        layer: "long_term",
        channel: USER_ID ? "profile" : "collection",
        kind: typeof body.kind === "string" ? body.kind : "fact",
        status: "active",
        title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : summarize(body.content),
        content: body.content.trim(),
        summary: summarize(body.content),
        importance: 0.8,
        confidence: 0.9,
        confirmedBy: "user",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      memories.set(record.id, record);
      writeJson(response, 200, { ok: true, record, binding });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/openclaw/state") {
      writeJson(response, 200, {
        ok: true,
        sessions: [...sessions.values()],
        tasks: [...tasks.values()],
        memories: [...memories.values()],
        transcripts: [...transcripts.entries()],
      });
      return;
    }

    writeJson(response, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
  } catch (error) {
    writeJson(response, 500, { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[ctx-openclaw-daemon] listening on http://${HOST}:${PORT}\n`);
});

function ensureBinding(input) {
  const workspaceDir = typeof input.workspaceDir === "string" && input.workspaceDir.trim()
    ? path.resolve(input.workspaceDir)
    : process.cwd();
  const sessionRef = typeof input.sessionKey === "string" && input.sessionKey.trim()
    ? input.sessionKey.trim()
    : typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId.trim()
      : `dir_${shortHash(workspaceDir)}`;
  const key = `${workspaceDir}::${sessionRef}`;
  const existing = bindings.get(key);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const workspaceId = `ws_${shortHash(workspaceDir)}`;
  const sessionId = `sess_${shortHash(`${workspaceDir}:session:${sessionRef}`)}`;
  const taskId = `task_${shortHash(`${workspaceDir}:task:${sessionRef}`)}`;
  const session = {
    id: sessionId,
    workspaceId,
    title: path.basename(workspaceDir) || "OpenClaw Workspace",
    status: "active",
    metadata: { workspaceDir, sessionRef, userId: USER_ID },
    createdAt: now,
    updatedAt: now,
  };
  const task = {
    id: taskId,
    workspaceId,
    sessionId,
    title: "OpenClaw Active Task",
    objective: `Active OpenClaw session for ${workspaceDir}`,
    status: "running",
    createdAt: now,
    updatedAt: now,
  };

  sessions.set(sessionId, session);
  tasks.set(taskId, task);
  transcripts.set(sessionId, []);

  const binding = {
    workspaceId,
    sessionId,
    taskId,
    workspaceDir,
    sessionRef,
  };
  bindings.set(key, binding);
  return binding;
}

function appendTranscript(sessionId, message) {
  if (!message) {
    return;
  }
  const list = transcripts.get(sessionId) || [];
  list.push(message);
  transcripts.set(sessionId, list.slice(-200));
}

function maybeUpdateTaskFromMessage(binding, message) {
  const task = tasks.get(binding.taskId);
  if (!task || !isRecord(message)) {
    return;
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user") {
    return;
  }
  const text = stringifyContent(message.content).trim();
  if (!text) {
    return;
  }
  task.objective = text;
  task.title = summarize(text);
  task.updatedAt = new Date().toISOString();
}

function selectRelevantMemories(workspaceId, query) {
  return [...memories.values()]
    .filter((record) => record.workspaceId === workspaceId)
    .sort((a, b) => scoreMemory(b, query) - scoreMemory(a, query))
    .slice(0, 8);
}

function renderPlatformContext(input) {
  const sections = [
    `[CTX_PLATFORM_WORKSPACE] ${input.binding.workspaceDir}`,
    input.task
      ? `[CTX_PLATFORM_TASK]
Title: ${input.task.title}
Objective: ${input.task.objective}`
      : "",
    input.relevantMemories.length
      ? `[CTX_PLATFORM_MEMORY]
${input.relevantMemories.map((record) => `- ${record.title}: ${record.summary || record.content}`).join("\n")}`
      : "",
    typeof input.tokenBudget === "number"
      ? `[CTX_PLATFORM_BUDGET] ${input.tokenBudget} tokens`
      : "",
  ].filter(Boolean);

  return sections.join("\n\n");
}

function scoreMemory(record, query) {
  const haystack = `${record.title} ${record.content} ${record.summary || ""}`.toLowerCase();
  const tokens = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return 0;
  }
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function estimateMessages(messages) {
  return Math.ceil(messages.map((message) => stringifyContent(message?.content)).join("\n").length / 4);
}

function stringifyContent(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (isRecord(part) && typeof part.text === "string") {
        return part.text;
      }
      return "";
    }).join("\n");
  }
  if (isRecord(content) && typeof content.text === "string") {
    return content.text;
  }
  return "";
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function summarize(text) {
  return String(text).replace(/\s+/g, " ").trim().slice(0, 80) || "OpenClaw task";
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function writeJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}
