import type { AgentEventEnvelope, Checkpoint, SerializedError } from "@ctx/core";
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
} from "@ctx/adapter-kit";

export type MockRawEvent =
  | { type: "run_started"; model?: string; externalRef?: string }
  | { type: "run_usage"; inputTokens?: number; outputTokens?: number }
  | { type: "text_delta"; text: string }
  | { type: "message_completed"; messageId: string }
  | { type: "tool_call"; callId: string; name: string; input: unknown }
  | { type: "tool_result"; callId: string; output: unknown; isError?: boolean }
  | { type: "run_completed"; reason?: string }
  | { type: "run_failed"; error: SerializedError }
  | { type: "run_cancelled"; reason?: string };

export class RawMockAdapter implements AgentAdapter {
  readonly name = "mock";
  readonly version = "0.1.0";
  readonly invocationMode = "sdk" as const;

  readonly capabilities: AdapterCapabilities;
  lastRenderedPayload?: AdapterPayload;

  private runContext?: {
    workspaceId: string;
    sessionId: string;
    taskId: string;
    runId: string;
  };

  constructor(
    private readonly config: {
      rawEvents: MockRawEvent[];
      externalRef?: string;
      capabilitySupport?: Partial<AdapterCapabilities["capabilitySupport"]>;
      delayMs?: number;
      throwAfterEventCount?: number;
      streamErrorMessage?: string;
      checkpointPayload?: unknown;
      resumeRawEvents?: MockRawEvent[];
    },
  ) {
    this.capabilities = {
      invocationMode: "sdk",
      streaming: true,
      toolCalls: true,
      checkpoints: Boolean(config.checkpointPayload ?? config.resumeRawEvents),
      resume: Boolean(config.resumeRawEvents),
      interrupt: true,
      nativeMcp: false,
      capabilitySupport: {
        context: "intercept",
        memory: "intercept",
        tasks: "intercept",
        artifacts: "intercept",
        ...config.capabilitySupport,
      },
    };
  }

  async renderContext(input: RenderContextInput): Promise<AdapterPayload> {
    const payload: AdapterPayload = {
      mode: "sdk",
      systemPrompt: input.snapshot ? renderSnapshotToText(input.snapshot) : "",
      messages: [],
      tools: [
        ...(input.policy.memory === "tool-bridge" ? buildPlatformMemoryToolSchemas() : []),
        ...(input.policy.tasks === "platform-tools" ? buildPlatformTaskToolSchemas() : []),
      ],
    };
    this.lastRenderedPayload = payload;
    return payload;
  }

  async createRun(input: AdapterRunInput): Promise<AdapterRunHandle> {
    return this.createHandle(input.run, this.config.rawEvents);
  }

  async resumeRun(input: ResumeRunInput): Promise<AdapterRunHandle> {
    if (!this.capabilities.resume) {
      throw new Error("RawMockAdapter resume is not configured");
    }
    return this.createHandle(input.run, this.config.resumeRawEvents ?? this.config.rawEvents);
  }

  async createCheckpoint(runId: string): Promise<Checkpoint> {
    if (!this.capabilities.checkpoints) {
      throw new Error("RawMockAdapter checkpoints are not configured");
    }
    if (!this.runContext) {
      throw new Error("RawMockAdapter.createCheckpoint() called before createRun()");
    }
    return {
      id: `ckpt_${Math.random().toString(36).slice(2, 10)}`,
      workspaceId: this.runContext.workspaceId,
      sessionId: this.runContext.sessionId,
      taskId: this.runContext.taskId,
      runId,
      adapter: this.name,
      payload: {
        version: "1",
        adapter: this.name,
        createdAt: new Date().toISOString(),
        payload: this.config.checkpointPayload ?? { resumeFromRunId: runId },
      },
      createdAt: new Date().toISOString(),
    };
  }

  normalizeEvent(rawEvent: unknown): AgentEventEnvelope | null {
    if (!this.runContext) {
      throw new Error("RawMockAdapter.normalizeEvent() called before createRun()");
    }

    const raw = rawEvent as MockRawEvent;
    const base = {
      id: `evt_${Math.random().toString(36).slice(2, 10)}`,
      workspaceId: this.runContext.workspaceId,
      sessionId: this.runContext.sessionId,
      taskId: this.runContext.taskId,
      runId: this.runContext.runId,
      adapter: this.name,
      timestamp: new Date().toISOString(),
    };

    switch (raw.type) {
      case "run_started":
        return { ...base, type: "run.started", payload: { model: raw.model, externalRef: raw.externalRef ?? this.config.externalRef } };
      case "run_usage":
        return {
          ...base,
          type: "run.usage",
          payload: {
            inputTokens: raw.inputTokens,
            outputTokens: raw.outputTokens,
          },
        };
      case "text_delta":
        return { ...base, type: "message.delta", payload: { role: "assistant", text: raw.text } };
      case "message_completed":
        return { ...base, type: "message.completed", payload: { messageId: raw.messageId } };
      case "tool_call":
        return { ...base, type: "tool.call", payload: { callId: raw.callId, name: raw.name, input: raw.input } };
      case "tool_result":
        return { ...base, type: "tool.result", payload: { callId: raw.callId, output: raw.output, isError: raw.isError } };
      case "run_completed":
        return { ...base, type: "run.completed", payload: { reason: raw.reason } };
      case "run_failed":
        return { ...base, type: "run.failed", payload: { error: raw.error } };
      case "run_cancelled":
        return { ...base, type: "run.cancelled", payload: { reason: raw.reason } };
      default:
        return null;
    }
  }

  private async createHandle(run: AdapterRunInput["run"] | ResumeRunInput["run"], rawEvents: MockRawEvent[]): Promise<AdapterRunHandle> {
    this.runContext = {
      workspaceId: run.workspaceId,
      sessionId: run.sessionId,
      taskId: run.taskId,
      runId: run.id,
    };

    const delayMs = this.config.delayMs ?? 0;
    const throwAfterEventCount = this.config.throwAfterEventCount;
    const streamErrorMessage = this.config.streamErrorMessage ?? "mock stream failure";
    let cancelled = false;

    return {
      externalRef: this.config.externalRef ?? "mock-ext-ref-123",
      streamEvents: async function* () {
        let emittedCount = 0;
        for (const rawEvent of rawEvents) {
          if (cancelled) {
            break;
          }
          if (delayMs > 0) {
            await sleep(delayMs);
          }
          if (cancelled) {
            break;
          }
          yield rawEvent;
          emittedCount += 1;
          if (typeof throwAfterEventCount === "number" && emittedCount === throwAfterEventCount) {
            throw new Error(streamErrorMessage);
          }
        }
      },
      cancel: async () => {
        cancelled = true;
      },
    };
  }
}

function renderSnapshotToText(snapshot: NonNullable<RenderContextInput["snapshot"]>): string {
  return snapshot.blocks.map((block) => block.content).join("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
