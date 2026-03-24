import type { ContextBlock, Run, Session, Task } from "@ctx/core";

import type { RunSummaryV1, ToolCallRefV1 } from "./run-derived-context";
import { readSessionSummary } from "./session-derived-context";
import { readRunSummary, readTaskSummary, readToolCallRefs } from "./task-derived-context";

export const RUN_GRAPH_INDEX_METADATA_KEY = "platformRunGraphIndex";
export const TASK_GRAPH_INDEX_METADATA_KEY = "platformTaskGraphIndex";
export const SESSION_GRAPH_INDEX_METADATA_KEY = "platformSessionGraphIndex";

export type GraphNodeKindV1 =
  | "run-summary"
  | "task-summary"
  | "session-summary"
  | "task-ref"
  | "run-ref"
  | "tool-call-ref";

export type GraphEdgeKindV1 = "contains" | "depends_on" | "supports" | "references";

export interface GraphNodeV1 {
  id: string;
  kind: GraphNodeKindV1;
  refId: string;
  title?: string;
  summaryText?: string;
  taskId?: string;
  runId?: string;
  sessionId?: string;
  freshnessTs?: string;
  status?: string;
}

export interface GraphEdgeV1 {
  from: string;
  to: string;
  kind: GraphEdgeKindV1;
}

export interface RunGraphIndexV1 {
  version: "1";
  generatedAt: string;
  runId: string;
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
}

export interface TaskGraphIndexV1 {
  version: "1";
  generatedAt: string;
  taskId: string;
  dependencyTaskIds: string[];
  latestRunIds: string[];
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
}

export interface SessionGraphIndexV1 {
  version: "1";
  generatedAt: string;
  sessionId: string;
  taskIds: string[];
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
}

export interface ContextSelectionResult {
  included: ContextBlock[];
  excluded: Array<{ sourceRef: string; reason: string }>;
}

const DEFAULT_SOFT_BLOCK_LIMIT = 4;

export function buildRunGraphIndex(input: {
  run: Run;
  runSummary: RunSummaryV1;
  toolCallRefs: ToolCallRefV1[];
}): RunGraphIndexV1 {
  const nodes: GraphNodeV1[] = [
    {
      id: `run-summary:${input.run.id}`,
      kind: "run-summary",
      refId: input.run.id,
      title: `Run ${input.run.id}`,
      summaryText: input.runSummary.summaryText,
      taskId: input.run.taskId,
      runId: input.run.id,
      sessionId: input.run.sessionId,
      freshnessTs: input.run.endedAt ?? input.run.startedAt,
      status: input.run.status,
    },
    ...input.toolCallRefs.map((toolRef) => ({
      id: `tool-call-ref:${toolRef.callId}`,
      kind: "tool-call-ref" as const,
      refId: toolRef.callId,
      title: toolRef.toolName,
      summaryText: toolRef.summaryText,
      taskId: input.run.taskId,
      runId: input.run.id,
      sessionId: input.run.sessionId,
      freshnessTs: input.run.endedAt ?? input.run.startedAt,
      status: toolRef.isError ? "failed" : "completed",
    })),
  ];

  const edges: GraphEdgeV1[] = input.toolCallRefs.map((toolRef) => ({
    from: `run-summary:${input.run.id}`,
    to: `tool-call-ref:${toolRef.callId}`,
    kind: toolRef.hasArtifact ? "references" : "supports",
  }));

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    runId: input.run.id,
    nodes,
    edges,
  };
}

