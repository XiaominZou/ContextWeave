import { createServer, type AddressInfo } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentEventEnvelope } from "@ctx/core";
import type {
  AdapterRunHandle,
  AdapterRunInput,
  CliAdapterPayload,
  McpServerConfig,
  RenderContextInput,
} from "@ctx/adapter-kit";
import { buildPlatformMemoryMcpServers, buildPlatformTaskMcpServers } from "@ctx/adapter-kit";
import { renderSnapshotToPromptText } from "./context-render";

export const OPENCODE_HOST_RUNTIME_NAME = "opencode-host";
export const OPENCODE_HOST_RUNTIME_VERSION = "0.1.0";
export const OPENCODE_HOST_RUNTIME_CAPABILITIES = {
  invocationMode: "cli-process",
  streaming: true,
  toolCalls: true,
  checkpoints: false,
  resume: false,
  interrupt: true,
  nativeMcp: true,
  capabilitySupport: {
    context: "intercept",
    memory: "intercept",
    tasks: "intercept",
    artifacts: "observe-only",
  },
} as const;

/**
 * @deprecated Prefer OpenCodePlatformHost for the supported `opencode -> platform.runtime.bridge` path.
 * This options shape remains as a compatibility layer for the host-backed runtime implementation.
 */
export interface OpenCodeHostAdapterOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
  agent?: string;
}

interface WrappedRawEvent {
  context: {
    workspaceId: string;
    sessionId: string;
    taskId: string;
    runId: string;
  };
  event: unknown;
}

interface OpenCodePromptResponse {
  info?: Record<string, unknown>;
  parts?: unknown[];
}

interface OpenCodeStoredMessage {
  info?: Record<string, unknown>;
  parts?: unknown[];
}

interface OpenCodeSessionStatus {
  type?: string;
  message?: string;
  attempt?: number;
  next?: number;
}

interface OpenCodePermissionRequest {
  id?: string;
  sessionID?: string;
}

interface OpenCodeHostStreamState {
  usageEmitted: boolean;
  emittedToolCalls: Set<string>;
  emittedToolResults: Set<string>;
  emittedTextLength: number;
  completed: boolean;
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()?.({ value: undefined, done: true });
    }
  }

  stream(): AsyncIterable<T> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<T>> {
            if (self.values.length > 0) {
              return Promise.resolve({ value: self.values.shift()!, done: false });
            }
            if (self.closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise((resolve) => self.resolvers.push(resolve));
          },
        };
      },
    };
  }
}

export function renderOpenCodeHostPayload(
  options: OpenCodeHostAdapterOptions,
  input: RenderContextInput,
): CliAdapterPayload {
  return {
    mode: "cli-process",
    argv: [],
    env: { ...options.env },
    configFileInjection: input.policy.context === "native" ? undefined : renderSnapshotToPromptText(input.snapshot),
    mcpServers: [
      ...(input.policy.memory === "tool-bridge" ? (input.toolBridge?.memoryMcpServers ?? buildPlatformMemoryMcpServers(input.run)) : []),
      ...(input.policy.tasks === "platform-tools" ? (input.toolBridge?.taskMcpServers ?? buildPlatformTaskMcpServers(input.run)) : []),
    ],
  } satisfies CliAdapterPayload;
}

