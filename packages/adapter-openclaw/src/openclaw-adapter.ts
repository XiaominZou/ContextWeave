import type { AgentEventEnvelope } from "@ctx/core";
import {
  buildPlatformMemoryToolSchemas,
  buildPlatformTaskToolSchemas,
  type AdapterCapabilities,
  type AdapterPayload,
  type AdapterRunHandle,
  type AdapterRunInput,
  type AgentAdapter,
  type RenderContextInput,
  type ResumeRunInput,
  type SdkAdapterPayload,
} from "@ctx/adapter-kit";

export interface OpenClawExecutionRequest {
  run: AdapterRunInput["run"];
  payload: SdkAdapterPayload;
  policy: AdapterRunInput["policy"];
}

export interface OpenClawExecutionHandle {
  externalRef?: string;
  streamEvents(): AsyncIterable<unknown>;
  cancel(): Promise<void>;
}

export type OpenClawRawEvent = Record<string, unknown>;

export interface OpenClawAdapterOptions {
  execute?: (request: OpenClawExecutionRequest) => Promise<OpenClawExecutionHandle>;
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

export class OpenClawAdapter implements AgentAdapter {
  readonly name = "openclaw";
  readonly version = "0.1.0";
  readonly invocationMode = "sdk" as const;

  readonly capabilities: AdapterCapabilities = {
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
      tasks: "intercept",
      artifacts: "observe-only",
    },
  };

  constructor(private readonly options: OpenClawAdapterOptions = {}) {}

  async renderContext(input: RenderContextInput): Promise<AdapterPayload> {
    const snapshotText = input.policy.context === "native" ? "" : renderSnapshotToText(input.snapshot);
    const prompt = readPrompt(input.run);
    const payload: SdkAdapterPayload = {
      mode: "sdk",
      systemPrompt: snapshotText,
      messages: prompt ? [{ role: "user", content: prompt }] : [],
      tools: [
        ...(input.policy.memory === "tool-bridge" ? buildPlatformMemoryToolSchemas() : []),
        ...(input.policy.tasks === "platform-tools" ? buildPlatformTaskToolSchemas() : []),
      ],
    };
    return payload;
  }

  async createRun(input: AdapterRunInput): Promise<AdapterRunHandle> {
    if (input.payload.mode !== "sdk") {
      throw new Error("OpenClawAdapter requires sdk payload");
    }
    if (!this.options.execute) {
      throw new Error("OpenClawAdapter requires options.execute() to start a live OpenClaw run");
    }

    const queue = new AsyncQueue<WrappedRawEvent>();
    const execution = await this.options.execute({
      run: input.run,
      payload: input.payload,
      policy: input.policy,
    });

    const context = {
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      taskId: input.run.taskId,
      runId: input.run.id,
    };

    void (async () => {
      try {
        for await (const rawEvent of execution.streamEvents()) {
          queue.push({ context, event: rawEvent });
        }
      } catch (error) {
        queue.push({
          context,
          event: {
            type: "error",
            code: "OPENCLAW_STREAM_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        queue.close();
      }
    })();

    return {
      externalRef: execution.externalRef,
      streamEvents() {
        return queue.stream();
      },
      cancel: async () => {
        await execution.cancel();
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

    const type = readString(event.type) ?? readString(event.event);
    switch (type) {
      case "run.started":
      case "run_started":
      case "response.started":
      case "response.start":
        return {
          ...base,
          type: "run.started",
          payload: {
            model: readString(event.model),
            externalRef: readString(event.runId) ?? readString(event.sessionId) ?? readString(event.responseId),
          },
        };
      case "message.delta":
      case "text_delta":
      case "response.output_text.delta":
      case "content_block_delta":
        if (readNestedString(event.delta, "partial_json")) {
          return {
            ...base,
            type: "tool.call.streaming",
            payload: {
              callId: readString(event.callId) ?? readNestedString(event.delta, "id") ?? "call_unknown",
              partialInput: readNestedString(event.delta, "partial_json") ?? "",
            },
          };
        }
        return {
          ...base,
          type: "message.delta",
          payload: {
            role: "assistant",
            text:
              readString(event.text) ??
              readString(event.delta) ??
              readNestedString(event.delta, "text") ??
              readNestedString(event.content, "text") ??
              "",
          },
        };
      case "message.completed":
      case "message_completed":
      case "response.completed_text":
        return {
          ...base,
          type: "message.completed",
          payload: {
            messageId: readString(event.messageId) ?? readString(event.id) ?? "msg_unknown",
          },
        };
      case "tool.call":
      case "tool_call":
      case "tool_use":
      case "response.tool_call":
      case "content_block_start":
        if (readNestedString(event.content_block, "type") === "tool_use" || type !== "content_block_start") {
          return {
            ...base,
            type: "tool.call",
            payload: {
              callId:
                readString(event.callId) ??
                readString(event.id) ??
                readNestedString(event.content_block, "id") ??
                "call_unknown",
              name:
                readString(event.name) ??
                readNestedString(event.content_block, "name") ??
                "unknown_tool",
              input:
                event.input ??
                readNestedValue(event.content_block, "input") ??
                {},
            },
          };
        }
        return null;
      case "tool.result":
      case "tool_result":
      case "response.tool_result":
        return {
          ...base,
          type: "tool.result",
          payload: {
            callId: readString(event.callId) ?? readString(event.toolCallId) ?? "call_unknown",
            output: event.output ?? event.content ?? null,
            isError: readBoolean(event.isError) ?? false,
          },
        };
      case "run.completed":
      case "run_completed":
      case "response.completed":
        return {
          ...base,
          type: "run.completed",
          payload: {
            reason: readString(event.reason) ?? readString(event.stopReason),
          },
        };
      case "run.cancelled":
      case "run_cancelled":
        return {
          ...base,
          type: "run.cancelled",
          payload: {
            reason: readString(event.reason),
          },
        };
      case "run.usage":
      case "usage":
        return {
          ...base,
          type: "run.usage",
          payload: {
            inputTokens:
              readNumber(event.inputTokens) ??
              readNumber(event.input_tokens) ??
              readNestedNumber(event.usage, "input_tokens"),
            outputTokens:
              readNumber(event.outputTokens) ??
              readNumber(event.output_tokens) ??
              readNestedNumber(event.usage, "output_tokens"),
          },
        };
      case "error":
      case "run.failed":
      case "run_failed":
        return {
          ...base,
          type: "run.failed",
          payload: {
            error: {
              code: readString(event.code) ?? readString(event.errorType) ?? "OPENCLAW_ERROR",
              message: readString(event.message) ?? readNestedString(event.error, "message") ?? "OpenClaw error",
            },
          },
        };
      default:
        return null;
    }
  }

  resumeRun(_input: ResumeRunInput): Promise<AdapterRunHandle> {
    throw new Error("OpenClawAdapter does not support resume in V1");
  }
}

function readPrompt(run: AdapterRunInput["run"]): string | undefined {
  if (typeof run.metadata?.["prompt"] === "string" && run.metadata["prompt"].trim()) {
    return String(run.metadata["prompt"]);
  }
  return undefined;
}

function renderSnapshotToText(snapshot: RenderContextInput["snapshot"]): string {
  if (!snapshot) {
    return "";
  }
  return snapshot.blocks.map((block) => block.content).join("\n");
}

function unwrapRawEvent(rawEvent: unknown): WrappedRawEvent | null {
  if (!isRecord(rawEvent) || !isRecord(rawEvent.context)) {
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

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
