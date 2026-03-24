#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";

import { createContextPlatform } from "../packages/client/src/platform.ts";
import { defaultCapabilityPolicy } from "../packages/core/src/policies.ts";
import { createInMemoryMemorySubsystem } from "../packages/testing/src/in-memory-memory.ts";
import { InMemoryStore } from "../packages/testing/src/in-memory-store.ts";

const HOST = process.env.CTX_OPENCLAW_DAEMON_HOST || "127.0.0.1";
const PORT = Number(process.env.CTX_OPENCLAW_DAEMON_PORT || "4318");
const USER_ID = process.env.CTX_OPENCLAW_USER_ID || undefined;

const store = new InMemoryStore();
const memorySubsystem = createInMemoryMemorySubsystem();
const platform = createContextPlatform({
  store,
  memory: {
    provider: memorySubsystem.provider,
    engine: memorySubsystem.engine,
  },
});
const client = platform.client();

const bindings = new Map();
const transcripts = new Map();

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
        sessions: store.sessions.size,
        tasks: store.tasks.size,
        runs: store.runs.size,
        memories: memorySubsystem.state.records.size,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/bootstrap") {
      const body = await readJson(request);
      const binding = await ensureBinding(body);
      writeJson(response, 200, {
        bootstrapped: true,
        importedMessages: transcripts.get(binding.sessionId)?.length ?? 0,
        binding,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/ingest") {
      const body = await readJson(request);
      const binding = await ensureBinding(body);
      appendTranscript(binding.sessionId, body.message);
      await maybeUpdateTaskFromMessage(binding, body.message);
      writeJson(response, 200, { ingested: true, binding });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/assemble") {
      const body = await readJson(request);
      const binding = await ensureBinding(body);

      if (typeof body.prompt === "string" && body.prompt.trim()) {
        await client.tasks.update(binding.taskId, {
          title: summarize(body.prompt),
          objective: body.prompt.trim(),
          status: "running",
        });
      }

      const preview = await client.experimental.context.preview({
        workspaceId: binding.workspaceId,
        sessionId: binding.sessionId,
        taskId: binding.taskId,
        adapter: "openclaw",
        model: typeof body.model === "string" ? body.model : undefined,
        metadata: {
          userId: USER_ID,
          prompt: typeof body.prompt === "string" ? body.prompt : undefined,
          workspaceDir: binding.workspaceDir,
          openclawSessionRef: binding.sessionRef,
        },
        policy: {
          ...defaultCapabilityPolicy,
          context: "inject",
          memory: "platform",
          tasks: "observe-native",
          artifacts: "observe",
        },
      });

      const systemPromptAddition = renderSnapshot(preview.snapshot, {
        workspaceDir: binding.workspaceDir,
        tokenBudget: typeof body.tokenBudget === "number" ? body.tokenBudget : undefined,
      });

      writeJson(response, 200, {
        messages: Array.isArray(body.messages) ? body.messages : [],
        estimatedTokens: preview.snapshot.tokenEstimate + estimateMessages(Array.isArray(body.messages) ? body.messages : []),
        systemPromptAddition,
        binding,
        snapshotId: preview.snapshot.id,
        explanation: preview.explanation,
      });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/context-engine/compact") {
      const body = await readJson(request);
      const binding = await ensureBinding(body);
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
      const binding = await ensureBinding(body);
      const messages = Array.isArray(body.messages) ? body.messages : [];
      for (const message of messages) {
        appendTranscript(binding.sessionId, message);
        await maybeUpdateTaskFromMessage(binding, message);
      }
      writeJson(response, 200, { ok: true, binding });
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/openclaw/memory/remember") {
      const body = await readJson(request);
      const binding = await ensureBinding(body);
      if (typeof body.content !== "string" || !body.content.trim()) {
        writeJson(response, 400, { error: { code: "BAD_REQUEST", message: "content is required" } });
        return;
      }

      const record = await client.experimental.memory.writeConfirmed({
        record: {
          workspaceId: binding.workspaceId,
          userId: USER_ID,
          sessionId: binding.sessionId,
          taskId: binding.taskId,
          runId: undefined,
          ownerRef: USER_ID ? { type: "user", id: USER_ID } : { type: "workspace", id: binding.workspaceId },
          scope: USER_ID ? "user" : "workspace",
          layer: "long_term",
          channel: USER_ID ? "profile" : "collection",
          kind: typeof body.kind === "string" ? body.kind : "fact",
          status: "active",
          title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : summarize(body.content),
          content: body.content.trim(),
          summary: typeof body.summary === "string" && body.summary.trim() ? body.summary.trim() : summarize(body.content),
          importance: 0.8,
          confidence: 0.9,
          confirmedBy: "user",
          sourceRefs: [{ type: "task", id: binding.taskId }],
        },
      });
      writeJson(response, 200, { ok: true, record, binding });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/openclaw/state") {
      writeJson(response, 200, {
        ok: true,
        bindings: [...bindings.values()],
        sessions: store.listSessions(),
        tasks: store.listTasks(),
        runs: [...store.runs.values()],
        events: [...store.events.entries()],
        memories: [...memorySubsystem.state.records.values()],
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

async function ensureBinding(input) {
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

  const workspaceId = `ws_${shortHash(workspaceDir)}`;
  const session = await client.sessions.create({
    workspaceId,
    title: path.basename(workspaceDir) || "OpenClaw Workspace",
    metadata: {
      workspaceDir,
      openclawSessionRef: sessionRef,
      userId: USER_ID,
    },
  });
  const canonicalSession = store.saveSession({
    ...session,
    externalRef: sessionRef,
    metadata: {
      ...session.metadata,
      workspaceDir,
      openclawSessionRef: sessionRef,
      userId: USER_ID,
    },
  });

  const task = await client.tasks.create({
    workspaceId,
    sessionId: canonicalSession.id,
    title: "OpenClaw Active Task",
    objective: `Active OpenClaw session for ${workspaceDir}`,
  });
  const canonicalTask = await client.tasks.update(task.id, {
    status: "running",
    metadata: {
      workspaceDir,
      openclawSessionRef: sessionRef,
    },
  });

  transcripts.set(canonicalSession.id, []);

  const binding = {
    workspaceId,
    sessionId: canonicalSession.id,
    taskId: canonicalTask.id,
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

async function maybeUpdateTaskFromMessage(binding, message) {
  if (!isRecord(message)) {
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
  await client.tasks.update(binding.taskId, {
    title: summarize(text),
    objective: text,
    status: "running",
  });
}

function renderSnapshot(snapshot, input) {
  const sections = [
    `[CTX_PLATFORM_WORKSPACE] ${input.workspaceDir}`,
    `[CTX_PLATFORM_SNAPSHOT_ID] ${snapshot.id}`,
    snapshot.blocks.length
      ? `[CTX_PLATFORM_CONTEXT]\n${snapshot.blocks.map(renderBlock).join("\n\n")}`
      : "",
    typeof input.tokenBudget === "number"
      ? `[CTX_PLATFORM_BUDGET] ${input.tokenBudget} tokens`
      : "",
  ].filter(Boolean);
  return sections.join("\n\n");
}

function renderBlock(block) {
  const title = block.title ? `${block.kind.toUpperCase()}: ${block.title}` : block.kind.toUpperCase();
  return `[${title}]\n${block.content}`;
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
