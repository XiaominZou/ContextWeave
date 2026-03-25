import type { SerializedError } from "./errors";

export interface AgentEventEnvelope<T = unknown> {
  id: string;
  workspaceId: string;
  sessionId: string;
  taskId?: string;
  runId: string;
  adapter: string;
  type: string;
  timestamp: string;
  payload: T;
  rawRef?: string;
  metadata?: Record<string, unknown>;
}

export type CoreAgentEvent =
  | { type: "run.started"; payload: { model?: string; externalRef?: string } }
  | { type: "run.completed"; payload: { reason?: string } }
  | { type: "run.failed"; payload: { error: SerializedError } }
  | { type: "run.cancelled"; payload: { reason?: string } }
  | {
      type: "run.usage";
      payload: {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      };
    }
  | { type: "message.delta"; payload: { role: "assistant"; text: string } }
  | { type: "message.completed"; payload: { messageId: string } }
  | { type: "tool.call"; payload: { callId: string; name: string; input: unknown } }
  | { type: "tool.result"; payload: { callId: string; output: unknown; isError?: boolean } }
  | { type: "artifact.created"; payload: { artifactId: string; type: string } }
  | { type: "checkpoint.created"; payload: { checkpointId: string } }
  | { type: "memory.extracted"; payload: { memoryIds: string[]; runId: string } }
  | { type: "tool.call.streaming"; payload: { callId: string; partialInput: string } };

export type CliAdapterExtensionEvent =
  | {
      type: "cli.permission.requested";
      payload: { tool: string; input: unknown; riskLevel?: "low" | "medium" | "high" };
    }
  | { type: "cli.permission.granted"; payload: { tool: string } }
  | { type: "cli.permission.denied"; payload: { tool: string; reason?: string } }
  | { type: "cli.fs.read"; payload: { path: string } }
  | { type: "cli.fs.write"; payload: { path: string; bytes?: number } }
  | { type: "cli.fs.delete"; payload: { path: string } }
  | { type: "cli.process.started"; payload: { pid?: number } }
  | { type: "cli.process.exited"; payload: { code: number; signal?: string } };

export type AgentEvent = CoreAgentEvent | CliAdapterExtensionEvent;

export function assertValidEnvelope(envelope: AgentEventEnvelope): void {
  if (!envelope.id) {
    throwInvalidEvent("id is required");
  }
  if (!envelope.workspaceId) {
    throwInvalidEvent("workspaceId is required");
  }
  if (!envelope.sessionId) {
    throwInvalidEvent("sessionId is required");
  }
  if (!envelope.runId) {
    throwInvalidEvent("runId is required");
  }
  if (!envelope.adapter) {
    throwInvalidEvent("adapter is required");
  }
  if (!envelope.type) {
    throwInvalidEvent("type is required");
  }
  if (!envelope.timestamp || Number.isNaN(Date.parse(envelope.timestamp))) {
    throwInvalidEvent("timestamp must be ISO 8601");
  }
  if (typeof envelope.payload === "undefined") {
    throwInvalidEvent("payload is required");
  }
}

function throwInvalidEvent(message: string): never {
  const error = new Error(message) as Error & { code: string };
  error.code = "INVALID_EVENT";
  throw error;
}
