import type { AgentEventEnvelope, Task } from "@ctx/core";

export const TASK_NATIVE_MIRROR_METADATA_KEY = "platformNativeTaskMirror";

export interface MirroredNativeTaskItemV1 {
  title: string;
  status: "pending" | "in_progress" | "blocked" | "completed";
}

export interface NativeTaskMirrorV1 {
  version: "1";
  sourceToolName: string;
  sourceCallId: string;
  itemCount: number;
  pendingCount: number;
  inProgressCount: number;
  blockedCount: number;
  completedCount: number;
  suggestedTaskStatus: Task["status"];
  currentFocus?: string;
  summaryText: string;
  items: MirroredNativeTaskItemV1[];
  updatedAt: string;
}

export function maybeBuildNativeTaskMirror(input: {
  task: Task;
  event: AgentEventEnvelope;
  priorEvents: AgentEventEnvelope[];
}): NativeTaskMirrorV1 | null {
  if (input.event.type !== "tool.result") {
    return null;
  }

  const callId = readString(input.event.payload, "callId");
  if (!callId) {
    return null;
  }

  const callEvent = findToolCall(input.priorEvents, callId);
  if (!callEvent) {
    return null;
  }

  const toolName = readString(callEvent.payload, "name");
  if (!toolName || !isNativeTodoTool(toolName)) {
    return null;
  }

  const resultOutput = readValue(input.event.payload, "output");
  const callInput = readValue(callEvent.payload, "input");
  const items = extractNativeTaskItems(resultOutput) ?? extractNativeTaskItems(callInput);
  if (!items || items.length === 0) {
    return null;
  }

  const pendingCount = items.filter((item) => item.status === "pending").length;
  const inProgressCount = items.filter((item) => item.status === "in_progress").length;
  const blockedCount = items.filter((item) => item.status === "blocked").length;
  const completedCount = items.filter((item) => item.status === "completed").length;
  const currentFocus = items.find((item) => item.status === "in_progress")?.title;
  const suggestedTaskStatus = deriveSuggestedTaskStatus(items);

  return {
    version: "1",
    sourceToolName: toolName,
    sourceCallId: callId,
    itemCount: items.length,
    pendingCount,
    inProgressCount,
    blockedCount,
    completedCount,
    suggestedTaskStatus,
    currentFocus,
    summaryText: buildMirrorSummaryText({
      toolName,
      itemCount: items.length,
      pendingCount,
      inProgressCount,
      blockedCount,
      completedCount,
      currentFocus,
    }),
    items,
    updatedAt: new Date().toISOString(),
  };
}

export function applyNativeTaskMirror(task: Task, mirror: NativeTaskMirrorV1): Task {
  const now = new Date().toISOString();
  const nextStatus = selectMirroredTaskStatus(task.status, mirror.suggestedTaskStatus);
  return {
    ...task,
    status: nextStatus,
    updatedAt: now,
    completedAt: nextStatus === "completed" ? task.completedAt ?? now : task.completedAt,
    metadata: {
      ...task.metadata,
      [TASK_NATIVE_MIRROR_METADATA_KEY]: mirror,
    },
  };
}

export function readNativeTaskMirror(task: Task): NativeTaskMirrorV1 | undefined {
  const value = task.metadata?.[TASK_NATIVE_MIRROR_METADATA_KEY];
  return isNativeTaskMirror(value) ? value : undefined;
}

function findToolCall(events: AgentEventEnvelope[], callId: string): AgentEventEnvelope<{ callId: string; name: string; input: unknown }> | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== "tool.call") {
      continue;
    }
    if (readString(event.payload, "callId") === callId) {
      return event as AgentEventEnvelope<{ callId: string; name: string; input: unknown }>;
    }
  }
  return undefined;
}

function isNativeTodoTool(name: string): boolean {
  const normalized = name.replace(/[\s_.-]/g, "").toLowerCase();
  return normalized.includes("todo");
}

function extractNativeTaskItems(value: unknown): MirroredNativeTaskItemV1[] | undefined {
  const list = readTodoArray(value);
  if (!list) {
    return undefined;
  }

  return list
    .map((entry) => normalizeTaskItem(entry))
    .filter((entry): entry is MirroredNativeTaskItemV1 => Boolean(entry));
}

function readTodoArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const candidates = ["todos", "items", "tasks", "entries"];
  for (const key of candidates) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      return nested;
    }
  }
  return undefined;
}

function normalizeTaskItem(value: unknown): MirroredNativeTaskItemV1 | null {
  if (typeof value === "string") {
    const title = value.trim();
    return title ? { title, status: "pending" } : null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const title = [record.content, record.title, record.text, record.label, record.name].find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );

  if (typeof title !== "string" || title.trim().length === 0) {
    return null;
  }

  return {
    title: title.trim(),
    status: normalizeItemStatus(record),
  };
}

function normalizeItemStatus(value: Record<string, unknown>): MirroredNativeTaskItemV1["status"] {
  if (typeof value.completed === "boolean") {
    return value.completed ? "completed" : "pending";
  }
  if (typeof value.active === "boolean" && value.active) {
    return "in_progress";
  }
  if (typeof value.current === "boolean" && value.current) {
    return "in_progress";
  }

  const rawStatus = [value.status, value.state].find((candidate) => typeof candidate === "string");
  if (typeof rawStatus !== "string") {
    return "pending";
  }

  const normalized = rawStatus.replace(/[\s-]/g, "_").toLowerCase();
  if (normalized === "completed" || normalized === "done" || normalized === "finished") {
    return "completed";
  }
  if (normalized === "in_progress" || normalized === "doing" || normalized === "active" || normalized === "running" || normalized === "current") {
    return "in_progress";
  }
  if (normalized === "blocked" || normalized === "waiting" || normalized === "stalled") {
    return "blocked";
  }
  return "pending";
}

function deriveSuggestedTaskStatus(items: MirroredNativeTaskItemV1[]): Task["status"] {
  if (items.some((item) => item.status === "blocked")) {
    return "blocked";
  }
  if (items.some((item) => item.status === "in_progress")) {
    return "running";
  }
  if (items.length > 0 && items.every((item) => item.status === "completed")) {
    return "completed";
  }
  return "ready";
}

function selectMirroredTaskStatus(current: Task["status"], suggested: Task["status"]): Task["status"] {
  if (current === "failed" || current === "cancelled") {
    return current;
  }
  if (current === "completed" && suggested !== "completed") {
    return current;
  }
  return suggested;
}

function buildMirrorSummaryText(input: {
  toolName: string;
  itemCount: number;
  pendingCount: number;
  inProgressCount: number;
  blockedCount: number;
  completedCount: number;
  currentFocus?: string;
}): string {
  const fragments = [
    `Native task mirror from ${input.toolName}`,
    `items: ${input.itemCount}`,
    input.completedCount > 0 ? `completed: ${input.completedCount}` : undefined,
    input.inProgressCount > 0 ? `in progress: ${input.inProgressCount}` : undefined,
    input.pendingCount > 0 ? `pending: ${input.pendingCount}` : undefined,
    input.blockedCount > 0 ? `blocked: ${input.blockedCount}` : undefined,
    input.currentFocus ? `current focus: ${input.currentFocus}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return fragments.join("; ");
}

function isNativeTaskMirror(value: unknown): value is NativeTaskMirrorV1 {
  return Boolean(value)
    && typeof value === "object"
    && (value as { version?: string }).version === "1"
    && typeof (value as { summaryText?: unknown }).summaryText === "string";
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : undefined;
}

function readValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
