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
  recentReadFilePaths: string[];
  recentEditedFilePaths: string[];
  recentCommandPreviews: string[];
  recentFailureHints: string[];
  latestAssistantOutputPreview?: string;
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
  const recentReadFilePaths = collectRecentFilePaths(runSummaries, "readFilePaths");
  const recentEditedFilePaths = collectRecentFilePaths(runSummaries, "editedFilePaths");
  const recentCommandPreviews = collectRecentCommandPreviews(runSummaries);
  const recentFailureHints = collectRecentFailureHints(runSummaries);
  const latestAssistantOutputPreview = runSummaries.find((summary) => summary.assistantOutputPreview)?.assistantOutputPreview;

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
    recentReadFilePaths,
    recentEditedFilePaths,
    recentCommandPreviews,
    recentFailureHints,
    latestAssistantOutputPreview,
    summaryText: buildTaskSummaryText({
      task: input.task,
      runs: sortedRuns,
      runSummaries,
      indexedToolCallCount,
      recentReadFilePaths,
      recentEditedFilePaths,
      recentCommandPreviews,
      recentFailureHints,
      latestAssistantOutputPreview,
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
  recentReadFilePaths: string[];
  recentEditedFilePaths: string[];
  recentCommandPreviews: string[];
  recentFailureHints: string[];
  latestAssistantOutputPreview?: string;
}): string {
  const fragments = [
    `Task ${input.task.id} ${input.task.status}`,
    `runs: ${input.runs.length}`,
    `completed: ${input.runs.filter((run) => run.status === "completed").length}`,
    input.runs.some((run) => run.status === "failed") ? `failed: ${input.runs.filter((run) => run.status === "failed").length}` : undefined,
    input.runs.some((run) => run.status === "cancelled") ? `cancelled: ${input.runs.filter((run) => run.status === "cancelled").length}` : undefined,
    input.indexedToolCallCount > 0 ? `indexed tool refs: ${input.indexedToolCallCount}` : undefined,
    input.runSummaries.length > 0 ? `runs with summaries: ${input.runSummaries.length}` : undefined,
    input.recentReadFilePaths.length > 0 ? `recent reads: ${input.recentReadFilePaths.join(", ")}` : undefined,
    input.recentEditedFilePaths.length > 0 ? `recent edits: ${input.recentEditedFilePaths.join(", ")}` : undefined,
    input.recentCommandPreviews.length > 0 ? `recent commands: ${input.recentCommandPreviews.join(" | ")}` : undefined,
    input.recentFailureHints.length > 0 ? `known failures: ${input.recentFailureHints.join(" | ")}` : undefined,
    input.latestAssistantOutputPreview ? `latest progress: ${input.latestAssistantOutputPreview}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return fragments.join("; ");
}

function collectRecentFilePaths(
  runSummaries: RunSummaryV1[],
  field: "readFilePaths" | "editedFilePaths",
): string[] {
  const values = new Set<string>();
  for (const summary of runSummaries) {
    const paths = Array.isArray(summary[field]) ? summary[field] : [];
    for (const path of paths) {
      if (!path) {
        continue;
      }
      values.add(path);
      if (values.size >= 5) {
        return [...values];
      }
    }
  }
  return [...values];
}

function collectRecentCommandPreviews(runSummaries: RunSummaryV1[]): string[] {
  const values = new Set<string>();
  for (const summary of runSummaries) {
    const commands = Array.isArray(summary.commandPreviews) ? summary.commandPreviews : [];
    for (const command of commands) {
      if (!command) {
        continue;
      }
      values.add(command);
      if (values.size >= 3) {
        return [...values];
      }
    }
  }
  return [...values];
}

function collectRecentFailureHints(runSummaries: RunSummaryV1[]): string[] {
  const values = new Set<string>();
  for (const summary of runSummaries) {
    const hints = Array.isArray(summary.failureHints) ? summary.failureHints : [];
    for (const hint of hints) {
      if (!hint) {
        continue;
      }
      values.add(hint);
      if (values.size >= 4) {
        return [...values];
      }
    }
  }
  return [...values];
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
