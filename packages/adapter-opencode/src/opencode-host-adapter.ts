import { createServer, type AddressInfo } from "node:net";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { AgentEventEnvelope } from "@ctx/core";
import type {
  AdapterCapabilities,
  AdapterPayload,
  AdapterRunHandle,
  AdapterRunInput,
  AgentAdapter,
  CliAdapterPayload,
  RenderContextInput,
  ResumeRunInput,
} from "@ctx/adapter-kit";

export interface OpenCodeHostAdapterOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
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
  info?: {
    finish?: string;
  };
  parts?: unknown[];
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

export class OpenCodeHostAdapter implements AgentAdapter {
  readonly name = "opencode-host";
  readonly version = "0.1.0";
  readonly invocationMode = "cli-process" as const;

  readonly capabilities: AdapterCapabilities = {
    invocationMode: "cli-process",
    streaming: false,
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

  constructor(private readonly options: OpenCodeHostAdapterOptions = {}) {}

  async renderContext(input: RenderContextInput): Promise<AdapterPayload> {
    return {
      mode: "cli-process",
      argv: [],
      env: { ...this.options.env },
      configFileInjection: input.policy.context === "native" ? undefined : renderSnapshotToText(input.snapshot),
    } satisfies CliAdapterPayload;
  }

  async createRun(input: AdapterRunInput): Promise<AdapterRunHandle> {
    if (input.payload.mode !== "cli-process") {
      throw new Error("OpenCodeHostAdapter requires cli-process payload");
    }

    const payload = input.payload;
    const queue = new AsyncQueue<WrappedRawEvent>();
    const controller = new AbortController();
    const command = resolveCommand(this.options.binaryPath);
    const cwd = this.options.cwd ?? process.cwd();
    const port = await getAvailablePort();
    const args = [...(this.options.binaryArgs ?? []), 'serve', `--hostname=127.0.0.1`, `--port=${port}`];
    debug('spawn-host', { command, args, cwd });

    const child = spawnCommand(command, args, {
      cwd,
      env: {
        ...process.env,
        ...input.payload.env,
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
        const baseUrl = await waitForServerUrl(child, port, this.options.startupTimeoutMs ?? 15000);
        const session = await postJson<{ id: string }>(`${baseUrl}/session?directory=${encodeURIComponent(cwd)}`, {
          title: input.run.id,
        }, controller.signal);

        queue.push({
          context,
          event: {
            type: 'run.started',
            sessionID: session.id,
            model: input.run.model,
          },
        });

        const promptResponse = await postJson<OpenCodePromptResponse>(
          `${baseUrl}/session/${session.id}/message?directory=${encodeURIComponent(cwd)}`,
          {
            ...(payload.configFileInjection ? { system: payload.configFileInjection } : {}),
            parts: [{ type: 'text', text: userPrompt(input.run) }],
          },
          controller.signal,
        );

        emitPromptResponse(queue, context, promptResponse);
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

  normalizeEvent(rawEvent: unknown): AgentEventEnvelope | null {
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
      adapter: this.name,
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
            name: readString(event.name) ?? readNestedString(event.part, 'name') ?? 'unknown_tool',
            input: event.input ?? readNestedValue(event.part, 'input') ?? {},
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

  resumeRun(_input: ResumeRunInput): Promise<AdapterRunHandle> {
    throw new Error('OpenCodeHostAdapter does not support resume in V1');
  }
}

function emitPromptResponse(
  queue: AsyncQueue<WrappedRawEvent>,
  context: WrappedRawEvent['context'],
  response: OpenCodePromptResponse,
): void {
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(`OpenCode host HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as T;
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

function renderSnapshotToText(snapshot: RenderContextInput['snapshot']): string {
  if (!snapshot) {
    return '';
  }
  return snapshot.blocks.map((block) => block.content).join('\n');
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

function readNestedString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value[key]);
}

function readNestedValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return value[key];
}

function debug(label: string, value: unknown): void {
  if (process.env.CTX_DEBUG_OPENCODE !== '1') {
    return;
  }
  const rendered = typeof value === 'string' ? value : JSON.stringify(value);
  console.error(`[opencode-host-adapter] ${label}: ${rendered}`);
}
