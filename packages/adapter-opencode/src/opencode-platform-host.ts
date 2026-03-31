import type { CliAdapterPayload } from "@ctx/adapter-kit";
import type {
  FinalizeTransparentRunInput,
  PrepareTransparentRunInput,
  PreparedTransparentRun,
  ResumeTransparentRunInput,
  TransparentRuntimeBridgeAPI,
} from "@ctx/client";
import type { AgentEventEnvelope, CapabilityPolicy, Checkpoint } from "@ctx/core";
import {
  createOpenCodeHostRun,
  normalizeOpenCodeHostEvent,
  OPENCODE_HOST_RUNTIME_NAME,
  OPENCODE_HOST_RUNTIME_VERSION,
  type OpenCodeHostAdapterOptions,
} from "./opencode-host-adapter";

export interface OpenCodePlatformHostRunInput {
  bridge: TransparentRuntimeBridgeAPI;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  capabilityPolicy?: Partial<CapabilityPolicy>;
  model?: string;
  metadata?: Record<string, unknown>;
  runtimeName?: string;
}

export interface OpenCodePlatformHostResumeInput {
  bridge: TransparentRuntimeBridgeAPI;
  checkpointId: string;
  capabilityPolicy?: Partial<CapabilityPolicy>;
  model?: string;
  metadata?: Record<string, unknown>;
  runtimeName?: string;
}

export interface OpenCodePlatformHostHandle {
  runId: string;
  streamEvents(): AsyncIterable<AgentEventEnvelope>;
  interrupt(): Promise<void>;
  cancel(): Promise<void>;
  checkpoint(): Promise<Checkpoint>;
}

class AsyncQueue<T> {
  private readonly values: T[] = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
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

export class OpenCodePlatformHost {
  constructor(private readonly options: OpenCodeHostAdapterOptions = {}) {}

  async startRun(input: OpenCodePlatformHostRunInput): Promise<OpenCodePlatformHostHandle> {
    const prepared = await input.bridge.prepareRun(this.buildPrepareInput(input));
    return await this.startPreparedRun(input.bridge, prepared);
  }

  async resumeRun(input: OpenCodePlatformHostResumeInput): Promise<OpenCodePlatformHostHandle> {
    const prepared = await input.bridge.prepareResumeRun(this.buildResumeInput(input));
    return await this.startPreparedRun(input.bridge, prepared);
  }

  private async startPreparedRun(
    bridge: TransparentRuntimeBridgeAPI,
    prepared: PreparedTransparentRun,
  ): Promise<OpenCodePlatformHostHandle> {
    const queue = new AsyncQueue<AgentEventEnvelope>();
    const payload: CliAdapterPayload = {
      mode: "cli-process",
      argv: [],
      env: { ...this.options.env },
      configFileInjection: prepared.prompt.systemPrompt || undefined,
      mcpServers: [
        ...(prepared.toolBridge?.memoryMcpServers ?? []),
        ...(prepared.toolBridge?.taskMcpServers ?? []),
      ],
    };
    const rawHandle = await createOpenCodeHostRun(this.options, {
      run: prepared.run,
      payload,
      policy: prepared.policy,
    });

    let finalizing = false;
    let terminalStatus: FinalizeTransparentRunInput["status"] | undefined;
    let terminalReason: string | undefined;

    const finalizeOnce = async (finalizeInput?: FinalizeTransparentRunInput) => {
      if (finalizing) {
        return;
      }
      finalizing = true;
      try {
        await bridge.finalizeRun(finalizeInput ?? {
          runId: prepared.run.id,
          status: terminalStatus ?? "failed",
          reason: terminalReason ?? (terminalStatus ? undefined : "OpenCode host stream ended without terminal event"),
        });
      } finally {
        queue.close();
      }
    };

    void (async () => {
      try {
        for await (const rawEvent of rawHandle.streamEvents()) {
          const result = await bridge.ingestEvent({
            runId: prepared.run.id,
            rawEvent,
            normalizeEvent: normalizeOpenCodeHostEvent,
          });
          for (const event of result.events) {
            queue.push(event);
            const status = readTerminalStatus(event);
            if (status) {
              terminalStatus = status.status;
              terminalReason = status.reason;
            }
          }
        }

        await finalizeOnce();
      } catch (error) {
        await finalizeOnce({
          runId: prepared.run.id,
          status: "failed",
          error: {
            code: "OPENCODE_PLATFORM_HOST_ERROR",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    })();

    return {
      runId: prepared.run.id,
      streamEvents() {
        return queue.stream();
      },
      interrupt: async () => {
        await rawHandle.cancel();
        terminalStatus = "cancelled";
        terminalReason = "cancelled by host";
        await finalizeOnce({
          runId: prepared.run.id,
          status: "cancelled",
          reason: terminalReason,
        });
      },
      cancel: async () => {
        await rawHandle.cancel();
        terminalStatus = "cancelled";
        terminalReason = "cancelled by host";
        await finalizeOnce({
          runId: prepared.run.id,
          status: "cancelled",
          reason: terminalReason,
        });
      },
      checkpoint: async () => {
        const result = await bridge.createCheckpoint({
          runId: prepared.run.id,
          adapterVersion: OPENCODE_HOST_RUNTIME_VERSION,
        });
        queue.push(result.event);
        return result.checkpoint;
      },
    };
  }

  private buildPrepareInput(input: OpenCodePlatformHostRunInput): PrepareTransparentRunInput {
    return {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runtime: input.runtimeName ?? OPENCODE_HOST_RUNTIME_NAME,
      capabilityPolicy: input.capabilityPolicy,
      model: input.model,
      metadata: input.metadata,
    };
  }

  private buildResumeInput(input: OpenCodePlatformHostResumeInput): ResumeTransparentRunInput {
    return {
      checkpointId: input.checkpointId,
      runtime: input.runtimeName ?? OPENCODE_HOST_RUNTIME_NAME,
      capabilityPolicy: input.capabilityPolicy,
      model: input.model,
      metadata: input.metadata,
    };
  }
}

function readTerminalStatus(event: AgentEventEnvelope): { status: FinalizeTransparentRunInput["status"]; reason?: string } | null {
  if (event.type === "run.completed") {
    const payload = event.payload as { reason?: string };
    return { status: "completed", reason: payload.reason };
  }
  if (event.type === "run.failed") {
    const payload = event.payload as { error?: { message?: string } };
    return { status: "failed", reason: payload.error?.message };
  }
  if (event.type === "run.cancelled") {
    const payload = event.payload as { reason?: string };
    return { status: "cancelled", reason: payload.reason };
  }
  return null;
}
