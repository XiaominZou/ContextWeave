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
let syntheticOpenClawAdapter;

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

      const prompt = resolvePromptText(body, messages);
      syntheticOpenClawAdapter.enqueueTurn({
        externalRef: binding.sessionRef,
        rawEvents: buildSyntheticRunEvents(messages, body),
      });
      const handle = await client.runs.start({
        workspaceId: binding.workspaceId,
        sessionId: binding.sessionId,
        taskId: binding.taskId,
        adapter: syntheticOpenClawAdapter.name,
        model: typeof body.model === "string" ? body.model : undefined,
        metadata: {
          userId: USER_ID,
          prompt,
          workspaceDir: binding.workspaceDir,
          openclawSessionRef: binding.sessionRef,
          openclawAfterTurn: true,
        },
        capabilityPolicy: {
          ...defaultCapabilityPolicy,
          context: "inject",
          memory: "platform",
          tasks: "observe-native",
          artifacts: "observe",
        },
      });
      const events = await collectEvents(handle);
      writeJson(response, 200, {
        ok: true,
        binding,
        runId: handle.runId,
        externalRef: handle.externalRef,
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

function resolvePromptText(body, messages) {
  if (typeof body.prompt === "string" && body.prompt.trim()) {
    return body.prompt.trim();
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "user") {
      continue;
    }
    const text = stringifyContent(message.content).trim();
    if (text) {
      return text;
    }
  }
  return "OpenClaw turn";
}

function buildSyntheticRunEvents(messages, body) {
  const rawEvents = [
    {
      type: "run_started",
      model: typeof body.model === "string" ? body.model : undefined,
      externalRef: typeof body.sessionKey === "string" ? body.sessionKey : typeof body.sessionId === "string" ? body.sessionId : undefined,
    },
  ];

  let messageIndex = 0;
  let toolIndex = 0;
  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : "";
    if (role === "assistant") {
      const text = stringifyContent(message.content).trim();
      if (!text) {
        continue;
      }
      rawEvents.push({ type: "text_delta", text });
      rawEvents.push({ type: "message_completed", messageId: `openclaw_msg_${++messageIndex}` });
      continue;
    }

    if (role === "tool") {
      const toolName = typeof message.name === "string" && message.name ? message.name : `tool_${++toolIndex}`;
      const callId = typeof message.toolCallId === "string" && message.toolCallId ? message.toolCallId : `tool_call_${toolIndex}`;
      rawEvents.push({
        type: "tool_call",
        callId,
        name: toolName,
        input: isRecord(message.input) ? message.input : {},
      });
      rawEvents.push({
        type: "tool_result",
        callId,
        output: message.content ?? null,
        isError: Boolean(message.isError),
      });
    }
  }

  rawEvents.push({ type: "run_completed", reason: typeof body.autoCompactionSummary === "string" ? "turn_complete_with_compaction" : "turn_complete" });
  return rawEvents;
}

async function collectEvents(handle) {
  const events = [];
  for await (const event of handle.streamEvents()) {
    events.push(event);
  }
  return events;
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

class SyntheticOpenClawAdapter {
  name = "openclaw-synthetic";
  version = "0.1.0";
  invocationMode = "sdk";
  capabilities = {
    invocationMode: "sdk",
    streaming: true,
    toolCalls: true,
    checkpoints: false,
    resume: false,
    interrupt: true,
    nativeMcp: false,
    capabilitySupport: {
      context: "intercept",
      memory: "intercept",
      tasks: "observe-only",
      artifacts: "observe-only",
    },
  };

  #queue = [];
  #currentRunContext = null;

  enqueueTurn(turn) {
    this.#queue.push(turn);
  }

  async renderContext(input) {
    return {
      mode: "sdk",
      systemPrompt: input.snapshot ? renderSnapshot(input.snapshot, { workspaceDir: String(input.run.metadata?.workspaceDir ?? ""), tokenBudget: undefined }) : "",
      messages: [],
      tools: [],
    };
  }

  async createRun(input) {
    const turn = this.#queue.shift();
    if (!turn) {
      throw new Error("SyntheticOpenClawAdapter.createRun() called without queued raw events");
    }
    this.#currentRunContext = {
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      taskId: input.run.taskId,
      runId: input.run.id,
    };
    let cancelled = false;
    return {
      externalRef: turn.externalRef,
      streamEvents: async function* () {
        for (const rawEvent of turn.rawEvents) {
          if (cancelled) {
            break;
          }
          yield rawEvent;
        }
      },
      cancel: async () => {
        cancelled = true;
      },
    };
  }

  normalizeEvent(rawEvent) {
    if (!isRecord(rawEvent) || typeof rawEvent.type !== "string") {
      return null;
    }
    const context = this.#currentRunContext ?? {
      workspaceId: "ws_contract",
      sessionId: "sess_contract",
      taskId: "task_contract",
      runId: "run_contract",
    };
    return {
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      workspaceId: context.workspaceId,
      sessionId: context.sessionId,
      taskId: context.taskId,
      runId: context.runId,
      adapter: this.name,
      timestamp: new Date().toISOString(),
      type: normalizeSyntheticType(rawEvent.type),
      payload: normalizeSyntheticPayload(rawEvent),
    };
  }
}

syntheticOpenClawAdapter = new SyntheticOpenClawAdapter();
platform.runtime.adapters.register(syntheticOpenClawAdapter);

function normalizeSyntheticType(type) {
  switch (type) {
    case "run_started":
      return "run.started";
    case "text_delta":
      return "message.delta";
    case "message_completed":
      return "message.completed";
    case "tool_call":
      return "tool.call";
    case "tool_result":
      return "tool.result";
    case "run_completed":
      return "run.completed";
    case "run_failed":
      return "run.failed";
    case "run_cancelled":
      return "run.cancelled";
    default:
      return type;
  }
}

function normalizeSyntheticPayload(rawEvent) {
  switch (rawEvent.type) {
    case "run_started":
      return { model: rawEvent.model, externalRef: rawEvent.externalRef };
    case "text_delta":
      return { role: "assistant", text: typeof rawEvent.text === "string" ? rawEvent.text : "" };
    case "message_completed":
      return { messageId: typeof rawEvent.messageId === "string" ? rawEvent.messageId : "msg_unknown" };
    case "tool_call":
      return {
        callId: typeof rawEvent.callId === "string" ? rawEvent.callId : "call_unknown",
        name: typeof rawEvent.name === "string" ? rawEvent.name : "unknown_tool",
        input: rawEvent.input ?? {},
      };
    case "tool_result":
      return {
        callId: typeof rawEvent.callId === "string" ? rawEvent.callId : "call_unknown",
        output: rawEvent.output ?? null,
        isError: Boolean(rawEvent.isError),
      };
    case "run_completed":
      return { reason: typeof rawEvent.reason === "string" ? rawEvent.reason : undefined };
    case "run_failed":
      return { error: rawEvent.error ?? { code: "OPENCLAW_SYNTHETIC_ERROR", message: "synthetic run failed" } };
    case "run_cancelled":
      return { reason: typeof rawEvent.reason === "string" ? rawEvent.reason : undefined };
    default:
      return {};
  }
}
