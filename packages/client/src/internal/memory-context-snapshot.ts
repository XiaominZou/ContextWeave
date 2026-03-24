import type {
  Artifact,
  CapabilityPolicy,
  ContextBlock,
  ContextSnapshot,
  MemorySearchHit,
  Run,
  Session,
  Task,
} from "@ctx/core";
import type { MemoryAPI, PlatformStore } from "../contracts";
import { nextId } from "./ids";
import {
  readSessionGraphIndex,
  readTaskGraphIndex,
  selectGraphAwareContextBlocks,
} from "./session-graph";
import { readSessionSummary } from "./session-derived-context";
import { readNativeTaskMirror } from "./task-native-mirror";
import { readRunSummary, readTaskSummary } from "./task-derived-context";

const DEFAULT_MEMORY_RESULT_LIMIT = 5;
const DEFAULT_RUN_SUMMARY_LIMIT = 3;

interface ContextCollectorInput {
  run: Run;
  task: Task;
  policy: CapabilityPolicy;
  memoryApi: MemoryAPI;
  store: PlatformStore;
  preloadedMemoryHits?: MemorySearchHit[];
}

type ContextBlockCollector = (input: ContextCollectorInput) => Promise<ContextBlock[]>;

export async function maybeBuildRunContextSnapshot(input: ContextCollectorInput): Promise<ContextSnapshot | null> {
  if (input.policy.context === "native") {
    return null;
  }

  return buildContextSnapshot(input);
}

export async function buildContextSnapshot(input: ContextCollectorInput): Promise<ContextSnapshot> {
  const collectors: ContextBlockCollector[] = [
    collectPreloadedMemoryBlocks,
    collectTaskBlocks,
    collectTaskSummaryBlocks,
    collectDependencyTaskSummaryBlocks,
    collectRunSummaryBlocks,
    collectSessionSummaryBlocks,
    collectArtifactBlocks,
    collectMemoryBlocks,
  ];

  const collected = await Promise.all(collectors.map((collector) => collector(input)));
  const selection = selectGraphAwareContextBlocks({
    run: input.run,
    task: input.task,
    blocks: collected.flat(),
  });
  const blocks = selection.included;
  const totalTokens = blocks.reduce((sum, block) => sum + (block.tokenEstimate ?? 0), 0);
  const createdAt = new Date().toISOString();

  return {
    id: nextId("ctx"),
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sessionId,
    taskId: input.run.taskId,
    blocks,
    tokenEstimate: totalTokens,
    explanation: {
      included: blocks.map((block) => ({
        blockId: block.id,
        reason: renderInclusionReason(block),
        tokens: block.tokenEstimate ?? 0,
      })),
      excluded: selection.excluded,
      totalTokens,
    },
    createdAt,
  };
}

async function collectPreloadedMemoryBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  if (input.policy.memory !== "platform") {
    return [];
  }

  return (input.preloadedMemoryHits ?? []).map((hit) => buildMemoryContextBlock(hit, "session-preload"));
}

async function collectTaskBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  return [buildTaskContextBlock(input.task)];
}

async function collectTaskSummaryBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  const summary = readTaskSummary(input.task);
  if (!summary) {
    return [];
  }

  return [
    {
      id: nextId("ctxblk"),
      kind: "task",
      title: `${input.task.title} summary`,
      content: summary.summaryText,
      sourceRef: input.task.id,
      tokenEstimate: estimateTokens(summary.summaryText),
      metadata: {
        taskId: input.task.id,
        sourceTaskId: input.task.id,
        sourceType: "task-summary",
        inclusionReason: "task summary from prior task runs",
        graphDistance: 0,
        evidenceValue: 0.95,
        freshnessTs: summary.generatedAt,
        status: input.task.status,
      },
    },
  ];
}

async function collectDependencyTaskSummaryBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  const dependencyIds = readDependencyTaskIds(input.task);
  if (dependencyIds.length === 0) {
    return [];
  }

  const blocks: ContextBlock[] = [];
  for (const dependencyTaskId of dependencyIds) {
    const dependencyTask = input.store.getTask(dependencyTaskId);
    if (!dependencyTask) {
      continue;
    }
    const summary = readTaskSummary(dependencyTask);
    if (!summary) {
      continue;
    }
    blocks.push({
      id: nextId("ctxblk"),
      kind: "task",
      title: `${dependencyTask.title} dependency summary`,
      content: summary.summaryText,
      sourceRef: dependencyTask.id,
      tokenEstimate: estimateTokens(summary.summaryText),
      metadata: {
        taskId: dependencyTask.id,
        sourceTaskId: dependencyTask.id,
        sourceType: "dependency-task-summary",
        inclusionReason: "dependency task summary expanded by session graph",
        graphDistance: 1,
        evidenceValue: 0.88,
        freshnessTs: summary.generatedAt,
        status: dependencyTask.status,
      },
    });
  }

  return blocks;
}

async function collectRunSummaryBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  const summaries = input.store
    .listRunsByTask(input.task.id)
    .filter((run) => run.id !== input.run.id)
    .map((run) => ({ run, summary: readRunSummary(run) }))
    .filter((entry): entry is { run: Run; summary: NonNullable<ReturnType<typeof readRunSummary>> } => Boolean(entry.summary))
    .sort((left, right) => sortRunByRecency(right.run).localeCompare(sortRunByRecency(left.run)))
    .slice(0, DEFAULT_RUN_SUMMARY_LIMIT);

  return summaries.map(({ run, summary }) => ({
    id: nextId("ctxblk"),
    kind: "message",
    title: `Prior run ${run.id}`,
    content: summary.summaryText,
    sourceRef: run.id,
    tokenEstimate: estimateTokens(summary.summaryText),
    metadata: {
      taskId: run.taskId,
      sourceTaskId: run.taskId,
      runId: run.id,
      sourceRunId: run.id,
      sourceType: "run-summary",
      inclusionReason: "recent run summary for current task",
      graphDistance: 0,
      evidenceValue: 0.7,
      freshnessTs: run.endedAt ?? summary.generatedAt,
      status: run.status,
    },
  }));
}

async function collectSessionSummaryBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  const session = input.store.getSession(input.run.sessionId);
  if (!session) {
    return [];
  }

  const sessionSummary = readSessionSummary(session);
  if (!sessionSummary) {
    return [];
  }

  const hasSessionGraph = Boolean(readSessionGraphIndex(session));
  return [
    {
      id: nextId("ctxblk"),
      kind: "message",
      title: `${session.title ?? session.id} session summary`,
      content: sessionSummary.summaryText,
      sourceRef: session.id,
      tokenEstimate: estimateTokens(sessionSummary.summaryText),
      metadata: {
        sessionId: session.id,
        sourceType: "session-summary",
        inclusionReason: hasSessionGraph
          ? "session summary selected from session graph index"
          : "session summary selected from session metadata",
        graphDistance: 2,
        evidenceValue: 0.58,
        freshnessTs: sessionSummary.generatedAt,
        status: session.status,
      },
    },
  ];
}

async function collectArtifactBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  if (input.policy.artifacts !== "capture-store") {
    return [];
  }

  return input.store
    .listArtifacts()
    .filter((artifact) => artifact.taskId === input.task.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 3)
    .map((artifact) => ({
      id: nextId("ctxblk"),
      kind: "artifact" as const,
      title: artifact.title ?? artifact.id,
      content: renderArtifactBlock(artifact),
      sourceRef: artifact.id,
      tokenEstimate: estimateTokens(renderArtifactBlock(artifact)),
      metadata: {
        artifactId: artifact.id,
        taskId: artifact.taskId,
        sourceTaskId: artifact.taskId,
        sourceRunId: artifact.runId,
        sourceType: "artifact",
        inclusionReason: "recent captured artifact for current task",
        graphDistance: 0,
        evidenceValue: 0.74,
        freshnessTs: artifact.createdAt,
        status: "captured",
      },
    }));
}

