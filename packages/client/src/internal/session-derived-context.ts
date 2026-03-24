import type { Run, Session, Task } from "@ctx/core";

import { readTaskSummary } from "./task-derived-context";

export const SESSION_SUMMARY_METADATA_KEY = "platformSessionSummary";

export interface SessionSummaryV1 {
  version: "1";
  generatedAt: string;
  sessionStatus: Session["status"];
  taskCount: number;
  completedTaskCount: number;
  failedTaskCount: number;
  cancelledTaskCount: number;
  runCount: number;
  completedRunCount: number;
  failedRunCount: number;
  cancelledRunCount: number;
  latestTaskIds: string[];
  latestRunIds: string[];
  summaryText: string;
}

export function buildSessionDerivedContext(input: { session: Session; tasks: Task[]; runs: Run[] }): { sessionSummary: SessionSummaryV1 } {
  const sortedTasks = [...input.tasks].sort((left, right) => sortTaskByRecency(right).localeCompare(sortTaskByRecency(left)));
  const sortedRuns = [...input.runs].sort((left, right) => sortRunByRecency(right).localeCompare(sortRunByRecency(left)));
  const latestTaskSummary = sortedTasks.map((task) => readTaskSummary(task)).find((summary) => Boolean(summary));

  const sessionSummary: SessionSummaryV1 = {
    version: "1",
    generatedAt: new Date().toISOString(),
    sessionStatus: input.session.status,
    taskCount: input.tasks.length,
    completedTaskCount: input.tasks.filter((task) => task.status === "completed").length,
    failedTaskCount: input.tasks.filter((task) => task.status === "failed").length,
    cancelledTaskCount: input.tasks.filter((task) => task.status === "cancelled").length,
    runCount: input.runs.length,
    completedRunCount: input.runs.filter((run) => run.status === "completed").length,
    failedRunCount: input.runs.filter((run) => run.status === "failed").length,
    cancelledRunCount: input.runs.filter((run) => run.status === "cancelled").length,
    latestTaskIds: sortedTasks.slice(0, 3).map((task) => task.id),
    latestRunIds: sortedRuns.slice(0, 5).map((run) => run.id),
    summaryText: buildSessionSummaryText({
      session: input.session,
      tasks: sortedTasks,
      runs: sortedRuns,
      latestTaskSummary: latestTaskSummary?.summaryText,
    }),
  };

  return { sessionSummary };
}

export function readSessionSummary(session: Session): SessionSummaryV1 | undefined {
  const value = session.metadata?.[SESSION_SUMMARY_METADATA_KEY];
  return isSessionSummary(value) ? value : undefined;
}

function buildSessionSummaryText(input: {
  session: Session;
  tasks: Task[];
  runs: Run[];
  latestTaskSummary?: string;
}): string {
  const fragments = [
    `Session ${input.session.id} ${input.session.status}`,
    `tasks: ${input.tasks.length}`,
    `runs: ${input.runs.length}`,
    input.tasks.some((task) => task.status === "completed") ? `completed tasks: ${input.tasks.filter((task) => task.status === "completed").length}` : undefined,
    input.tasks.some((task) => task.status === "failed") ? `failed tasks: ${input.tasks.filter((task) => task.status === "failed").length}` : undefined,
    input.tasks.some((task) => task.status === "cancelled") ? `cancelled tasks: ${input.tasks.filter((task) => task.status === "cancelled").length}` : undefined,
    input.runs.some((run) => run.status === "failed") ? `failed runs: ${input.runs.filter((run) => run.status === "failed").length}` : undefined,
    input.latestTaskSummary ? `latest task: ${input.latestTaskSummary}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return fragments.join("; ");
}

function sortTaskByRecency(task: Task): string {
  return task.completedAt ?? task.updatedAt ?? task.createdAt ?? "";
}

function sortRunByRecency(run: Run): string {
  return run.endedAt ?? run.startedAt ?? "";
}

function isSessionSummary(value: unknown): value is SessionSummaryV1 {
  return Boolean(value) && typeof value === "object" && (value as { version?: string }).version === "1" && typeof (value as { summaryText?: unknown }).summaryText === "string";
}