export function buildTaskGraphIndex(input: { task: Task; runs: Run[]; sessionTasks?: Task[] }): TaskGraphIndexV1 {
  const summary = readTaskSummary(input.task);
  const dependencyTasks = (input.sessionTasks ?? []).filter((task) => (input.task.dependsOn ?? []).includes(task.id));
  const sortedRuns = [...input.runs].sort((left, right) => runTimestamp(right).localeCompare(runTimestamp(left)));

  const nodes: GraphNodeV1[] = [];
  const edges: GraphEdgeV1[] = [];

  if (summary) {
    nodes.push({
      id: `task-summary:${input.task.id}`,
      kind: "task-summary",
      refId: input.task.id,
      title: input.task.title,
      summaryText: summary.summaryText,
      taskId: input.task.id,
      sessionId: input.task.sessionId,
      freshnessTs: input.task.completedAt ?? input.task.updatedAt,
      status: input.task.status,
    });
  }

  for (const dependencyTask of dependencyTasks) {
    const dependencySummary = readTaskSummary(dependencyTask);
    nodes.push({
      id: `task-ref:${dependencyTask.id}`,
      kind: "task-ref",
      refId: dependencyTask.id,
      title: dependencyTask.title,
      summaryText: dependencySummary?.summaryText,
      taskId: dependencyTask.id,
      sessionId: dependencyTask.sessionId,
      freshnessTs: dependencyTask.completedAt ?? dependencyTask.updatedAt,
      status: dependencyTask.status,
    });

    if (summary) {
      edges.push({
        from: `task-summary:${input.task.id}`,
        to: `task-ref:${dependencyTask.id}`,
        kind: "depends_on",
      });
    }
  }

  for (const run of sortedRuns) {
    const runSummary = readRunSummary(run);
    if (!runSummary) {
      continue;
    }

    const runNodeId = `run-ref:${run.id}`;
    nodes.push({
      id: runNodeId,
      kind: "run-ref",
      refId: run.id,
      title: `Run ${run.id}`,
      summaryText: runSummary.summaryText,
      taskId: run.taskId,
      runId: run.id,
      sessionId: run.sessionId,
      freshnessTs: run.endedAt ?? run.startedAt,
      status: run.status,
    });
    if (summary) {
      edges.push({
        from: `task-summary:${input.task.id}`,
        to: runNodeId,
        kind: "contains",
      });
    }

    for (const toolRef of readToolCallRefs(run)) {
      const toolNodeId = `tool-call-ref:${run.id}:${toolRef.callId}`;
      nodes.push({
        id: toolNodeId,
        kind: "tool-call-ref",
        refId: toolRef.callId,
        title: toolRef.toolName,
        summaryText: toolRef.summaryText,
        taskId: run.taskId,
        runId: run.id,
        sessionId: run.sessionId,
        freshnessTs: run.endedAt ?? run.startedAt,
        status: toolRef.isError ? "failed" : "completed",
      });
      edges.push({
        from: runNodeId,
        to: toolNodeId,
        kind: toolRef.hasArtifact ? "references" : "supports",
      });
    }
  }

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    taskId: input.task.id,
    dependencyTaskIds: dependencyTasks.map((task) => task.id),
    latestRunIds: sortedRuns.slice(0, 3).map((run) => run.id),
    nodes,
    edges,
  };
}

export function buildSessionGraphIndex(input: { session: Session; tasks: Task[]; runs: Run[] }): SessionGraphIndexV1 {
  const summary = readSessionSummary(input.session);
  const nodes: GraphNodeV1[] = [];
  const edges: GraphEdgeV1[] = [];

  if (summary) {
    nodes.push({
      id: `session-summary:${input.session.id}`,
      kind: "session-summary",
      refId: input.session.id,
      title: input.session.title,
      summaryText: summary.summaryText,
      sessionId: input.session.id,
      freshnessTs: input.session.archivedAt ?? input.session.updatedAt,
      status: input.session.status,
    });
  }

  for (const task of input.tasks) {
    const taskSummary = readTaskSummary(task);
    const taskNodeId = `task-ref:${task.id}`;
    nodes.push({
      id: taskNodeId,
      kind: "task-ref",
      refId: task.id,
      title: task.title,
      summaryText: taskSummary?.summaryText,
      taskId: task.id,
      sessionId: task.sessionId,
      freshnessTs: task.completedAt ?? task.updatedAt,
      status: task.status,
    });
    if (summary) {
      edges.push({
        from: `session-summary:${input.session.id}`,
        to: taskNodeId,
        kind: "contains",
      });
    }

    for (const dependencyTaskId of task.dependsOn ?? []) {
      edges.push({
        from: taskNodeId,
        to: `task-ref:${dependencyTaskId}`,
        kind: "depends_on",
      });
    }
  }

  for (const run of input.runs) {
    const runSummary = readRunSummary(run);
    if (!runSummary) {
      continue;
    }
    const runNodeId = `run-ref:${run.id}`;
    nodes.push({
      id: runNodeId,
      kind: "run-ref",
      refId: run.id,
      title: `Run ${run.id}`,
      summaryText: runSummary.summaryText,
      taskId: run.taskId,
      runId: run.id,
      sessionId: run.sessionId,
      freshnessTs: run.endedAt ?? run.startedAt,
      status: run.status,
    });
    edges.push({
      from: `task-ref:${run.taskId}`,
      to: runNodeId,
      kind: "contains",
    });
  }

  return {
    version: "1",
    generatedAt: new Date().toISOString(),
    sessionId: input.session.id,
    taskIds: input.tasks.map((task) => task.id),
    nodes,
    edges,
  };
}

