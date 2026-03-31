import type { AgentEventEnvelope, SerializedError } from "@ctx/core";
import type { OpenClawAgentMessage, OpenClawContextEngineAfterTurnParams } from "./openclaw-context-engine";

export interface OpenClawTurnRunContext {
  workspaceId: string;
  sessionId: string;
  taskId: string;
  runId: string;
}

export interface OpenClawTurnNormalizationResult {
  newMessages: OpenClawAgentMessage[];
  events: AgentEventEnvelope[];
  finalize: {
    status: "completed" | "failed" | "cancelled";
    reason?: string;
    error?: SerializedError;
  };
}

export interface NormalizeOpenClawTurnOptions {
  run: OpenClawTurnRunContext;
  turn: Pick<
    OpenClawContextEngineAfterTurnParams,
    | "messages"
    | "prePromptMessageCount"
    | "autoCompactionSummary"
    | "model"
    | "runtimeContext"
    | "usage"
    | "status"
    | "error"
    | "cancelled"
    | "isHeartbeat"
    | "sessionId"
    | "sessionKey"
  >;
  adapter?: string;
  createEventId?: () => string;
  now?: () => string;
}

export function sliceOpenClawTurnMessages(input: {
  messages: OpenClawAgentMessage[];
  prePromptMessageCount?: number;
}): OpenClawAgentMessage[] {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const prePromptMessageCount = Number.isFinite(input.prePromptMessageCount)
    ? Math.max(0, Math.trunc(input.prePromptMessageCount ?? 0))
    : 0;
  return messages.slice(Math.min(prePromptMessageCount, messages.length));
}

export function normalizeOpenClawAfterTurn(input: NormalizeOpenClawTurnOptions): OpenClawTurnNormalizationResult {
  const newMessages = sliceOpenClawTurnMessages(input.turn);
  const createEventId = input.createEventId ?? createDefaultEventId;
  const now = input.now ?? (() => new Date().toISOString());
  const adapter = input.adapter ?? "openclaw";
  const sessionRef = readSessionRef(input.turn);
  const events: AgentEventEnvelope[] = [];
  let assistantMessageIndex = 0;
  let toolIndex = 0;

  const pushEvent = (type: string, payload: unknown) => {
    events.push({
      id: createEventId(),
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      taskId: input.run.taskId,
      runId: input.run.runId,
      adapter,
      timestamp: now(),
      type,
      payload,
    });
  };

  pushEvent("run.started", {
    model: typeof input.turn.model === "string" ? input.turn.model : undefined,
    externalRef: sessionRef,
  });

  const usage = normalizeUsage(
    input.turn.usage
      ?? readUsageCandidate(input.turn.runtimeContext, "usage")
      ?? readUsageCandidate(input.turn.runtimeContext, "tokenUsage")
      ?? readUsageCandidate(input.turn.runtimeContext, "usageStats"),
  ) ?? readUsageFromMessages(newMessages);
  if (usage) {
    pushEvent("run.usage", usage);
  }

  for (const message of newMessages) {
    if (!isRecord(message)) {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : "";

    if (role === "assistant") {
      for (const part of normalizeOpenClawContentParts(message.content)) {
        if (part.kind === "text" && part.text) {
          pushEvent("message.delta", { role: "assistant", text: part.text });
          continue;
        }
        if (part.kind === "toolCall") {
          toolIndex += 1;
          pushEvent("tool.call", {
            callId: part.callId || `tool_call_${toolIndex}`,
            name: part.name || `tool_${toolIndex}`,
            input: isRecord(part.input) ? part.input : {},
          });
        }
      }
      pushEvent("message.completed", {
        messageId: typeof message.id === "string" && message.id.trim()
          ? message.id.trim()
          : `openclaw_msg_${++assistantMessageIndex}`,
      });
      continue;
    }

    if (role === "tool") {
      toolIndex += 1;
      const toolName = typeof message.name === "string" && message.name.trim()
        ? message.name.trim()
        : `tool_${toolIndex}`;
      const callId = typeof message.toolCallId === "string" && message.toolCallId.trim()
        ? message.toolCallId.trim()
        : `tool_call_${toolIndex}`;
      pushEvent("tool.call", {
        callId,
        name: toolName,
        input: isRecord(message.input) ? message.input : {},
      });
      pushEvent("tool.result", {
        callId,
        output: message.content ?? null,
        isError: Boolean(message.isError),
      });
      continue;
    }

    if (role === "toolResult") {
      toolIndex += 1;
      pushEvent("tool.result", {
        callId: readToolResultCallId(message) ?? `tool_call_${toolIndex}`,
        output: readToolResultOutput(message),
        isError: Boolean(message.isError),
      });
    }
  }

  return {
    newMessages,
    events,
    finalize: resolveFinalization(input.turn),
  };
}

export function stringifyOpenClawContent(content: unknown): string {
  return normalizeOpenClawContentParts(content)
    .filter((part) => part.kind === "text")
    .map((part) => part.text)
    .filter((text) => typeof text === "string" && text.trim())
    .join("\n");
}

function resolveFinalization(
  turn: NormalizeOpenClawTurnOptions["turn"],
): OpenClawTurnNormalizationResult["finalize"] {
  if (isCancelledTurn(turn)) {
    return {
      status: "cancelled",
      reason: readReason(turn) ?? "openclaw turn cancelled",
    };
  }

  const error = normalizeError(turn.error ?? readRuntimeContextValue(turn.runtimeContext, "error"));
  if (error || isFailedTurn(turn)) {
    return {
      status: "failed",
      reason: error?.message,
      error: error ?? {
        code: "OPENCLAW_TURN_FAILED",
        message: "OpenClaw turn failed",
      },
    };
  }

  return {
    status: "completed",
    reason: typeof turn.autoCompactionSummary === "string" && turn.autoCompactionSummary.trim()
      ? "turn_complete_with_compaction"
      : turn.isHeartbeat
        ? "heartbeat"
        : "turn_complete",
  };
}

function normalizeUsage(value: unknown):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    }
  | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const usage = {
    inputTokens: readNumber(value, "inputTokens", "input_tokens", "input"),
    outputTokens: readNumber(value, "outputTokens", "output_tokens", "output"),
    cacheReadInputTokens: readNumber(value, "cacheReadInputTokens", "cache_read_input_tokens", "cacheRead"),
    cacheWriteInputTokens: readNumber(value, "cacheWriteInputTokens", "cache_write_input_tokens", "cacheWrite"),
  };

  return Object.values(usage).some((item) => typeof item === "number") ? usage : undefined;
}

