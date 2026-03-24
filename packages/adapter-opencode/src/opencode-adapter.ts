import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

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
import { buildPlatformMemoryMcpServers, buildPlatformTaskMcpServers } from "@ctx/adapter-kit";
import { prepareTransparentPluginOverlay } from "./opencode-transparent-plugin";

export interface OpenCodeAdapterOptions {
  binaryPath?: string;
  binaryArgs?: string[];
  cwd?: string;
  env?: Record<string, string>;
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

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = "opencode";
  readonly version = "0.1.0";
  readonly invocationMode = "cli-process" as const;

  readonly capabilities: AdapterCapabilities = {
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
  };

  constructor(private readonly options: OpenCodeAdapterOptions = {}) {}

  async renderContext(input: RenderContextInput): Promise<AdapterPayload> {
    const prompt = buildPrompt(input);
    const argv = ["run", "--format", "json", prompt];
    const platformContext = input.policy.context === "native" ? undefined : renderSnapshotToText(input.snapshot);

    if (input.run.model) {
      argv.splice(2, 0, "--model", input.run.model);
    }

    return {
      mode: "cli-process",
      argv,
      env: { ...this.options.env },
      stdin: undefined,
      configFileInjection: platformContext || undefined,
      mcpServers: [
        ...(input.policy.memory === "tool-bridge" ? (input.toolBridge?.memoryMcpServers ?? buildPlatformMemoryMcpServers(input.run)) : []),
        ...(input.policy.tasks === "platform-tools" ? (input.toolBridge?.taskMcpServers ?? buildPlatformTaskMcpServers(input.run)) : []),
      ],
    } satisfies CliAdapterPayload;
  }

  async createRun(input: AdapterRunInput): Promise<AdapterRunHandle> {
    if (input.payload.mode !== "cli-process") {
      throw new Error("OpenCodeAdapter requires cli-process payload");
    }

    const queue = new AsyncQueue<WrappedRawEvent>();
    const command = resolveCommand(this.options.binaryPath);
    const commandArgs = [...(this.options.binaryArgs ?? []), ...input.payload.argv];
    let childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...input.payload.env,
    };
    let cleanupOverlay: (() => Promise<void>) | undefined;

    if (input.payload.configFileInjection && input.policy.context !== "native") {
      const overlay = await prepareTransparentPluginOverlay({
        platformContext: input.payload.configFileInjection,
        policy: input.policy.context,
        env: childEnv,
      });
      childEnv = overlay.env;
      cleanupOverlay = overlay.cleanup;
    }

    debug("spawn", { command, commandArgs, cwd: this.options.cwd });

