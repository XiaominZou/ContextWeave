import type { Run, Task } from "@ctx/core";

import { RUN_SUMMARY_METADATA_KEY, TOOL_CALL_REFS_METADATA_KEY, type RunSummaryV1, type ToolCallRefV1 } from "./run-derived-context";

export const TASK_SUMMARY_METADATA_KEY = "platformTaskSummary";

export interface TaskSummaryV1 {
  version: "1";
  generatedAt: string;
  taskStatus: Task["status"];
  runCount: number;
  completedRunCount: number;
  failedRunCount: number;
  cancelledRunCount: number;
  indexedToolCallCount: number;
  latestRunIds: string[];
  summaryText: string;
}

export function buildTaskDerivedContext(input: { task: Task; runs: Run[] }): { taskSummary: TaskSummaryV1 } {
  const sortedRuns = [...input.runs].sort((left, right) => {
    const rightTimestamp = runSortTimestamp(right);
    const leftTimestamp = runSortTimestamp(left);
    return rightTimestamp.localeCompare(leftTimestamp);
  });

  const runSummaries = sortedRuns
    .map((run) => readRunSummary(run))
    .filter((summary): summary is RunSummaryV1 => Boolean(summary));

  const indexedToolCallCount = sortedRuns.reduce((sum, run) => sum + readToolCallRefs(run).length, 0);
  const taskSummary: TaskSummaryV1 = {
    version: "1",
    generatedAt: new Date().toISOString(),
    taskStatus: input.task.status,
    runCount: input.runs.length,
    completedRunCount: input.runs.filter((run) => run.status === "completed").length,
    failedRunCount: input.runs.filter((run) => run.status === "failed").length,
    cancelledRunCount: input.runs.filter((run) => run.status === "cancelled").length,
    indexedToolCallCount,
    latestRunIds: sortedRuns.slice(0, 3).map((run) => run.id),
    summaryText: buildTaskSummaryText({
      task: input.task,
      runs: sortedRuns,
      runSummaries,
      indexedToolCallCount,
    }),
  };

  return { taskSummary };
}

export function readTaskSummary(task: Task): TaskSummaryV1 | undefined {
  const value = task.metadata?.[TASK_SUMMARY_METADATA_KEY];
  return isTaskSummary(value) ? value : undefined;
}

export function readRunSummary(run: Run): RunSummaryV1 | undefined {
  const value = run.metadata?.[RUN_SUMMARY_METADATA_KEY];
  return isRunSummary(value) ? value : undefined;
}

export function readToolCallRefs(run: Run): ToolCallRefV1[] {
  const value = run.metadata?.[TOOL_CALL_REFS_METADATA_KEY];
  return Array.isArray(value) ? value.filter(isToolCallRef) : [];
}

function buildTaskSummaryText(input: {
  task: Task;
  runs: Run[];
  runSummaries: RunSummaryV1[];
  indexedToolCallCount: number;
}): string {
  const fragments = [
    `Task ${input.task.id} ${input.task.status}`,
    `runs: ${input.runs.length}`,
    `completed: ${input.runs.filter((run) => run.status === "completed").length}`,
    input.runs.some((run) => run.status === "failed") ? `failed: ${input.runs.filter((run) => run.status === "failed").length}` : undefined,
    input.runs.some((run) => run.status === "cancelled") ? `cancelled: ${input.runs.filter((run) => run.status === "cancelled").length}` : undefined,
    input.indexedToolCallCount > 0 ? `indexed tool refs: ${input.indexedToolCallCount}` : undefined,
    input.runSummaries.length > 0 ? `runs with summaries: ${input.runSummaries.length}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return fragments.join("; ");
}

function runSortTimestamp(run: Run): string {
  return run.endedAt ?? run.startedAt ?? "";
}

function isRunSummary(value: unknown): value is RunSummaryV1 {
  return Boolean(value) && typeof value === "object" && (value as { version?: string }).version === "1" && typeof (value as { summaryText?: unknown }).summaryText === "string";
}

function isTaskSummary(value: unknown): value is TaskSummaryV1 {
  return Boolean(value) && typeof value === "object" && (value as { version?: string }).version === "1" && typeof (value as { summaryText?: unknown }).summaryText === "string";
}

function isToolCallRef(value: unknown): value is ToolCallRefV1 {
  return Boolean(value) && typeof value === "object" && (value as { version?: string }).version === "1" && typeof (value as { callId?: unknown }).callId === "string";
}