function readUsageFromMessages(messages: OpenClawAgentMessage[]):
  | {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    }
  | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message)) {
      continue;
    }
    const usage = normalizeUsage(message.usage);
    if (usage) {
      return usage;
    }
  }
  return undefined;
}

function normalizeOpenClawContentParts(content: unknown): Array<
  | { kind: "text"; text: string }
  | { kind: "toolCall"; callId?: string; name?: string; input?: unknown }
> {
  if (typeof content === "string") {
    return [{ kind: "text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.flatMap((part) => normalizeOpenClawContentParts(part));
  }
  if (!isRecord(content)) {
    return [];
  }

  const type = typeof content.type === "string" ? content.type : undefined;
  if (type === "toolCall") {
    return [{
      kind: "toolCall",
      callId: readFirstString(content, "id", "toolCallId", "callId"),
      name: readFirstString(content, "name", "toolName"),
      input: isRecord(content.arguments) ? content.arguments : content.input,
    }];
  }

  const text = typeof content.text === "string"
    ? content.text
    : typeof content.content === "string"
      ? content.content
      : undefined;
  return text ? [{ kind: "text", text }] : [];
}

function readToolResultCallId(message: Record<string, unknown>): string | undefined {
  return readFirstString(message, "toolCallId", "callId", "id");
}

function readToolResultOutput(message: Record<string, unknown>): unknown {
  if (message.details !== undefined) {
    return message.details;
  }
  return message.content ?? null;
}

function normalizeError(value: unknown): SerializedError | undefined {
  if (typeof value === "string" && value.trim()) {
    return {
      code: "OPENCLAW_TURN_ERROR",
      message: value.trim(),
    };
  }
  if (!isRecord(value)) {
    return undefined;
  }

  const message = typeof value.message === "string" && value.message.trim()
    ? value.message.trim()
    : typeof value.error === "string" && value.error.trim()
      ? value.error.trim()
      : undefined;
  if (!message) {
    return undefined;
  }

  return {
    code: typeof value.code === "string" && value.code.trim() ? value.code.trim() : "OPENCLAW_TURN_ERROR",
    message,
    details: value,
  };
}

function isCancelledTurn(turn: NormalizeOpenClawTurnOptions["turn"]): boolean {
  if (turn.cancelled === true) {
    return true;
  }
  const status = readStatus(turn);
  return status === "cancelled" || status === "canceled" || status === "aborted" || status === "interrupted";
}

function isFailedTurn(turn: NormalizeOpenClawTurnOptions["turn"]): boolean {
  const status = readStatus(turn);
  return status === "failed" || status === "error";
}

function readStatus(turn: NormalizeOpenClawTurnOptions["turn"]): string | undefined {
  if (typeof turn.status === "string" && turn.status.trim()) {
    return turn.status.trim().toLowerCase();
  }
  const runtimeStatus = readRuntimeContextValue(turn.runtimeContext, "status");
  return typeof runtimeStatus === "string" && runtimeStatus.trim()
    ? runtimeStatus.trim().toLowerCase()
    : undefined;
}

function readReason(turn: NormalizeOpenClawTurnOptions["turn"]): string | undefined {
  const runtimeReason = readRuntimeContextValue(turn.runtimeContext, "reason");
  if (typeof runtimeReason === "string" && runtimeReason.trim()) {
    return runtimeReason.trim();
  }
  return undefined;
}

function readSessionRef(turn: NormalizeOpenClawTurnOptions["turn"]): string | undefined {
  if (typeof turn.sessionKey === "string" && turn.sessionKey.trim()) {
    return turn.sessionKey.trim();
  }
  if (typeof turn.sessionId === "string" && turn.sessionId.trim()) {
    return turn.sessionId.trim();
  }
  return undefined;
}

function readUsageCandidate(runtimeContext: Record<string, unknown> | undefined, key: string): unknown {
  if (!isRecord(runtimeContext)) {
    return undefined;
  }
  return runtimeContext[key];
}

function readRuntimeContextValue(runtimeContext: Record<string, unknown> | undefined, key: string): unknown {
  if (!isRecord(runtimeContext)) {
    return undefined;
  }
  return runtimeContext[key];
}

function readNumber(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function readFirstString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function createDefaultEventId(): string {
  return `evt_${Math.random().toString(36).slice(2, 10)}`;
}