async function collectMemoryBlocks(input: ContextCollectorInput): Promise<ContextBlock[]> {
  if (input.policy.memory !== "platform") {
    return [];
  }

  const queryText = buildMemoryQueryText(input);
  const searchResult = await input.memoryApi.search({
    anchor: {
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      taskId: input.run.taskId,
      runId: input.run.id,
    },
    queryText,
    layer: "long_term",
    maxResults: DEFAULT_MEMORY_RESULT_LIMIT,
  });

  const preloadedIds = new Set((input.preloadedMemoryHits ?? []).map((hit) => hit.record.id));
  return searchResult.hits
    .filter((hit) => !preloadedIds.has(hit.record.id))
    .map((hit) => buildMemoryContextBlock(hit, "pre-run"));
}

function buildTaskContextBlock(task: Task): ContextBlock {
  const nativeMirror = readNativeTaskMirror(task);
  const lines = [
    `[TASK] ${task.title}`,
    task.objective ? `Objective: ${task.objective}` : undefined,
    task.instructions ? `Instructions: ${task.instructions}` : undefined,
    nativeMirror ? `Native mirror: ${nativeMirror.summaryText}` : undefined,
    nativeMirror?.currentFocus ? `Current focus: ${nativeMirror.currentFocus}` : undefined,
  ].filter((value): value is string => Boolean(value));

  const content = lines.join("\n");

  return {
    id: nextId("ctxblk"),
    kind: "task",
    title: task.title,
    content,
    sourceRef: task.id,
    tokenEstimate: estimateTokens(content),
    metadata: {
      taskId: task.id,
      sourceTaskId: task.id,
      sourceType: "task",
      inclusionReason: "current task context",
      graphDistance: 0,
      evidenceValue: 1,
      freshnessTs: task.updatedAt,
      status: task.status,
    },
  };
}

function buildMemoryContextBlock(hit: MemorySearchHit, retrievalTrigger: "pre-run" | "session-preload"): ContextBlock {
  const content = renderMemoryBlock(hit.record);
  return {
    id: nextId("ctxblk"),
    kind: "memory",
    title: hit.record.title,
    content,
    sourceRef: hit.record.id,
    score: hit.finalScore,
    tokenEstimate: estimateTokens(content),
    metadata: {
      memoryId: hit.record.id,
      layer: hit.record.layer,
      channel: hit.record.channel,
      scope: hit.record.scope,
      retrievalTrigger,
      sourceType: retrievalTrigger === "session-preload" ? "session-preload" : "memory-search",
      inclusionReason:
        retrievalTrigger === "session-preload"
          ? `session preload hit from ${hit.record.scope} scope`
          : `memory=platform hit from ${hit.record.scope} scope`,
      graphDistance: retrievalTrigger === "session-preload" ? 0 : 1,
      evidenceValue: retrievalTrigger === "session-preload" ? 0.92 : 0.76,
      freshnessTs: hit.record.updatedAt,
      status: hit.record.status,
    },
  };
}

function buildMemoryQueryText(input: { run: Run; task: Task }): string {
  const pieces = [
    input.task.title,
    input.task.objective,
    input.task.instructions,
    typeof input.run.metadata?.["prompt"] === "string" ? String(input.run.metadata["prompt"]) : undefined,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return pieces.join("\n");
}

function renderMemoryBlock(record: {
  kind: string;
  title: string;
  summary?: string;
  content: string;
}): string {
  const body = record.summary?.trim() ? record.summary : record.content;
  return [`[${record.kind}] ${record.title}`, body].filter(Boolean).join("\n");
}

function renderArtifactBlock(artifact: Artifact): string {
  const lines = [
    `[artifact] ${artifact.title ?? artifact.id}`,
    `type: ${artifact.type}`,
    artifact.summary,
    artifact.uri,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return lines.join("\n");
}

function readDependencyTaskIds(task: Task): string[] {
  const graphIndex = readTaskGraphIndex(task);
  return graphIndex?.dependencyTaskIds ?? task.dependsOn ?? [];
}

function renderInclusionReason(block: ContextBlock): string {
  const reason = String(block.metadata?.["inclusionReason"] ?? "context block included");
  const retention = typeof block.metadata?.["retentionAction"] === "string" ? String(block.metadata?.["retentionAction"]) : undefined;
  return retention ? `${reason} (${retention})` : reason;
}

function sortRunByRecency(run: Run): string {
  return run.endedAt ?? run.startedAt ?? "";
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

