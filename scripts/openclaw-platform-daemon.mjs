#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

import { normalizeOpenClawAfterTurn, sliceOpenClawTurnMessages, stringifyOpenClawContent } from "../packages/adapter-openclaw/src/index.ts";
import { createContextPlatform } from "../packages/client/src/platform.ts";
import { defaultCapabilityPolicy } from "../packages/core/src/policies.ts";
import { createFileBackedMemorySubsystem } from "../packages/testing/src/file-backed-memory.ts";
import { FileBackedStore } from "../packages/testing/src/file-backed-store.ts";

const HOST = process.env.CTX_OPENCLAW_DAEMON_HOST || "127.0.0.1";
const PORT = Number(process.env.CTX_OPENCLAW_DAEMON_PORT || "4318");
const USER_ID = process.env.CTX_OPENCLAW_USER_ID || undefined;
const STATE_DIR = process.env.CTX_OPENCLAW_DAEMON_STATE_DIR || path.join(homedir(), ".openclaw", "ctx-platform-daemon");
const STORE_FILE = process.env.CTX_OPENCLAW_DAEMON_STORE_FILE || path.join(STATE_DIR, "platform-store.json");
const MEMORY_FILE = process.env.CTX_OPENCLAW_DAEMON_MEMORY_FILE || path.join(STATE_DIR, "memory.json");
const BINDINGS_FILE = process.env.CTX_OPENCLAW_DAEMON_BINDINGS_FILE || path.join(STATE_DIR, "bindings.json");
const TRANSCRIPTS_FILE = process.env.CTX_OPENCLAW_DAEMON_TRANSCRIPTS_FILE || path.join(STATE_DIR, "transcripts.json");

const store = new FileBackedStore(STORE_FILE);
const memorySubsystem = createFileBackedMemorySubsystem(MEMORY_FILE);
const platform = createContextPlatform({
  store,
  memory: {
    provider: memorySubsystem.provider,
    engine: memorySubsystem.engine,
  },
});
const client = platform.client();