    const child = spawnCommand(command, commandArgs, {
      cwd: this.options.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const context = {
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      taskId: input.run.taskId,
      runId: input.run.id,
    };

    attachJsonLineReader(child, context, queue);
    attachProcessExit(child, context, queue, cleanupOverlay);

    if (input.payload.stdin) {
      child.stdin.write(input.payload.stdin);
    }
    child.stdin.end();

    return {
      streamEvents() {
        return queue.stream();
      },
      cancel: async () => {
        debug("cancel", { pid: child.pid });
        child.kill();
      },
    };
  }

  normalizeEvent(rawEvent: unknown): AgentEventEnvelope | null {
    const wrapped = unwrapRawEvent(rawEvent);
    const event = wrapped?.event ?? rawEvent;
    const context = wrapped?.context ?? {
      workspaceId: "ws_contract",
      sessionId: "sess_contract",
      taskId: "task_contract",
      runId: "run_contract",
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
      case "step_start":
      case "step-start":
      case "run_started":
      case "run.started":
      case "session.started":
        return {
          ...base,
          type: "run.started",
          payload: {
            model: readString(event.model),
            externalRef:
              readString(event.sessionID) ??
              readString(event.sessionId) ??
              readString(event.session_id) ??
              readNestedString(event.part, "sessionID") ??
              readNestedString(event.part, "sessionId"),
          },
        };
      case "text":
      case "text_delta":
      case "message.delta":
        return {
          ...base,
          type: "message.delta",
          payload: {
            role: "assistant",
            text:
              readString(event.text) ??
              readString(event.delta) ??
              readNestedString(event.part, "text") ??
              "",
          },
        };
      case "message_completed":
      case "message.completed":
        return {
          ...base,
          type: "message.completed",
          payload: {
            messageId:
              readString(event.messageID) ??
              readString(event.messageId) ??
              readString(event.id) ??
              readNestedString(event.part, "messageID") ??
              readNestedString(event.part, "messageId") ??
              "msg_unknown",
          },
        };
      case "tool_use":
      case "tool_call":
      case "tool.call":
        return {
          ...base,
          type: "tool.call",
          payload: {
            callId:
              readString(event.callID) ??
              readString(event.callId) ??
              readString(event.id) ??
              readNestedString(event.part, "toolCallID") ??
              readNestedString(event.part, "callID") ??
              "call_unknown",
            name: readString(event.name) ?? readNestedString(event.part, "name") ?? "unknown_tool",
            input: event.input ?? event.arguments ?? readNestedValue(event.part, "input") ?? {},
          },
        };
      case "tool_result":
      case "tool.result":
        return {
          ...base,
          type: "tool.result",
          payload: {
            callId:
              readString(event.callID) ??
              readString(event.callId) ??
              readString(event.tool_use_id) ??
              readNestedString(event.part, "toolCallID") ??
              readNestedString(event.part, "callID") ??
              "call_unknown",
            output: event.output ?? event.content ?? readNestedValue(event.part, "output") ?? readNestedValue(event.part, "content") ?? null,
            isError: readBoolean(event.isError) ?? readNestedBoolean(event.part, "isError") ?? false,
          },
        };
      case "step_finish":
      case "step-finish":
      case "message_stop":
      case "run_completed":
      case "run.completed":
        return {
          ...base,
          type: "run.completed",
          payload: {
            reason:
              readString(event.reason) ??
              readString(event.stop_reason) ??
              readNestedString(event.part, "reason"),
          },
        };
      case "error":
      case "run.failed":
        return {
          ...base,
          type: "run.failed",
          payload: {
            error: {
              code:
                readString(event.code) ??
                readString(event.type) ??
                readNestedString(event.error, "type") ??
                readNestedString(event.part, "type") ??
                "OPENCODE_ERROR",
              message:
                readString(event.message) ??
                readNestedString(event.error, "message") ??
                readNestedString(event.part, "message") ??
                "OpenCode error",
            },
          },
        };
      default:
        return null;
    }
  }

  resumeRun(_input: ResumeRunInput): Promise<AdapterRunHandle> {
    throw new Error("OpenCodeAdapter does not support resume in V1");
  }
}

function buildPrompt(input: RenderContextInput): string {
  if (input.run.metadata && typeof input.run.metadata["prompt"] === "string") {
    return String(input.run.metadata["prompt"]);
  }

  return input.run.model
    ? `Continue task ${input.run.id}`
    : `Run task ${input.run.id}`;
}

function renderSnapshotToText(snapshot: RenderContextInput["snapshot"]): string {
  if (!snapshot) {
    return "";
  }
  return snapshot.blocks.map((block) => block.content).join("\n");
}

function attachJsonLineReader(
  child: ChildProcessWithoutNullStreams,
  context: WrappedRawEvent["context"],
  queue: AsyncQueue<WrappedRawEvent>,
): void {
  const stdout = createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    const trimmed = line.trim();
    debug("stdout-line", trimmed);
    if (!trimmed) {
      return;
    }

    try {
      queue.push({ context, event: JSON.parse(trimmed) });
    } catch {
      queue.push({
        context,
        event: {
          type: "error",
          code: "INVALID_JSON_LINE",
          message: `Failed to parse OpenCode JSON line: ${trimmed}`,
        },
      });
    }
  });
}

function attachProcessExit(
  child: ChildProcessWithoutNullStreams,
  context: WrappedRawEvent["context"],
  queue: AsyncQueue<WrappedRawEvent>,
  cleanup?: () => Promise<void>,
): void {
  let stderr = "";

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    debug("stderr", text);
  });

  child.on("error", (error) => {
    debug("process-error", error.message);
    queue.push({
      context,
      event: {
        type: "error",
        code: "PROCESS_ERROR",
        message: error.message,
      },
    });
    queue.close();
    void cleanup?.();
  });

  child.on("close", (code, signal) => {
    debug("process-close", { code, signal });
    if (code && code !== 0) {
      queue.push({
        context,
        event: {
          type: "error",
          code: "PROCESS_EXIT_NON_ZERO",
          message: stderr || `OpenCode exited with code ${code}${signal ? ` (signal: ${signal})` : ""}`,
        },
      });
    }
    queue.close();
    void cleanup?.();
  });
}

function resolveCommand(binaryPath?: string): string {
  if (binaryPath) {
    return binaryPath;
  }
  return process.platform === "win32" ? "opencode.cmd" : "opencode";
}

function spawnCommand(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: ["pipe", "pipe", "pipe"];
  },
): ChildProcessWithoutNullStreams {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return spawn(command, args, {
      ...options,
      shell: true,
    }) as ChildProcessWithoutNullStreams;
  }
  return spawn(command, args, options);
}

function unwrapRawEvent(rawEvent: unknown): WrappedRawEvent | null {
  if (!isRecord(rawEvent)) {
    return null;
  }
  if (!isRecord(rawEvent.context)) {
    return null;
  }
  return rawEvent as unknown as WrappedRawEvent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNestedString(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readString(value[key]);
}

function readNestedBoolean(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return readBoolean(value[key]);
}

function readNestedValue(value: unknown, key: string): unknown {
  if (!isRecord(value)) {
    return undefined;
  }
  return value[key];
}

function debug(label: string, value: unknown): void {
  if (process.env.CTX_DEBUG_OPENCODE !== "1") {
    return;
  }
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  console.error(`[opencode-adapter] ${label}: ${rendered}`);
}


