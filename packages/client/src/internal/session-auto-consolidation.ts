import type { Run, Session, Task } from "@ctx/core";

import { type SessionSummaryV1, readSessionSummary } from "./session-derived-context";

export const SESSION_AUTO_CONSOLIDATION_METADATA_KEY = "platformSessionAutoConsolidation";

export interface SessionAutoConsolidationStateV1 {
  version: "1";
  signature: string;
  consolidatedAt: string;
  reason: string;
  taskCount: number;
  runCount: number;
}

export function readSessionAutoConsolidationState(session: Session): SessionAutoConsolidationStateV1 | undefined {
  const value = session.metadata?.[SESSION_AUTO_CONSOLIDATION_METADATA_KEY];
  return isSessionAutoConsolidationState(value) ? value : undefined;
}

export function buildSessionAutoConsolidationState(input: {
  session: Session;
  summary?: SessionSummaryV1;
  reason: string;
}): SessionAutoConsolidationStateV1 | undefined {
  const summary = input.summary ?? readSessionSummary(input.session);
  if (!summary) {
    return undefined;
  }

  return {
    version: "1",
    signature: buildSessionAutoConsolidationSignature(input.session, summary),
    consolidatedAt: new Date().toISOString(),
    reason: input.reason,
    taskCount: summary.taskCount,
    runCount: summary.runCount,
  };
}

export function isSessionSettled(input: { session: Session; tasks: Task[]; runs: Run[] }): boolean {
  if (input.session.status === "archived") {
    return false;
  }
  if (input.tasks.length === 0) {
    return false;
  }
  return input.tasks.every((task) => isTerminalTaskStatus(task.status)) && input.runs.every((run) => isTerminalRunStatus(run.status));
}

export function isTerminalTaskStatus(status: Task["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

export function isTerminalRunStatus(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function buildSessionAutoConsolidationSignature(session: Session, summary: SessionSummaryV1): string {
  return [
    session.id,
    session.status,
    summary.taskCount,
    summary.completedTaskCount,
    summary.failedTaskCount,
    summary.cancelledTaskCount,
    summary.runCount,
    summary.completedRunCount,
    summary.failedRunCount,
    summary.cancelledRunCount,
    summary.latestTaskIds.join(","),
    summary.latestRunIds.join(","),
  ].join("|");
}

function isSessionAutoConsolidationState(value: unknown): value is SessionAutoConsolidationStateV1 {
  return Boolean(value)
    && typeof value === "object"
    && (value as { version?: unknown }).version === "1"
    && typeof (value as { signature?: unknown }).signature === "string"
    && typeof (value as { consolidatedAt?: unknown }).consolidatedAt === "string";
}