export function readTaskGraphIndex(task: Task): TaskGraphIndexV1 | undefined {
  const value = task.metadata?.[TASK_GRAPH_INDEX_METADATA_KEY];
  return isTaskGraphIndex(value) ? value : undefined;
}

export function readSessionGraphIndex(session: Session): SessionGraphIndexV1 | undefined {
  const value = session.metadata?.[SESSION_GRAPH_INDEX_METADATA_KEY];
  return isSessionGraphIndex(value) ? value : undefined;
}

export function selectGraphAwareContextBlocks(input: {
  run: Run;
  task: Task;
  blocks: ContextBlock[];
}): ContextSelectionResult {
  const dependencyIds = new Set(readDependencyIds(input.task));
  const includedHard: Array<{ block: ContextBlock; originalIndex: number }> = [];
  const softCandidates: Array<{ block: ContextBlock; originalIndex: number; score: number; retention: "summary-only" | "expand" }> = [];
  const excluded: Array<{ sourceRef: string; reason: string }> = [];

  input.blocks.forEach((block, index) => {
    if (isHardRecallBlock(block, input.task.id)) {
      setRetention(block, block.metadata?.["sourceType"] === "task" ? "expand" : "summary-only", 1);
      includedHard.push({ block, originalIndex: index });
      return;
    }

    const score = computeBlockScore(block, input.task.id, dependencyIds);
    const retention = score >= 0.72 ? "expand" : score >= 0.45 ? "summary-only" : "drop";

    if (retention === "drop") {
      excluded.push({
        sourceRef: block.sourceRef,
        reason: `graph-aware pruning dropped low-signal block (score ${score.toFixed(2)})`,
      });
      return;
    }

    setRetention(block, retention, score);
    softCandidates.push({ block, originalIndex: index, score, retention });
  });

  softCandidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.originalIndex - right.originalIndex;
  });

  const keptSoft = softCandidates.slice(0, DEFAULT_SOFT_BLOCK_LIMIT);
  const droppedSoft = softCandidates.slice(DEFAULT_SOFT_BLOCK_LIMIT);
  for (const dropped of droppedSoft) {
    excluded.push({
      sourceRef: dropped.block.sourceRef,
      reason: `graph-aware pruning exceeded soft block budget (score ${dropped.score.toFixed(2)})`,
    });
  }

  const included = [
    ...includedHard.sort((left, right) => left.originalIndex - right.originalIndex).map((entry) => entry.block),
    ...keptSoft.map((entry) => entry.block),
  ];

  return {
    included,
    excluded,
  };
}

function readDependencyIds(task: Task): string[] {
  const graphIndex = readTaskGraphIndex(task);
  if (graphIndex?.dependencyTaskIds?.length) {
    return graphIndex.dependencyTaskIds;
  }
  return task.dependsOn ?? [];
}

function isHardRecallBlock(block: ContextBlock, currentTaskId: string): boolean {
  const sourceType = readStringMetadata(block, "sourceType");
  const sourceTaskId = readStringMetadata(block, "sourceTaskId");
  return (
    (sourceType === "task" && sourceTaskId === currentTaskId) ||
    (sourceType === "task-summary" && sourceTaskId === currentTaskId) ||
    sourceType === "session-preload"
  );
}