export async function createOpenCodeHostRun(
  options: OpenCodeHostAdapterOptions,
  input: AdapterRunInput,
): Promise<AdapterRunHandle> {
  if (input.payload.mode !== "cli-process") {
    throw new Error("OpenCodeHostAdapter requires cli-process payload");
  }

  const payload = input.payload;
  const queue = new AsyncQueue<WrappedRawEvent>();
  const controller = new AbortController();
  const command = resolveCommand(options.binaryPath);
  const cwd = options.cwd ?? process.cwd();
  const port = await getAvailablePort();
  const args = [...(options.binaryArgs ?? []), 'serve', `--hostname=127.0.0.1`, `--port=${port}`];
  debug('spawn-host', { command, args, cwd });

  const child = spawnCommand(command, args, {
    cwd,
    env: {
      ...process.env,
      ...payload.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();

  const context = {
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sessionId,
    taskId: input.run.taskId,
    runId: input.run.id,
  };

  const lifecycle = (async () => {
    try {
      const baseUrl = await waitForServerUrl(child, port, options.startupTimeoutMs ?? 15000);
      const session = await postJson<{ id: string }>(`${baseUrl}/session?directory=${encodeURIComponent(cwd)}`, {
        title: input.run.id,
      }, controller.signal);
      debug('created-session', { sessionId: session.id, cwd });

      await registerMcpServers({
        baseUrl,
        cwd,
        signal: controller.signal,
        mcpServers: payload.mcpServers,
      });

      queue.push({
        context,
        event: {
          type: 'run.started',
          sessionID: session.id,
          model: input.run.model,
        },
      });

      const promptBody = {
        ...(payload.configFileInjection ? { system: payload.configFileInjection } : {}),
        parts: [{ type: 'text', text: userPrompt(input.run) }],
        ...(input.run.model ? { model: input.run.model } : {}),
        ...(options.agent ? { agent: options.agent } : {}),
        noReply: false,
      };

      const streamed = await tryStreamPromptResponse({
        baseUrl,
        cwd,
        sessionId: session.id,
        signal: controller.signal,
        promptBody,
        queue,
        context,
        timeoutMs: 90_000,
      });
      if (!streamed) {
        const promptResponse = await postMaybeJson<OpenCodePromptResponse>(
          `${baseUrl}/session/${session.id}/message`,
          promptBody,
          controller.signal,
        );
        if (promptResponse) {
          debug('prompt-response', {
            sessionId: session.id,
            finish: isRecord(promptResponse.info) ? readString(promptResponse.info.finish) ?? null : null,
            partCount: Array.isArray(promptResponse.parts) ? promptResponse.parts.length : 0,
          });
          emitPromptResponse(queue, context, promptResponse);
        }
      }
    } catch (error) {
      queue.push({
        context,
        event: {
          type: 'error',
          code: 'OPENCODE_HOST_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      controller.abort();
      child.kill();
      queue.close();
    }
  })();

  void lifecycle;

  return {
    streamEvents() {
      return queue.stream();
    },
    cancel: async () => {
      controller.abort();
      child.kill();
    },
  };
}

export function normalizeOpenCodeHostEvent(rawEvent: unknown): AgentEventEnvelope | null {
  const wrapped = unwrapRawEvent(rawEvent);
  const event = wrapped?.event ?? rawEvent;
  const context = wrapped?.context ?? {
    workspaceId: 'ws_contract',
    sessionId: 'sess_contract',
    taskId: 'task_contract',
    runId: 'run_contract',
  };

  const base = {
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    workspaceId: context.workspaceId,
    sessionId: context.sessionId,
    taskId: context.taskId,
    runId: context.runId,
    adapter: OPENCODE_HOST_RUNTIME_NAME,
    timestamp: new Date().toISOString(),
  };

  if (!isRecord(event)) {
    return null;
  }

  const type = readString(event.type);
  switch (type) {
    case 'run.started':
    case 'run_started':
    case 'session.started':
      return {
        ...base,
        type: 'run.started',
        payload: {
          model: readString(event.model),
          externalRef: readString(event.sessionID) ?? readString(event.sessionId),
        },
      };
    case 'text':
    case 'message.delta':
      return {
        ...base,
        type: 'message.delta',
        payload: {
          role: 'assistant',
          text: readString(event.text) ?? readNestedString(event.part, 'text') ?? '',
        },
      };
    case 'tool.call':
    case 'tool_call':
    case 'tool_use':
      return {
        ...base,
        type: 'tool.call',
        payload: {
          callId: readString(event.callID) ?? readString(event.callId) ?? readString(event.id) ?? 'call_unknown',
          name: readString(event.name) ?? readString(event.tool) ?? readNestedString(event.part, 'tool') ?? readNestedString(event.part, 'name') ?? 'unknown_tool',
          input: event.input ?? readNestedValue(event.part, 'input') ?? readNestedValue(readNestedValue(event.part, 'state'), 'input') ?? {},
        },
      };
    case 'tool.result':
    case 'tool_result':
      return {
        ...base,
        type: 'tool.result',
        payload: {
          callId: readString(event.callID) ?? readString(event.callId) ?? 'call_unknown',
          output: event.output ?? readNestedValue(event.part, 'output') ?? null,
          isError: readBoolean(event.isError) ?? false,
        },
      };
    case 'usage':
    case 'run.usage':
      return {
        ...base,
        type: 'run.usage',
        payload: {
          inputTokens:
            readNumber(event.inputTokens) ??
            readNumber(event.input_tokens) ??
            readNestedNumber(event.usage, 'inputTokens') ??
            readNestedNumber(event.usage, 'input_tokens'),
          outputTokens:
            readNumber(event.outputTokens) ??
            readNumber(event.output_tokens) ??
            readNestedNumber(event.usage, 'outputTokens') ??
            readNestedNumber(event.usage, 'output_tokens'),
          cacheReadInputTokens: readUsageCacheReadTokens(event),
          cacheWriteInputTokens: readUsageCacheWriteTokens(event),
        },
      };
    case 'run.completed':
    case 'run_completed':
    case 'message_stop':
      return {
        ...base,
        type: 'run.completed',
        payload: {
          reason: readString(event.reason) ?? readString(event.stop_reason),
        },
      };
    case 'error':
    case 'run.failed':
      return {
        ...base,
        type: 'run.failed',
        payload: {
          error: {
            code: readString(event.code) ?? 'OPENCODE_HOST_ERROR',
            message: readString(event.message) ?? 'OpenCode host error',
          },
        },
      };
    default:
      return null;
  }
}

async function tryStreamPromptResponse(input: {
  baseUrl: string;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  promptBody: Record<string, unknown>;
  queue: AsyncQueue<WrappedRawEvent>;
  context: WrappedRawEvent['context'];
  timeoutMs: number;
}): Promise<boolean> {
  try {
    await postWithoutReadingBody(
      `${input.baseUrl}/session/${input.sessionId}/prompt_async`,
      input.promptBody,
      input.signal,
    );
  } catch (error) {
    if (isUnsupportedPromptAsyncError(error)) {
      debug('prompt-async-unsupported', { sessionId: input.sessionId });
      return false;
    }
    throw error;
  }

  debug('prompt-async-started', { sessionId: input.sessionId });
  await streamAssistantMessage(input);
  return true;
}

function emitPromptResponse(
  queue: AsyncQueue<WrappedRawEvent>,
  context: WrappedRawEvent['context'],
  response: OpenCodePromptResponse,
): void {
  const usage = isRecord(response.info) ? readNestedValue(response.info, 'usage') : undefined;
  if (isRecord(usage)) {
    queue.push({
      context,
      event: {
        type: 'run.usage',
        usage,
      },
    });
  }

  for (const part of response.parts ?? []) {
    if (!isRecord(part)) {
      continue;
    }

    const type = readString(part.type);
    if (type === 'text') {
      queue.push({ context, event: { type: 'text', text: readString(part.text) ?? '', part } });
      continue;
    }

    if (type !== 'tool') {
      continue;
    }

    const state = isRecord(part.state) ? part.state : {};
    const callId = readString(part.callID) ?? readString(part.id) ?? 'call_unknown';
    const name = readString(part.tool) ?? 'unknown_tool';
    queue.push({
      context,
      event: {
        type: 'tool.call',
        callID: callId,
        name,
        input: readNestedValue(state, 'input') ?? {},
      },
    });
    queue.push({
      context,
      event: {
        type: 'tool.result',
        callID: callId,
        output: readNestedValue(state, 'output') ?? readNestedValue(state, 'error') ?? null,
        isError: readString(state.status) === 'error',
      },
    });
  }

  queue.push({
    context,
    event: {
      type: 'run.completed',
      reason: response.info && isRecord(response.info) ? readString(response.info.finish) ?? 'stop' : 'stop',
    },
  });
}

async function streamAssistantMessage(input: {
  baseUrl: string;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  promptBody: Record<string, unknown>;
  queue: AsyncQueue<WrappedRawEvent>;
  context: WrappedRawEvent['context'];
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + input.timeoutMs;
  const state: OpenCodeHostStreamState = {
    usageEmitted: false,
    emittedToolCalls: new Set<string>(),
    emittedToolResults: new Set<string>(),
    emittedTextLength: 0,
    completed: false,
  };

  while (Date.now() < deadline) {
    if (input.signal.aborted) {
      throw new Error('OpenCode host polling aborted');
    }

    await autoReplyPendingPermissions(input);

    const messages = await getJson<Array<OpenCodeStoredMessage>>(
      `${input.baseUrl}/session/${input.sessionId}/message?directory=${encodeURIComponent(input.cwd)}`,
      input.signal,
    );
    const statuses = await getJson<Record<string, OpenCodeSessionStatus>>(
      `${input.baseUrl}/session/status?directory=${encodeURIComponent(input.cwd)}`,
      input.signal,
    ).catch(() => undefined);
    const status = statuses?.[input.sessionId];
    debug('host-poll', buildPollDebugSnapshot({
      sessionId: input.sessionId,
      messages,
      status,
      permissionsReplied: undefined,
    }));
    const latest = findLatestAssistantMessage(messages, input.sessionId);
    if (latest) {
      emitAssistantMessageProgress({
        queue: input.queue,
        context: input.context,
        message: latest,
        sessionId: input.sessionId,
        state,
      });
      if (state.completed) {
        return;
      }
    }

    await delay(100);
  }

  const messages = await getJson<Array<OpenCodeStoredMessage>>(
    `${input.baseUrl}/session/${input.sessionId}/message?directory=${encodeURIComponent(input.cwd)}`,
    input.signal,
  ).catch(() => []);
  const statuses = await getJson<Record<string, OpenCodeSessionStatus>>(
    `${input.baseUrl}/session/status?directory=${encodeURIComponent(input.cwd)}`,
    input.signal,
  ).catch(() => undefined);
  const status = statuses?.[input.sessionId];
  const permissions = await getJson<Array<OpenCodePermissionRequest>>(
    `${input.baseUrl}/permission?directory=${encodeURIComponent(input.cwd)}`,
    input.signal,
  ).catch(() => []);

  throw new Error(
    `Timed out waiting for completed assistant message for session ${input.sessionId}. ${JSON.stringify(buildPollDebugSnapshot({
      sessionId: input.sessionId,
      messages,
      status,
      permissionsReplied: permissions.filter((item) => item?.sessionID === input.sessionId).length,
    }))}`,
  );
}

function emitAssistantMessageProgress(input: {
  queue: AsyncQueue<WrappedRawEvent>;
  context: WrappedRawEvent['context'];
  message: OpenCodeStoredMessage;
  sessionId: string;
  state: OpenCodeHostStreamState;
}): void {
  const info = isRecord(input.message.info) ? input.message.info : undefined;
  const usage = info ? readNestedValue(info, 'usage') : undefined;
  if (!input.state.usageEmitted && isRecord(usage)) {
    input.queue.push({
      context: input.context,
      event: {
        type: 'run.usage',
        usage,
      },
    });
    input.state.usageEmitted = true;
  }

  for (const part of input.message.parts ?? []) {
    if (!isRecord(part) || readString(part.type) !== 'tool') {
      continue;
    }

    const state = isRecord(part.state) ? part.state : {};
    const callId = readString(part.callID) ?? readString(part.id) ?? 'call_unknown';
    if (!input.state.emittedToolCalls.has(callId)) {
      input.queue.push({
        context: input.context,
        event: {
          type: 'tool.call',
          callID: callId,
          name: readString(part.tool) ?? 'unknown_tool',
          input: readNestedValue(state, 'input') ?? {},
        },
      });
      input.state.emittedToolCalls.add(callId);
    }

    const statusValue = readString(state.status);
    if (!input.state.emittedToolResults.has(callId) && (statusValue === 'completed' || statusValue === 'error')) {
      input.queue.push({
        context: input.context,
        event: {
          type: 'tool.result',
          callID: callId,
          output: readNestedValue(state, 'output') ?? readNestedValue(state, 'error') ?? null,
          isError: statusValue === 'error',
        },
      });
      input.state.emittedToolResults.add(callId);
    }
  }

  const nextText = flattenAssistantText(input.message);
  if (nextText.length > input.state.emittedTextLength) {
    input.queue.push({
      context: input.context,
      event: {
        type: 'text',
        text: nextText.slice(input.state.emittedTextLength),
      },
    });
    input.state.emittedTextLength = nextText.length;
  }

  if (!input.state.completed && isCompletedAssistantMessage(input.message, input.sessionId)) {
    input.queue.push({
      context: input.context,
      event: {
        type: 'run.completed',
        reason: info ? readString(info.finish) ?? 'stop' : 'stop',
      },
    });
    input.state.completed = true;
  }
}

function flattenAssistantText(message: OpenCodeStoredMessage): string {
  return (message.parts ?? [])
    .filter((part): part is Record<string, unknown> => isRecord(part) && readString(part.type) === 'text')
    .map((part) => readString(part.text) ?? '')
    .join('');
}

function findLatestAssistantMessage(messages: Array<OpenCodeStoredMessage>, sessionId: string): OpenCodeStoredMessage | undefined {
  return [...messages]
    .reverse()
    .find((message) => {
      const info = isRecord(message.info) ? message.info : undefined;
      return readString(info?.role) === 'assistant' && readString(info?.sessionID) === sessionId;
    });
}

function isUnsupportedPromptAsyncError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /HTTP (404|405|501)/.test(error.message);
}

function isCompletedAssistantMessage(message: OpenCodeStoredMessage, sessionId: string): boolean {
  const info = isRecord(message.info) ? message.info : undefined;
  if (!info) {
    return false;
  }
  if (readString(info.role) !== 'assistant') {
    return false;
  }
  if (readString(info.sessionID) !== sessionId) {
    return false;
  }
  const time = isRecord(info.time) ? info.time : undefined;
  return typeof readNumber(time?.completed) === 'number';
}

function buildPollDebugSnapshot(input: {
  sessionId: string;
  messages: Array<OpenCodeStoredMessage>;
  status?: OpenCodeSessionStatus;
  permissionsReplied: number | undefined;
}): Record<string, unknown> {
  const latest = [...input.messages]
    .reverse()
    .find((message) => {
      const info = isRecord(message.info) ? message.info : undefined;
      return readString(info?.sessionID) === input.sessionId;
    });
  const latestInfo = isRecord(latest?.info) ? latest.info : undefined;
  return {
    sessionId: input.sessionId,
    sessionStatus: input.status?.type ?? null,
    sessionStatusMessage: input.status?.message ?? null,
    messageCount: input.messages.length,
    latestRole: readString(latestInfo?.role),
    latestFinish: readString(latestInfo?.finish),
    latestCompletedAt: isRecord(latestInfo?.time) ? readNumber(latestInfo.time.completed) : undefined,
    latestPartTypes: Array.isArray(latest?.parts)
      ? latest.parts
          .filter((part) => isRecord(part))
          .map((part) => readString((part as Record<string, unknown>).type))
          .filter(Boolean)
      : [],
    pendingPermissions: input.permissionsReplied,
  };
}

async function autoReplyPendingPermissions(input: {
  baseUrl: string;
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
}): Promise<void> {
  const pending = await getJson<Array<OpenCodePermissionRequest>>(
    `${input.baseUrl}/permission?directory=${encodeURIComponent(input.cwd)}`,
    input.signal,
  ).catch(() => []);

  const relevant = pending.filter((item) => item && item.sessionID === input.sessionId && typeof item.id === 'string');
  for (const request of relevant) {
    await postJson<boolean>(
      `${input.baseUrl}/permission/${request.id}/reply?directory=${encodeURIComponent(input.cwd)}`,
      { reply: 'once' },
      input.signal,
    );
  }
}

async function waitForServerUrl(child: ChildProcessWithoutNullStreams, port: number, timeoutMs: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for OpenCode host server on port ${port}`));
    }, timeoutMs);

    const onChunk = (chunk: Buffer) => {
      output += chunk.toString();
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
        if (line.includes('opencode server listening') && match) {
          clearTimeout(timeout);
          resolve(match[1]);
          return;
        }
      }
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`OpenCode host server exited before ready with code ${code}. ${output}`.trim()));
    });
  });
}

async function postJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders(url, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenCode host HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function postMaybeJson<T>(url: string, body: unknown, signal: AbortSignal): Promise<T | undefined> {
  const response = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders(url, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenCode host HTTP ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  debug('http-post', {
    url,
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
    bodyLength: text.length,
  });
  if (!text.trim()) {
    return undefined;
  }
  return JSON.parse(text) as T;
}

async function postWithoutReadingBody(url: string, body: unknown, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, {
    method: 'POST',
    headers: withDirectoryHeaders(url, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenCode host HTTP ${response.status}: ${await response.text()}`);
  }
  debug('http-post-empty', {
    url,
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentLength: response.headers.get('content-length'),
  });
  try {
    await response.body?.cancel();
  } catch {
    // Ignore body cancellation errors; we only need the request to be accepted.
  }
}

async function registerMcpServers(input: {
  baseUrl: string;
  cwd: string;
  signal: AbortSignal;
  mcpServers?: McpServerConfig[];
}): Promise<void> {
  const servers = dedupeMcpServersByName(input.mcpServers ?? []);
  for (const server of servers) {
    await postJson(
      `${input.baseUrl}/mcp?directory=${encodeURIComponent(input.cwd)}`,
      {
        name: server.name,
        config: {
          type: "local",
          command: [server.command, ...(server.args ?? [])],
          environment: server.env,
          enabled: true,
        },
      },
      input.signal,
    );
  }
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    method: 'GET',
    headers: withDirectoryHeaders(url),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenCode host HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

function dedupeMcpServersByName(servers: McpServerConfig[]): McpServerConfig[] {
  const deduped = new Map<string, McpServerConfig>();
  for (const server of servers) {
    deduped.set(server.name, server);
  }
  return [...deduped.values()];
}

function withDirectoryHeaders(url: string, headers: Record<string, string> = {}): Record<string, string> {
  try {
    const parsed = new URL(url);
    const directory = parsed.searchParams.get('directory');
    if (!directory) {
      return headers;
    }
    return {
      ...headers,
      'x-opencode-directory': directory,
    };
  } catch {
    return headers;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getAvailablePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo | null;
      if (!address) {
        server.close();
        reject(new Error('Failed to allocate an OpenCode host port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

function userPrompt(run: AdapterRunInput['run']): string {
  if (run.metadata && typeof run.metadata['prompt'] === 'string') {
    return String(run.metadata['prompt']);
  }
  return run.model ? `Continue task ${run.id}` : `Run task ${run.id}`;
}

function resolveCommand(binaryPath?: string): string {
  if (binaryPath) {
    return binaryPath;
  }
  return process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
}

function spawnCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
): ChildProcessWithoutNullStreams {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', quoteWindowsCommand(command, args)], options);
  }
  return spawn(command, args, options);
}

function quoteWindowsCommand(command: string, args: string[]): string {
  return [command, ...args].map(quoteWindowsArg).join(' ');
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

function unwrapRawEvent(rawEvent: unknown): WrappedRawEvent | null {
  if (!isRecord(rawEvent) || !isRecord(rawEvent.context)) {
    return null;
  }
  return rawEvent as unknown as WrappedRawEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNestedString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value[key]);
}

function readNestedNumber(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readNumber(value[key]);
}

function readNestedValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return value[key];
}

function readUsageCacheReadTokens(event: Record<string, unknown>): number | undefined {
  return (
    readNumber(event.cacheReadInputTokens) ??
    readNumber(event.cache_read_input_tokens) ??
    readNestedNumber(event.usage, 'cacheReadInputTokens') ??
    readNestedNumber(event.usage, 'cache_read_input_tokens') ??
    readNestedNumber(readNestedValue(event.usage, 'cache'), 'read') ??
    readNestedNumber(readNestedValue(event.usage, 'cache'), 'read_tokens')
  );
}

function readUsageCacheWriteTokens(event: Record<string, unknown>): number | undefined {
  return (
    readNumber(event.cacheWriteInputTokens) ??
    readNumber(event.cache_write_input_tokens) ??
    readNestedNumber(event.usage, 'cacheWriteInputTokens') ??
    readNestedNumber(event.usage, 'cache_write_input_tokens') ??
    readNestedNumber(readNestedValue(event.usage, 'cache'), 'write') ??
    readNestedNumber(readNestedValue(event.usage, 'cache'), 'write_tokens')
  );
}

function debug(label: string, value: unknown): void {
  if (process.env.CTX_DEBUG_OPENCODE !== '1') {
    return;
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  console.error(`[opencode-host-adapter] ${label}: ${rendered}`);
}
