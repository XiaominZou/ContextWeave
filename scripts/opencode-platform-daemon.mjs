#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";

const HOST = process.env.CTX_OPENCODE_DAEMON_HOST || "127.0.0.1";
const PORT = Number(process.env.CTX_OPENCODE_DAEMON_PORT || "4317");
const USER_ID = process.env.CTX_OPENCODE_USER_ID || undefined;

const bindings = new Map();
const sessions = new Map();
const tasks = new Map();
const memories = new Map();
let nextMemoryId = 1;

const server = http.createServer(async (request, response) => {
  try {
    if (!request.url) {
      writeJson(response, 400, { error: { code: "BAD_REQUEST", message: "missing url" } });
      return;
    }

    const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);

    if (request.method === "GET" && url.pathname === "/health") {
      writeJson(response, 200, { ok: true, host: HOST, port: PORT, bindings: bindings.size, memories: memories.size });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/context/system") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      const system = buildSystemContext(binding);
      writeJson(response, 200, { ok: true, system, binding });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/message") {
      const body = await readJson(request);
      const binding = ensureBinding(body);
      writeJson(response, 200, { ok: true, binding });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/memory/remember") {
      const body = await readJson(request);
      if (typeof body.directory !== "string" || typeof body.content !== "string" || !body.content.trim()) {
        writeJson(response, 400, { error: { code: "BAD_REQUEST", message: "directory and content are required" } });
        return;
      }
      const binding = ensureBinding(body);
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

    if (request.method === "GET" && url.pathname === "/v1/state") {
      writeJson(response, 200, {
        ok: true,
        sessions: [...sessions.values()],
        tasks: [...tasks.values()],
        memories: [...memories.values()],
      });
      return;
    }

    writeJson(response, 404, { error: { code: "NOT_FOUND", message: "route not found" } });
  } catch (error) {
    writeJson(response, 500, { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[ctx-opencode-daemon] listening on http://${HOST}:${PORT}\n`);
});

function ensureBinding(input) {
  if (typeof input.directory !== "string" || !input.directory.trim()) {
    throw new Error("directory is required");
  }
  const directory = path.resolve(input.directory);
  const opencodeSessionId = typeof input.opencodeSessionId === "string" && input.opencodeSessionId.trim() ? input.opencodeSessionId.trim() : `dir_${shortHash(directory)}`;
  const key = `${directory}::${opencodeSessionId}`;
  const existing = bindings.get(key);
  if (existing) {
    if (typeof input.text === "string" && input.text.trim()) {
      const task = tasks.get(existing.taskId);
      task.objective = input.text.trim();
      task.title = summarize(input.text);
      task.updatedAt = new Date().toISOString();
    }
    return existing;
  }

  const now = new Date().toISOString();
  const workspaceId = `ws_${shortHash(directory)}`;
  const sessionId = `sess_${shortHash(`${directory}:session:${opencodeSessionId}`)}`;
  const taskId = `task_${shortHash(`${directory}:task:${opencodeSessionId}`)}`;
  const session = {
    id: sessionId,
    workspaceId,
    title: path.basename(directory) || "OpenCode Workspace",
    status: "active",
    metadata: { directory, opencodeSessionId, userId: USER_ID },
    createdAt: now,
    updatedAt: now,
  };
  const task = {
    id: taskId,
    workspaceId,
    sessionId,
    title: typeof input.text === "string" && input.text.trim() ? summarize(input.text) : "OpenCode Active Task",
    objective: typeof input.text === "string" && input.text.trim() ? input.text.trim() : `Active OpenCode session for ${directory}`,
    status: "in_progress",
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(sessionId, session);
  tasks.set(taskId, task);
  const binding = { workspaceId, sessionId, taskId, directory, opencodeSessionId };
  bindings.set(key, binding);
  return binding;
}

function buildSystemContext(binding) {
  const task = tasks.get(binding.taskId);
  const relevantMemories = [...memories.values()]
    .filter((record) => record.workspaceId === binding.workspaceId)
    .sort((a, b) => scoreMemory(b, task?.objective || "") - scoreMemory(a, task?.objective || ""))
    .slice(0, 8);

  const sections = [
    `[WORKSPACE] ${binding.directory}`,
    task ? `[TASK]\nTitle: ${task.title}\nObjective: ${task.objective}` : "",
    relevantMemories.length
      ? `[MEMORY]\n${relevantMemories.map((record) => `- ${record.title}: ${record.summary || record.content}`).join("\n")}`
      : "",
  ].filter(Boolean);

  return sections.join("\n\n");
}

function scoreMemory(record, query) {
  const haystack = `${record.title} ${record.content} ${record.summary || ""}`.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) {
    return 0;
  }
  return tokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
}

function shortHash(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function summarize(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 80) || "Remembered item";
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