function computeBlockScore(block: ContextBlock, currentTaskId: string, dependencyIds: Set<string>): number {
  const sourceType = readStringMetadata(block, "sourceType");
  const sourceTaskId = readStringMetadata(block, "sourceTaskId");
  const graphDistance = readNumberMetadata(block, "graphDistance") ?? inferGraphDistance(sourceTaskId, currentTaskId, dependencyIds);
  const evidenceValue = readNumberMetadata(block, "evidenceValue") ?? defaultEvidenceValue(sourceType);
  const freshnessTs = readStringMetadata(block, "freshnessTs");
  const statusPenalty = computeStatusPenalty(readStringMetadata(block, "status"));

  const focusMatch = sourceTaskId === currentTaskId ? 1 : dependencyIds.has(sourceTaskId ?? "") ? 0.72 : sourceType === "memory-search" ? 0.66 : sourceType === "session-summary" ? 0.3 : 0.45;
  const graphProximity = graphDistance <= 0 ? 1 : graphDistance === 1 ? 0.7 : 0.45;
  const freshness = computeFreshness(freshnessTs);

  const score = focusMatch * 0.4 + graphProximity * 0.25 + freshness * 0.2 + evidenceValue * 0.15 - statusPenalty;
  return Math.max(0, Math.min(1, score));
}

function inferGraphDistance(sourceTaskId: string | undefined, currentTaskId: string, dependencyIds: Set<string>): number {
  if (sourceTaskId === currentTaskId) {
    return 0;
  }
  if (sourceTaskId && dependencyIds.has(sourceTaskId)) {
    return 1;
  }
  return 2;
}

function defaultEvidenceValue(sourceType: string | undefined): number {
  switch (sourceType) {
    case "task-summary":
      return 0.95;
    case "dependency-task-summary":
      return 0.88;
    case "session-preload":
      return 0.92;
    case "memory-search":
      return 0.76;
    case "run-summary":
      return 0.7;
    case "session-summary":
      return 0.58;
    case "task":
      return 1;
    default:
      return 0.6;
  }
}

function computeFreshness(timestamp: string | undefined): number {
  if (!timestamp) {
    return 0.5;
  }
  const value = Date.parse(timestamp);
  if (Number.isNaN(value)) {
    return 0.5;
  }
  const ageMs = Math.max(0, Date.now() - value);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays <= 1) {
    return 1;
  }
  if (ageDays <= 7) {
    return 0.85;
  }
  if (ageDays <= 30) {
    return 0.65;
  }
  return 0.45;
}

function computeStatusPenalty(status: string | undefined): number {
  if (status === "invalidated" || status === "archived" || status === "expired") {
    return 0.35;
  }
  if (status === "failed" || status === "cancelled") {
    return 0.12;
  }
  return 0;
}

function setRetention(block: ContextBlock, retention: "summary-only" | "expand", score: number): void {
  block.score = score;
  block.metadata = {
    ...block.metadata,
    retentionAction: retention,
    graphScore: score,
  };
}

function runTimestamp(run: Run): string {
  return run.endedAt ?? run.startedAt ?? "";
}

function readStringMetadata(block: ContextBlock, key: string): string | undefined {
  const value = block.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function readNumberMetadata(block: ContextBlock, key: string): number | undefined {
  const value = block.metadata?.[key];
  return typeof value === "number" ? value : undefined;
}

function isGraphNode(value: unknown): value is GraphNodeV1 {
  return Boolean(value) && typeof value === "object" && typeof (value as { id?: unknown }).id === "string" && typeof (value as { kind?: unknown }).kind === "string";
}

function isGraphEdge(value: unknown): value is GraphEdgeV1 {
  return Boolean(value) && typeof value === "object" && typeof (value as { from?: unknown }).from === "string" && typeof (value as { to?: unknown }).to === "string";
}

function isTaskGraphIndex(value: unknown): value is TaskGraphIndexV1 {
  return Boolean(value)
    && typeof value === "object"
    && (value as { version?: unknown }).version === "1"
    && Array.isArray((value as { dependencyTaskIds?: unknown }).dependencyTaskIds)
    && Array.isArray((value as { nodes?: unknown }).nodes)
    && ((value as { nodes: unknown[] }).nodes).every(isGraphNode)
    && Array.isArray((value as { edges?: unknown }).edges)
    && ((value as { edges: unknown[] }).edges).every(isGraphEdge);
}

function isSessionGraphIndex(value: unknown): value is SessionGraphIndexV1 {
  return Boolean(value)
    && typeof value === "object"
    && (value as { version?: unknown }).version === "1"
    && Array.isArray((value as { taskIds?: unknown }).taskIds)
    && Array.isArray((value as { nodes?: unknown }).nodes)
    && ((value as { nodes: unknown[] }).nodes).every(isGraphNode)
    && Array.isArray((value as { edges?: unknown }).edges)
    && ((value as { edges: unknown[] }).edges).every(isGraphEdge);
}

