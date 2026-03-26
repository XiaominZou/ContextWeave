import { normalizeContextFilePath, type AgentEventEnvelope, type Run } from "@ctx/core";
import { extractArtifactIds } from "./artifact-records";

export const RUN_SUMMARY_METADATA_KEY = "platformRunSummary";
export const TOOL_CALL_REFS_METADATA_KEY = "platformToolCallRefs";

export interface RepairStateV1 {
  version: "1";
  failingTests: string[];
  lastTestCommand?: string;
  unresolvedConstraints: string[];
}

export interface RunSummaryV1 {
  version: "1";
  generatedAt: string;
  status: Run["status"];
  completionReason?: string;
  messageCount: number;
  toolCallCount: number;
  indexedToolCallCount: number;
  readFilePaths: string[];
  editedFilePaths: string[];
  commandPreviews: string[];
  repairState?: RepairStateV1;
  failureHints: string[];
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
  const readFilePaths = collectReadFilePaths(toolCalls, toolResults);
  const editedFilePaths = collectEditedFilePaths(toolCalls, toolResults);
  const commandPreviews = collectCommandPreviews(toolCalls);
  const repairStateMatch = collectRepairState(toolCalls, toolResults);
  const failureHints = collectFailureHints(toolCalls, toolResults, repairStateMatch?.sourceCallId);

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
      readFilePaths,
      editedFilePaths,
      commandPreviews,
      repairState: repairStateMatch?.repairState,
      failureHints,
      assistantOutputPreview: assistantOutputPreview || undefined,
      errorCode: input.run.error?.code,
      errorMessage: input.run.error?.message,
      summaryText: buildRunSummaryText({
        run: input.run,
        completionReason,
        assistantOutputPreview: assistantOutputPreview || undefined,
        toolCallCount: toolCalls.size,
        indexedToolCallCount: toolCallRefs.length,
        readFilePaths,
        editedFilePaths,
        commandPreviews,
        repairState: repairStateMatch?.repairState,
        failureHints,
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
  readFilePaths: string[];
  editedFilePaths: string[];
  commandPreviews: string[];
  repairState?: RepairStateV1;
  failureHints: string[];
}): string {
  const fragments = [
    `Run ${input.run.id} ${input.run.status}`,
    input.completionReason ? `reason: ${input.completionReason}` : undefined,
    `tool calls: ${input.toolCallCount}`,
    `indexed tool refs: ${input.indexedToolCallCount}`,
    input.readFilePaths.length > 0 ? `read files: ${input.readFilePaths.join(", ")}` : undefined,
    input.editedFilePaths.length > 0 ? `edited files: ${input.editedFilePaths.join(", ")}` : undefined,
    input.commandPreviews.length > 0 ? `commands: ${input.commandPreviews.join(" | ")}` : undefined,
    input.repairState?.failingTests.length ? `failing tests: ${input.repairState.failingTests.join(", ")}` : undefined,
    input.repairState?.lastTestCommand ? `last failing command: ${input.repairState.lastTestCommand}` : undefined,
    input.repairState?.unresolvedConstraints.length
      ? `unresolved constraints: ${input.repairState.unresolvedConstraints.join(" | ")}`
      : undefined,
    input.failureHints.length > 0 ? `known failures: ${input.failureHints.join(" | ")}` : undefined,
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

function collectReadFilePaths(
  toolCalls: Map<string, AgentEventEnvelope<{ callId: string; name: string; input: unknown }>>,
  toolResults: Map<string, AgentEventEnvelope<{ callId: string; output: unknown; isError?: boolean }>>,
): string[] {
  const paths = new Set<string>();

  for (const callEvent of toolCalls.values()) {
    const callId = readString(callEvent.payload, "callId") ?? callEvent.id;
    if (readString(callEvent.payload, "name") !== "read") {
      continue;
    }

    const resultEvent = toolResults.get(callId);
    if (resultEvent && readBoolean(resultEvent.payload, "isError")) {
      continue;
    }

    const filePath = readReadFilePath(readValue(callEvent.payload, "input"));
    if (!filePath) {
      continue;
    }

    paths.add(normalizeContextFilePath(filePath));
  }

  return [...paths];
}

function collectEditedFilePaths(
  toolCalls: Map<string, AgentEventEnvelope<{ callId: string; name: string; input: unknown }>>,
  toolResults: Map<string, AgentEventEnvelope<{ callId: string; output: unknown; isError?: boolean }>>,
): string[] {
  const paths = new Set<string>();

  for (const callEvent of toolCalls.values()) {
    const toolName = readString(callEvent.payload, "name");
    if (toolName !== "edit" && toolName !== "write" && toolName !== "write_file") {
      continue;
    }

    const callId = readString(callEvent.payload, "callId") ?? callEvent.id;
    const resultEvent = toolResults.get(callId);
    if (resultEvent && readBoolean(resultEvent.payload, "isError")) {
      continue;
    }

    const filePath = readReadFilePath(readValue(callEvent.payload, "input"));
    if (!filePath) {
      continue;
    }

    paths.add(normalizeContextFilePath(filePath));
  }

  return [...paths];
}

function collectCommandPreviews(
  toolCalls: Map<string, AgentEventEnvelope<{ callId: string; name: string; input: unknown }>>,
): string[] {
  const previews = new Set<string>();

  for (const callEvent of [...toolCalls.values()].reverse()) {
    const toolName = readString(callEvent.payload, "name");
    if (toolName !== "bash") {
      continue;
    }

    const preview = readCommandPreview(readValue(callEvent.payload, "input"));
    if (!preview) {
      continue;
    }

    previews.add(preview);
    if (previews.size >= 3) {
      break;
    }
  }

  return [...previews];
}

function collectRepairState(
  toolCalls: Map<string, AgentEventEnvelope<{ callId: string; name: string; input: unknown }>>,
  toolResults: Map<string, AgentEventEnvelope<{ callId: string; output: unknown; isError?: boolean }>>,
): { repairState: RepairStateV1; sourceCallId: string } | undefined {
  for (const callEvent of [...toolCalls.values()].reverse()) {
    if (readString(callEvent.payload, "name") !== "bash") {
      continue;
    }

    const command = readCommandPreview(readValue(callEvent.payload, "input"));
    if (!command || !isTestCommand(command)) {
      continue;
    }

    const callId = readString(callEvent.payload, "callId") ?? callEvent.id;
    const resultEvent = toolResults.get(callId);
    if (!resultEvent) {
      continue;
    }

    const outputText = readOutputText(readValue(resultEvent.payload, "output"));
    const failingTests = extractFailingTests(outputText);
    const unresolvedConstraints = extractUnresolvedConstraints(outputText);
    const isError = readBoolean(resultEvent.payload, "isError") ?? false;

    if (failingTests.length === 0 && unresolvedConstraints.length === 0 && !isError) {
      continue;
    }

    return {
      sourceCallId: callId,
      repairState: {
        version: "1",
        failingTests,
        lastTestCommand: command,
        unresolvedConstraints,
      },
    };
  }

  return undefined;
}

function collectFailureHints(
  toolCalls: Map<string, AgentEventEnvelope<{ callId: string; name: string; input: unknown }>>,
  toolResults: Map<string, AgentEventEnvelope<{ callId: string; output: unknown; isError?: boolean }>>,
  repairStateSourceCallId?: string,
): string[] {
  const hints = new Set<string>();

  for (const callEvent of toolCalls.values()) {
    const callId = readString(callEvent.payload, "callId") ?? callEvent.id;
    const resultEvent = toolResults.get(callId);
    if (!resultEvent) {
      continue;
    }

    const toolName = readString(callEvent.payload, "name") ?? "unknown_tool";
    const outputValue = readValue(resultEvent.payload, "output");
    const outputPreview = renderFailurePreview(outputValue);
    const isError = readBoolean(resultEvent.payload, "isError") ?? false;
    const commandPreview = toolName === "bash" ? readCommandPreview(readValue(callEvent.payload, "input")) : undefined;
    const isTestFailureCall =
      toolName === "bash" &&
      typeof commandPreview === "string" &&
      isTestCommand(commandPreview) &&
      looksLikeTestFailureOutput(readOutputText(outputValue));

    if (callId === repairStateSourceCallId || isTestFailureCall) {
      continue;
    }

    if (!isError && !(toolName === "bash" && looksLikeFailurePreview(outputPreview))) {
      continue;
    }

    const hint = outputPreview ? `${toolName}: ${outputPreview}` : `${toolName} failed`;
    hints.add(truncate(hint, 140));
    if (hints.size >= 3) {
      break;
    }
  }

  return [...hints];
}

function readReadFilePath(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const pathValue = record.filePath ?? record.path ?? record.file ?? record.pathname;
  return typeof pathValue === "string" && pathValue.trim().length > 0 ? pathValue : undefined;
}

function readCommandPreview(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  if (!command) {
    return undefined;
  }

  return truncate(command.replace(/\s+/g, " "), 80);
}

function readOutputText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as Record<string, unknown>;
  return (
    firstString(
      record.message,
      record.error,
      record.stderr,
      record.stdout,
      record.detail,
      record.summary,
      readNestedRecordString(record.output, "message"),
      readNestedRecordString(record.output, "stderr"),
      readNestedRecordString(record.output, "stdout"),
    ) ?? ""
  ).trim();
}

function renderFailurePreview(value: unknown): string {
  const outputText = readOutputText(value);
  if (outputText) {
    return truncate(outputText.replace(/\s+/g, " ").trim(), 120);
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  return truncate(renderPreview(value), 120);
}

function looksLikeFailurePreview(value: string): boolean {
  return /fail|error|traceback|assert|exception|not found|invalid/i.test(value);
}

function looksLikeTestFailureOutput(value: string): boolean {
  return /^FAILED\s+\S+/m.test(value) || /AssertionError:|(?:^|\n)\s*assert\s+/m.test(value);
}

function isTestCommand(value: string): boolean {
  return /\b(?:pytest|python\s+-m\s+pytest|uv\s+run\s+pytest|poetry\s+run\s+pytest|pnpm\s+test|npm\s+test|yarn\s+test|vitest|cargo\s+test)\b/i.test(value);
}

function extractFailingTests(value: string): string[] {
  const matches = new Set<string>();
  for (const match of value.matchAll(/^FAILED\s+(\S+)/gm)) {
    const testName = match[1]?.trim();
    if (testName) {
      matches.add(testName);
    }
  }
  return [...matches].slice(0, 5);
}

function extractUnresolvedConstraints(value: string): string[] {
  const matches = new Set<string>();
  for (const match of value.matchAll(/^(?:E\s+)?(AssertionError:[^\n]{1,120})$/gm)) {
    const constraint = normalizeConstraintLine(match[1]);
    if (constraint) {
      matches.add(constraint);
    }
  }
  for (const match of value.matchAll(/^(?:E\s+)?(assert [^\n]{1,120})$/gm)) {
    const constraint = normalizeConstraintLine(match[1]);
    if (constraint) {
      matches.add(constraint);
    }
  }
  return [...matches].slice(0, 4);
}

function normalizeConstraintLine(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? truncate(normalized, 120) : undefined;
}

function readNestedRecordString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
