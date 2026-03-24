import type { AgentEventEnvelope, Run } from "@ctx/core";
import { extractArtifactIds } from "./artifact-records";

export const RUN_SUMMARY_METADATA_KEY = "platformRunSummary";
export const TOOL_CALL_REFS_METADATA_KEY = "platformToolCallRefs";

export interface RunSummaryV1 {
  version: "1";
  generatedAt: string;
  status: Run["status"];
  completionReason?: string;
  messageCount: number;
  toolCallCount: number;
  indexedToolCallCount: number;
  assistantOutputPreview?: string;
  errorCode?: string;
  errorMessage?: string;
  summaryText: string;
}

export interface ToolCallRefV1 {
  version: "1";
  callId: string;
  toolName: string;
  inputSignature: string;
  isError: boolean;
  hasArtifact: boolean;
  artifactIds: string[];
  resultPreview?: string;
  summaryText: string;
  callEventId: string;
  resultEventId?: string;
}

export interface RunDerivedContextV1 {
  runSummary: RunSummaryV1;
  toolCallRefs: ToolCallRefV1[];
}

export function buildRunDerivedContext(input: {
  run: Run;
  events: AgentEventEnvelope[];
}): RunDerivedContextV1 {
  const toolCalls = new Map<string, AgentEventEnvelope<{ callId: string; name: string; input: unknown }>>();
  const toolResults = new Map<string, AgentEventEnvelope<{ callId: string; output: unknown; isError?: boolean }>>();
  const assistantChunks: string[] = [];
  let completionReason: string | undefined;

  for (const event of input.events) {
    if (event.type === "tool.call") {
      toolCalls.set(readString(event.payload, "callId") ?? event.id, event as AgentEventEnvelope<{ callId: string; name: string; input: unknown }>);
      continue;
    }

    if (event.type === "tool.result") {
      const callId = readString(event.payload, "callId");
      if (callId) {
        toolResults.set(callId, event as AgentEventEnvelope<{ callId: string; output: unknown; isError?: boolean }>);
      }
      continue;
    }

    if (event.type === "message.delta") {
      const text = readString(event.payload, "text");
      if (text) {
        assistantChunks.push(text);
      }
      continue;
    }

    if (event.type === "run.completed" || event.type === "run.cancelled") {
      completionReason = readString(event.payload, "reason") ?? completionReason;
      continue;
    }

    if (event.type === "run.failed") {
      const error = readObject(event.payload, "error");
      completionReason = readString(error, "message") ?? completionReason;
    }
  }

  const toolCallRefs = [...toolCalls.values()]
    .map((callEvent) => buildToolCallRef(callEvent, toolResults.get(readString(callEvent.payload, "callId") ?? "")))
    .filter((value): value is ToolCallRefV1 => Boolean(value));

  const assistantOutputPreview = truncate(joinAssistantOutput(assistantChunks), 240);
  return {
    runSummary: {
      version: "1",
      generatedAt: new Date().toISOString(),
      status: input.run.status,
      completionReason,
      messageCount: input.events.filter((event) => event.type === "message.delta").length,
      toolCallCount: toolCalls.size,
      indexedToolCallCount: toolCallRefs.length,
      assistantOutputPreview: assistantOutputPreview || undefined,
      errorCode: input.run.error?.code,
      errorMessage: input.run.error?.message,
      summaryText: buildRunSummaryText({
        run: input.run,
        completionReason,
        assistantOutputPreview: assistantOutputPreview || undefined,
        toolCallCount: toolCalls.size,
        indexedToolCallCount: toolCallRefs.length,
      }),
    },
    toolCallRefs,
  };
}

function buildToolCallRef(
  callEvent: AgentEventEnvelope<{ callId: string; name: string; input: unknown }>,
  resultEvent?: AgentEventEnvelope<{ callId: string; output: unknown; isError?: boolean }>,
): ToolCallRefV1 | null {
  const callId = readString(callEvent.payload, "callId") ?? callEvent.id;
  const toolName = readString(callEvent.payload, "name") ?? "unknown_tool";
  const inputValue = readValue(callEvent.payload, "input");
  const outputValue = resultEvent ? readValue(resultEvent.payload, "output") : undefined;
  const artifactIds = extractArtifactIds(outputValue);
  const isError = resultEvent ? readBoolean(resultEvent.payload, "isError") ?? false : false;
  const hasArtifact = artifactIds.length > 0;

  if (!isError && !hasArtifact) {
    return null;
  }

  const resultPreview = truncate(renderPreview(outputValue), 160);
  return {
    version: "1",
    callId,
    toolName,
    inputSignature: buildInputSignature(toolName, inputValue),
    isError,
    hasArtifact,
    artifactIds,
    resultPreview: resultPreview || undefined,
    summaryText: buildToolCallSummaryText({ toolName, isError, artifactIds, resultPreview: resultPreview || undefined }),
    callEventId: callEvent.id,
    resultEventId: resultEvent?.id,
  };
}

function buildRunSummaryText(input: {
  run: Run;
  completionReason?: string;
  assistantOutputPreview?: string;
  toolCallCount: number;
  indexedToolCallCount: number;
}): string {
  const fragments = [
    `Run ${input.run.id} ${input.run.status}`,
    input.completionReason ? `reason: ${input.completionReason}` : undefined,
    `tool calls: ${input.toolCallCount}`,
    `indexed tool refs: ${input.indexedToolCallCount}`,
    input.assistantOutputPreview ? `assistant output: ${input.assistantOutputPreview}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return fragments.join("; ");
}

function buildToolCallSummaryText(input: {
  toolName: string;
  isError: boolean;
  artifactIds: string[];
  resultPreview?: string;
}): string {
  const fragments = [
    input.toolName,
    input.isError ? "resulted in an error" : undefined,
    input.artifactIds.length > 0 ? `produced artifacts: ${input.artifactIds.join(", ")}` : undefined,
    input.resultPreview ? `preview: ${input.resultPreview}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return fragments.join("; ");
}

function buildInputSignature(toolName: string, input: unknown): string {
  const serialized = stableSerialize(input);
  return `${toolName}:${truncate(serialized, 100)}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`).join(",")}}`;
}

function joinAssistantOutput(chunks: string[]): string {
  return chunks.join("").replace(/\s+/g, " ").trim();
}

function renderPreview(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\s+/g, " ").trim();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null || typeof value === "undefined") {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function truncate(value: string, maxLength: number): string {
  if (!value) {
    return value;
  }
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "boolean" ? nested : undefined;
}

function readValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

function readObject(value: unknown, key: string): Record<string, unknown> | undefined {
  const nested = readValue(value, key);
  return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
}