const bindings = loadBindings(BINDINGS_FILE);
const transcripts = loadTranscripts(TRANSCRIPTS_FILE);

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
      let binding = await ensureBinding(body);

      if (typeof body.prompt === "string" && body.prompt.trim()) {
        await client.tasks.update(binding.taskId, {
          title: summarize(body.prompt),
          objective: body.prompt.trim(),
          status: "running",
        });
      }

      const prompt = resolvePromptText(body, Array.isArray(body.messages) ? body.messages : []);
      const preparedResult = await prepareBridgeRun(binding, body, prompt, "superseded_by_new_assemble");
      binding = preparedResult.binding;

      const assembledMessages = buildAssembledMessages({
        messages: Array.isArray(body.messages) ? body.messages : [],
        prompt: typeof body.prompt === "string" ? body.prompt : undefined,
        systemPromptAddition: preparedResult.prepared.prompt.systemPrompt,
        contextMode: resolveContextMode(body),
      });

      writeJson(response, 200, {
        messages: assembledMessages,
        estimatedTokens: estimateMessages(assembledMessages),
        systemPromptAddition: undefined,
        binding,
        runId: preparedResult.prepared.run.id,
        snapshotId: preparedResult.prepared.snapshot?.id,
        explanation: preparedResult.prepared.snapshot?.explanation,
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
      let binding = await ensureBinding(body);
      const preparedResult = await ensurePreparedRun(binding, body);
      binding = preparedResult.binding;

      const normalizedTurn = normalizeOpenClawAfterTurn({
        run: {
          workspaceId: binding.workspaceId,
          sessionId: binding.sessionId,
          taskId: binding.taskId,
          runId: preparedResult.run.id,
        },
        turn: {
          sessionId: typeof body.sessionId === "string" ? body.sessionId : binding.sessionRef,
          sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : binding.sessionRef,
          messages: Array.isArray(body.messages) ? body.messages : [],
          prePromptMessageCount: typeof body.prePromptMessageCount === "number" ? body.prePromptMessageCount : 0,
          autoCompactionSummary: typeof body.autoCompactionSummary === "string" ? body.autoCompactionSummary : undefined,
          isHeartbeat: Boolean(body.isHeartbeat),
          model: typeof body.model === "string" ? body.model : undefined,
          runtimeContext: isRecord(body.runtimeContext) ? body.runtimeContext : undefined,
          usage: isRecord(body.usage) ? body.usage : undefined,
          status: typeof body.status === "string" ? body.status : undefined,
          error: body.error,
          cancelled: body.cancelled === true,
        },
      });

      for (const message of normalizedTurn.newMessages) {
        appendTranscript(binding.sessionId, message);
        await maybeUpdateTaskFromMessage(binding, message);
      }

      for (const event of normalizedTurn.events) {
        await platform.runtime.bridge.ingestEvent({
          runId: preparedResult.run.id,
          rawEvent: event,
          normalizeEvent: (rawEvent) => rawEvent,
        });
      }

      const finalizedRun = await platform.runtime.bridge.finalizeRun({
        runId: preparedResult.run.id,
        status: normalizedTurn.finalize.status,
        reason: normalizedTurn.finalize.reason,
        error: normalizedTurn.finalize.error,
      });
      binding = clearPendingRun(binding);
      const events = store.listEvents(finalizedRun.id);

      writeJson(response, 200, {
        ok: true,
        binding,
        runId: finalizedRun.id,
        externalRef: finalizedRun.externalRef,
        status: finalizedRun.status,
        eventCount: events.length,
        eventTypes: events.map((event) => event.type),
      });
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

function loadBindings(filePath) {
  const raw = readJsonFile(filePath, []);
  return new Map(raw.map((binding) => [`${binding.workspaceDir}::${binding.sessionRef}`, binding]));
}

function persistBindings(filePath, bindingsMap) {
  writeJsonFile(filePath, [...bindingsMap.values()]);
}

function loadTranscripts(filePath) {
  const raw = readJsonFile(filePath, []);
  return new Map(raw.map((entry) => [entry.sessionId, Array.isArray(entry.messages) ? entry.messages : []]));
}

function persistTranscripts(filePath, transcriptMap) {
  writeJsonFile(filePath, [...transcripts.entries()].map(([sessionId, messages]) => ({ sessionId, messages })));
}

function readJsonFile(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

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
  persistTranscripts(TRANSCRIPTS_FILE, transcripts);

  const binding = {
    workspaceId,
    sessionId: canonicalSession.id,
    taskId: canonicalTask.id,
    workspaceDir,
    sessionRef,
  };
  saveBinding(binding);
  return binding;
}

function saveBinding(binding) {
  bindings.set(bindingKey(binding), binding);
  persistBindings(BINDINGS_FILE, bindings);
  return binding;
}

function bindingKey(binding) {
  return `${binding.workspaceDir}::${binding.sessionRef}`;
}

function clearPendingRun(binding) {
  if (!binding.pendingRunId && !binding.pendingSnapshotId && !binding.pendingPreparedAt) {
    return binding;
  }
  return saveBinding({
    ...binding,
    pendingRunId: undefined,
    pendingSnapshotId: undefined,
    pendingPreparedAt: undefined,
  });
}

async function cancelPendingRun(binding, reason) {
  if (typeof binding.pendingRunId !== "string" || !binding.pendingRunId) {
    return clearPendingRun(binding);
  }
  const run = store.getRun(binding.pendingRunId);
  if (run && !isTerminalRunStatus(run.status)) {
    await platform.runtime.bridge.finalizeRun({
      runId: run.id,
      status: "cancelled",
      reason,
    });
  }
  return clearPendingRun(binding);
}

async function prepareBridgeRun(binding, body, prompt, supersededReason) {
  const clearedBinding = await cancelPendingRun(binding, supersededReason);
  const prepared = await platform.runtime.bridge.prepareRun({
    workspaceId: clearedBinding.workspaceId,
    sessionId: clearedBinding.sessionId,
    taskId: clearedBinding.taskId,
    runtime: "openclaw",
    capabilityPolicy: buildOpenClawCapabilityPolicy(),
    model: typeof body.model === "string" ? body.model : undefined,
    metadata: buildBridgeMetadata(clearedBinding, body, prompt),
  });
  const nextBinding = saveBinding({
    ...clearedBinding,
    pendingRunId: prepared.run.id,
    pendingSnapshotId: prepared.snapshot?.id,
    pendingPreparedAt: new Date().toISOString(),
  });
  return {
    binding: nextBinding,
    prepared,
  };
}

async function ensurePreparedRun(binding, body) {
  if (typeof binding.pendingRunId === "string" && binding.pendingRunId) {
    const run = store.getRun(binding.pendingRunId);
    if (run && !isTerminalRunStatus(run.status)) {
      return { binding, run };
    }
  }

  const prompt = resolvePromptText(body, Array.isArray(body.messages) ? body.messages : []);
  const preparedResult = await prepareBridgeRun(binding, body, prompt, "superseded_by_after_turn_recovery");
  return {
    binding: preparedResult.binding,
    run: preparedResult.prepared.run,
  };
}

function appendTranscript(sessionId, message) {
  if (!message) {
    return;
  }
  const list = transcripts.get(sessionId) || [];
  list.push(message);
  transcripts.set(sessionId, list.slice(-200));
  persistTranscripts(TRANSCRIPTS_FILE, transcripts);
}

async function maybeUpdateTaskFromMessage(binding, message) {
  if (!isRecord(message)) {
    return;
  }
  const role = typeof message.role === "string" ? message.role : "";
  if (role !== "user") {
    return;
  }
  const text = stringifyOpenClawContent(message.content).trim();
  if (!text) {
    return;
  }
  await client.tasks.update(binding.taskId, {
    title: summarize(text),
    objective: text,
    status: "running",
  });
}

function buildAssembledMessages(input) {
  const platformMessage = {
    role: "system",
    content: input.systemPromptAddition,
  };

  if (input.contextMode === "replace") {
    return [platformMessage, ...selectReplaceMessages(input.messages, input.prompt)];
  }

  return [platformMessage, ...input.messages];
}

function selectReplaceMessages(messages, prompt) {
  const explicitPrompt = typeof prompt === "string" ? prompt.trim() : "";
  if (explicitPrompt) {
    return [{ role: "user", content: explicitPrompt }];
  }

  const filtered = messages.filter((message) => isRecord(message) && typeof message.role === "string" && message.role !== "system");
  for (let index = filtered.length - 1; index >= 0; index -= 1) {
    if (filtered[index]?.role === "user") {
      return filtered.slice(index);
    }
  }
  return filtered;
}

function resolveContextMode(body) {
  return body?.contextMode === "replace" ? "replace" : "inject";
}

function resolvePromptText(body, messages) {
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return body.prompt.trim();
  }

  const turnMessages = sliceOpenClawTurnMessages({
    messages: Array.isArray(messages) ? messages : [],
    prePromptMessageCount: typeof body?.prePromptMessageCount === "number" ? body.prePromptMessageCount : 0,
  });
  const candidateMessages = turnMessages.length > 0 ? turnMessages : messages;

  for (let index = candidateMessages.length - 1; index >= 0; index -= 1) {
    const message = candidateMessages[index];
    if (!isRecord(message) || message.role !== "user") {
      continue;
    }
    const text = stringifyOpenClawContent(message.content).trim();
    if (text) {
      return text;
    }
  }
  return "OpenClaw turn";
}

function buildOpenClawCapabilityPolicy() {
  return {
    ...defaultCapabilityPolicy,
    context: "inject",
    memory: "platform",
    tasks: "observe-native",
    artifacts: "observe",
  };
}

function buildBridgeMetadata(binding, body, prompt) {
  return {
    userId: USER_ID,
    prompt,
    workspaceDir: binding.workspaceDir,
    openclawSessionRef: binding.sessionRef,
    openclawContextMode: resolveContextMode(body),
  };
}

function isTerminalRunStatus(status) {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function estimateMessages(messages) {
  return Math.ceil(messages.map((message) => stringifyOpenClawContent(message?.content)).join("\n").length / 4);
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
