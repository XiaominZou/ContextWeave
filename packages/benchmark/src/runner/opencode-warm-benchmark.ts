import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createContextPlatform,
  RUN_SUMMARY_METADATA_KEY,
  SESSION_SUMMARY_METADATA_KEY,
  TASK_SUMMARY_METADATA_KEY,
} from "@ctx/client";
import {
  defaultCapabilityPolicy,
  normalizeContextFilePath,
  type AgentEventEnvelope,
  type CapabilityPolicy,
  type ContextSnapshot,
  type Run,
  type Session,
  type Task,
} from "@ctx/core";
import { InMemoryStore } from "@ctx/testing";
import { renderSnapshotToPromptText } from "../../../adapter-opencode/src/context-render";
import { CallRecorder } from "../harness/call-recorder";
import { detectWastedCalls } from "../harness/dedup-detector";
import { scoreCompletionForFixture } from "../results/completion-score";
import type {
  BenchmarkMode,
  BenchmarkRoundDiagnostics,
  BenchmarkRunResult,
  CompletionScore,
  FairnessCheck,
  MetricSpread,
  ToolUseRecord,
} from "../results/schema";
import {
  createOpenCodePlatformHost,
  launchOpenCodeRun,
  registerOpenCodeCliAdapter,
  resolveOpenCodeExecution,
  type OpenCodeTransport,
} from "./opencode-runtime-launch";
import { copyFixtureToTemp, prepareBaselineConfigOverlay } from "./opencode-run-env";
import { collectEventsWithTimeout } from "./run-event-timeout";
import { WARM_BENCHMARK_ROUNDS, type WarmBenchmarkRoundDefinition } from "./warm-round-defs";

const OPENCODE_CMD = "C:\\Users\\zxm\\AppData\\Roaming\\npm\\opencode.cmd";
const FIXTURE_DIR = resolve(process.cwd(), "packages/benchmark/fixtures/minikanban");
const DEFAULT_PASS1_TOO_COMPLETE_THRESHOLD = 70;
const EDIT_TOOL_NAMES = new Set(["edit", "write", "write_file"]);

export type WarmBenchmarkMode = Extract<BenchmarkMode, "baseline" | "platform-context">;

export interface WarmBenchmarkRunResult {
  mode: WarmBenchmarkMode;
  iteration: number;
  pass1: BenchmarkRunResult;
  pass2: BenchmarkRunResult;
  partialCompletionAfterPass1: CompletionScore;
  finalCompletion: CompletionScore;
  pass1TooComplete: boolean;
  seedContext?: WarmSeedContext;
  pass2Trace?: WarmPassTrace;
}

export interface WarmSeedContext {
  recentReadFilePaths: string[];
  recentEditedFilePaths: string[];
  recentCommandPreviews: string[];
  failingTests: string[];
  unresolvedConstraints: string[];
  assistantOutputPreview: string;
}

export interface WarmTraceStepCumulative {
  llmCalls: number;
  inputTokens: number;
  inputTokensWithCache: number;
  outputTokens: number;
  toolCalls: number;
  readCalls: number;
  bashCalls: number;
  editCalls: number;
}

export interface WarmTraceStep {
  step: number;
  round: number;
  timestamp: string;
  kind: "llm" | "tool";
  label: string;
  detail: string;
  purpose?: BenchmarkRunResult["llmCalls"][number]["purpose"];
  toolName?: string;
  targetPath?: string;
  guidanceTag?: WarmGuidanceTag;
  inputTokens?: number;
  inputTokensWithCache?: number;
  outputTokens?: number;
  cumulative: WarmTraceStepCumulative;
}

export type WarmGuidanceTag =
  | "task-brief"
  | "from-last-run"
  | "recent-read"
  | "seed-command"
  | "failing-test";

export interface WarmSnapshotBlockSummary {
  blockId: string;
  kind: string;
  title: string;
  sourceRef: string;
  sourceType: string;
  retentionAction: string;
  tokenEstimate: number;
  preview: string;
}

export interface WarmTurnToolAction {
  callId: string;
  toolName: string;
  label: string;
  detail: string;
  inputPreview: string;
  outputPreview?: string;
  targetPath?: string;
  guidanceTag?: WarmGuidanceTag;
  isError: boolean;
}

export interface WarmConversationTurn {
  turn: number;
  round: number;
  timestamp: string;
  purpose: BenchmarkRunResult["llmCalls"][number]["purpose"];
  goal: string;
  inputTokens: number;
  cacheReadInputTokens: number;
  inputTokensWithCache: number;
  outputTokens: number;
  assistantMessagePreview: string;
  toolActions: WarmTurnToolAction[];
}

export interface WarmConversationEvent {
  order: number;
  turn: number;
  round: number;
  timestamp: string;
  kind: "llm" | "tool" | "assistant";
  label: string;
  detail: string;
  purpose?: BenchmarkRunResult["llmCalls"][number]["purpose"];
  toolName?: string;
  targetPath?: string;
  guidanceTag?: WarmGuidanceTag;
  inputTokens?: number;
  cacheReadInputTokens?: number;
  inputTokensWithCache?: number;
  outputTokens?: number;
  inputPreview?: string;
  outputPreview?: string;
  isError?: boolean;
}

export interface WarmRoundTrace {
  round: number;
  purpose: BenchmarkRunResult["llmCalls"][number]["purpose"];
  taskPrompt: string;
  snapshotTokenEstimate: number;
  includedBlockCount: number;
  excludedBlockCount: number;
  promptTextLength: number;
  sourceTypeCounts: Record<string, number>;
  retentionCounts: Record<string, number>;
  renderedPromptPreview: string;
  snapshotBlocks: WarmSnapshotBlockSummary[];
  conversationTurns: WarmConversationTurn[];
  eventTimeline: WarmConversationEvent[];
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  inputTokensWithCache: number;
  outputTokens: number;
}

export interface WarmPassTrace {
  seedContext: WarmSeedContext;
  totalSteps: number;
  firstEditStep?: number;
  stepsBeforeFirstEdit: number;
  steps: WarmTraceStep[];
  rounds: WarmRoundTrace[];
}

export interface WarmBenchmarkModeSummary {
  mode: WarmBenchmarkMode;
  repeatCount: number;
  validIterationCount: number;
  excludedPass1TooCompleteCount: number;
  partialCompletionAfterPass1: MetricSpread;
  finalCompletionScore: MetricSpread;
  pass2InputTokensWithCache: MetricSpread;
  pass2LlmCalls: MetricSpread;
  pass2ToolCalls: MetricSpread;
  pass2ReadToolCalls: MetricSpread;
  pass2RepeatedReadRatio: MetricSpread;
  pass2CallsBeforeFirstEdit: MetricSpread;
}

export interface WarmBenchmarkAnalysis {
  summaries: WarmBenchmarkModeSummary[];
  fairness: Array<{
    left: WarmBenchmarkMode;
    right: WarmBenchmarkMode;
    check: FairnessCheck;
  }>;
}

export interface RunWarmBenchmarkInput {
  repeatCount?: number;
  modes?: WarmBenchmarkMode[];
  binaryPath?: string;
  binaryArgs?: string[];
  agent?: string;
  fixtureDir?: string;
  roundTimeoutMs?: number;
  rounds?: WarmBenchmarkRoundDefinition[];
  transport?: OpenCodeTransport;
  pass1TooCompleteThreshold?: number;
}

export interface RunWarmBenchmarkOutput {
  runs: WarmBenchmarkRunResult[];
  analysis: WarmBenchmarkAnalysis;
}

export async function runWarmBenchmark(input: RunWarmBenchmarkInput = {}): Promise<RunWarmBenchmarkOutput> {
  const repeatCount = input.repeatCount ?? 3;
  const modes = input.modes ?? ["baseline", "platform-context"];
  const runs: WarmBenchmarkRunResult[] = [];

  for (const mode of modes) {
    for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
      runs.push(
        await runWarmBenchmarkIteration(mode, iteration, {
          binaryPath: input.binaryPath ?? OPENCODE_CMD,
          binaryArgs: input.binaryArgs,
          agent: input.agent,
          fixtureDir: input.fixtureDir ?? FIXTURE_DIR,
          roundTimeoutMs: input.roundTimeoutMs ?? 180_000,
          rounds: input.rounds ?? WARM_BENCHMARK_ROUNDS,
          transport: input.transport ?? "cli",
          pass1TooCompleteThreshold: input.pass1TooCompleteThreshold ?? DEFAULT_PASS1_TOO_COMPLETE_THRESHOLD,
        }),
      );
    }
  }

  return {
    runs,
    analysis: analyzeWarmBenchmarkResults(runs),
  };
}

async function runWarmBenchmarkIteration(
  mode: WarmBenchmarkMode,
  iteration: number,
  config: {
    binaryPath: string;
    binaryArgs?: string[];
    agent?: string;
    fixtureDir: string;
    roundTimeoutMs: number;
    rounds: WarmBenchmarkRoundDefinition[];
    transport: OpenCodeTransport;
    pass1TooCompleteThreshold: number;
  },
): Promise<WarmBenchmarkRunResult> {
  const fixtureCopy = await copyFixtureToTemp(config.fixtureDir);
  const baselineOverlay = mode === "baseline" ? await prepareBaselineConfigOverlay() : undefined;
  const store = new InMemoryStore();
  const platform = createContextPlatform({ store });
  registerOpenCodeCliAdapter(platform, {
    binaryPath: config.binaryPath,
    binaryArgs: config.binaryArgs,
    agent: config.agent,
    cwd: fixtureCopy.dir,
    env: baselineOverlay?.env,
  });
  const host = createOpenCodePlatformHost({
    binaryPath: config.binaryPath,
    binaryArgs: config.binaryArgs,
    agent: config.agent,
    cwd: fixtureCopy.dir,
    env: baselineOverlay?.env,
    startupTimeoutMs: Math.min(config.roundTimeoutMs, 15_000),
  });

  try {
    await applyWarmSeedToFixture(fixtureCopy.dir);
    const partialCompletionAfterPass1 = await scoreCompletionForFixture({
      fixtureDir: fixtureCopy.dir,
    });

    const client = platform.client();
    const workspaceId = `ws_warm_benchmark_${mode}_${iteration}`;
    const session = await client.sessions.create({
      workspaceId,
      title: `warm benchmark ${mode} ${iteration}`,
    });
    const task = await client.tasks.create({
      workspaceId,
      sessionId: session.id,
      title: "Warm MiniKanban continuation fixture",
      objective: "Resume the partially completed MiniKanban task and finish the remaining work.",
    });

    const seedContext = seedWarmPlatformState({
      store,
      session,
      task,
      iteration,
    });

    const pass2Result = await runWarmPass({
      platform,
      client,
      host,
      workspaceId,
      sessionId: session.id,
      taskId: task.id,
      mode,
      iteration,
      rounds: config.rounds,
      transport: config.transport,
      roundTimeoutMs: config.roundTimeoutMs,
      seedContext,
    });
    const pass2 = pass2Result.runResult;

    const finalCompletion = await scoreCompletionForFixture({
      fixtureDir: fixtureCopy.dir,
    });
    pass2.completion = finalCompletion;

    return {
      mode,
      iteration,
      pass1: {
        mode,
        iteration,
        llmCalls: [],
        toolCalls: [],
        wastedCalls: [],
        completion: partialCompletionAfterPass1,
        roundDiagnostics: [],
      },
      pass2,
      partialCompletionAfterPass1,
      finalCompletion,
      pass1TooComplete: partialCompletionAfterPass1.total >= config.pass1TooCompleteThreshold,
      seedContext,
      pass2Trace: pass2Result.trace,
    };
  } finally {
    await safeCleanup(baselineOverlay);
    await safeCleanup(fixtureCopy);
  }
}

async function runWarmPass(input: {
  platform: ReturnType<typeof createContextPlatform>;
  client: ReturnType<ReturnType<typeof createContextPlatform>["client"]>;
  host: ReturnType<typeof createOpenCodePlatformHost>;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  mode: WarmBenchmarkMode;
  iteration: number;
  rounds: WarmBenchmarkRoundDefinition[];
  transport: OpenCodeTransport;
  roundTimeoutMs: number;
  seedContext: WarmSeedContext;
}): Promise<{ runResult: BenchmarkRunResult; trace: WarmPassTrace }> {
  const llmCalls: BenchmarkRunResult["llmCalls"] = [];
  const toolCalls: BenchmarkRunResult["toolCalls"] = [];
  const roundDiagnostics: BenchmarkRoundDiagnostics[] = [];
  const roundTraces: WarmRoundTrace[] = [];

  for (const round of input.rounds) {
    const execution = resolveOpenCodeExecution({
      transport: input.transport,
      isBaseline: input.mode === "baseline",
    });
    const capabilityPolicy = buildCapabilityPolicy(input.mode);
    const preview = await input.client.experimental?.context.preview({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      policy: capabilityPolicy,
      adapter: execution.previewAdapter,
      metadata: {
        prompt: buildRealRoundPrompt(round.prompt),
      },
    });
    if (preview) {
      roundDiagnostics.push(buildRoundDiagnostics({
        round: round.round,
        purpose: round.purpose,
        snapshot: preview.snapshot,
      }));
    }

    const recorder = new CallRecorder();
    const handle = await launchOpenCodeRun({
      platform: input.platform,
      client: input.client,
      host: input.host,
      selection: execution,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      capabilityPolicy,
      prompt: buildRealRoundPrompt(round.prompt),
    });

    const roundEvents = await collectEventsWithTimeout(handle, {
      timeoutMs: input.roundTimeoutMs,
      onEvent: async (event) => {
        recorder.record({
          event,
          mode: input.mode,
          round: round.round,
          purpose: round.purpose,
        });
      },
    });

    await assertRunCompleted({
      client: input.client,
      runId: handle.runId,
      mode: input.mode,
      iteration: input.iteration,
      round: round.round,
    });

    const snapshot = recorder.snapshot();
    llmCalls.push(...snapshot.llmCalls);
    toolCalls.push(...snapshot.toolCalls);
    roundTraces.push(buildWarmRoundTrace({
      round: round.round,
      purpose: round.purpose,
      prompt: round.prompt,
      snapshot: preview?.snapshot,
      events: roundEvents,
      mode: input.mode,
      seedContext: input.seedContext,
    }));
  }

  const runResult: BenchmarkRunResult = {
    mode: input.mode,
    iteration: input.iteration,
    llmCalls,
    toolCalls,
    wastedCalls: detectWastedCalls(toolCalls),
    completion: zeroCompletion(),
    roundDiagnostics,
  };

  return {
    runResult,
    trace: buildWarmPassTrace({
      seedContext: input.seedContext,
      roundTraces,
    }),
  };
}

function buildCapabilityPolicy(mode: WarmBenchmarkMode): CapabilityPolicy {
  return mode === "baseline"
    ? defaultCapabilityPolicy
    : { ...defaultCapabilityPolicy, context: "inject" };
}

function seedWarmPlatformState(input: {
  store: InMemoryStore;
  session: Session;
  task: Task;
  iteration: number;
}): WarmSeedContext {
  const now = new Date().toISOString();
  const readFilePaths = ["/README.md", "/SPEC.md", "/pyproject.toml"];
  const editedFilePaths = ["/app/store.py", "/app/routes/boards.py", "/app/routes/tasks.py"];
  const commandPreviews = ["python -m pytest tests/ -q"];
  const repairState = {
    version: "1" as const,
    failingTests: [
      "tests/test_tasks.py::test_duplicate_tags_returns_422",
      "tests/test_boards.py::test_board_stats_count_statuses",
      "tests/test_boards.py::test_delete_board_cascades_tasks",
    ],
    lastTestCommand: "python -m pytest tests/ -q",
    unresolvedConstraints: [
      "AssertionError: duplicate tags should return 422",
      "AssertionError: board stats should count todo/doing/done correctly",
      "AssertionError: deleting a board should cascade-delete its tasks",
    ],
  };
  const failureHints: string[] = [];
  const seedRunId = `run_seed_${input.task.id}_${input.iteration}`;
  const assistantOutputPreview = "Boards CRUD and basic task CRUD are in place. Remaining work: tag validation, filtered task listing, board stats, done-title immutability, and cascade delete.";

  input.store.saveRun({
    id: seedRunId,
    workspaceId: input.task.workspaceId,
    sessionId: input.task.sessionId,
    taskId: input.task.id,
    adapter: "seed",
    status: "completed",
    attempt: 1,
    startedAt: now,
    endedAt: now,
    metadata: {
      [RUN_SUMMARY_METADATA_KEY]: {
        version: "1",
        generatedAt: now,
        status: "completed",
        completionReason: "seeded pass1 snapshot",
        messageCount: 1,
        toolCallCount: 3,
        indexedToolCallCount: 0,
        readFilePaths,
        editedFilePaths,
        commandPreviews,
        repairState,
        failureHints,
        assistantOutputPreview,
        summaryText: `Run ${seedRunId} completed; tool calls: 3; indexed tool refs: 0; read files: ${readFilePaths.join(", ")}; edited files: ${editedFilePaths.join(", ")}; commands: ${commandPreviews.join(" | ")}; failing tests: ${repairState.failingTests.join(", ")}; last failing command: ${repairState.lastTestCommand}; unresolved constraints: ${repairState.unresolvedConstraints.join(" | ")}; assistant output: ${assistantOutputPreview}`,
      },
    },
  });

  input.store.saveTask({
    ...input.task,
    status: "running",
    updatedAt: now,
    metadata: {
      ...(input.task.metadata ?? {}),
      [TASK_SUMMARY_METADATA_KEY]: {
        version: "1",
        generatedAt: now,
        taskStatus: "running",
        runCount: 1,
        completedRunCount: 1,
        failedRunCount: 0,
        cancelledRunCount: 0,
        indexedToolCallCount: 0,
        latestRunIds: [seedRunId],
        recentReadFilePaths: readFilePaths,
        recentEditedFilePaths: editedFilePaths,
        recentCommandPreviews: commandPreviews,
        repairState,
        recentFailureHints: failureHints,
        latestAssistantOutputPreview: assistantOutputPreview,
        summaryText: `Task ${input.task.id} running; runs: 1; completed: 1; runs with summaries: 1; recent reads: ${readFilePaths.join(", ")}; recent edits: ${editedFilePaths.join(", ")}; recent commands: ${commandPreviews.join(" | ")}; failing tests: ${repairState.failingTests.join(", ")}; last failing command: ${repairState.lastTestCommand}; unresolved constraints: ${repairState.unresolvedConstraints.join(" | ")}; latest progress: ${assistantOutputPreview}`,
      },
    },
  });

  input.store.saveSession({
    ...input.session,
    updatedAt: now,
    metadata: {
      ...(input.session.metadata ?? {}),
      [SESSION_SUMMARY_METADATA_KEY]: {
        version: "1",
        generatedAt: now,
        sessionStatus: "active",
        taskCount: 1,
        completedTaskCount: 0,
        failedTaskCount: 0,
        cancelledTaskCount: 0,
        runCount: 1,
        completedRunCount: 1,
        failedRunCount: 0,
        cancelledRunCount: 0,
        latestTaskIds: [input.task.id],
        latestRunIds: [seedRunId],
        summaryText: `Session ${input.session.id} active; tasks: 1; runs: 1; tracked tasks: 1`,
      },
    },
  });

  return {
    recentReadFilePaths: readFilePaths,
    recentEditedFilePaths: editedFilePaths,
    recentCommandPreviews: commandPreviews,
    failingTests: [...repairState.failingTests],
    unresolvedConstraints: [...repairState.unresolvedConstraints],
    assistantOutputPreview,
  };
}

async function applyWarmSeedToFixture(fixtureDir: string): Promise<void> {
  await writeFile(resolve(fixtureDir, "app", "store.py"), SEEDED_STORE_PY, "utf8");
  await writeFile(resolve(fixtureDir, "app", "routes", "boards.py"), SEEDED_BOARDS_PY, "utf8");
  await writeFile(resolve(fixtureDir, "app", "routes", "tasks.py"), SEEDED_TASKS_PY, "utf8");
}

function buildRoundDiagnostics(input: {
  round: number;
  purpose: BenchmarkRoundDiagnostics["purpose"];
  snapshot: ContextSnapshot;
}): BenchmarkRoundDiagnostics {
  const sourceTypeCounts: Record<string, number> = {};
  const retentionCounts: Record<string, number> = {};

  for (const block of input.snapshot.blocks) {
    const sourceType = typeof block.metadata?.["sourceType"] === "string"
      ? String(block.metadata["sourceType"])
      : "unknown";
    const retention = typeof block.metadata?.["retentionAction"] === "string"
      ? String(block.metadata["retentionAction"])
      : "expand";
    sourceTypeCounts[sourceType] = (sourceTypeCounts[sourceType] ?? 0) + 1;
    retentionCounts[retention] = (retentionCounts[retention] ?? 0) + 1;
  }

  return {
    round: input.round,
    purpose: input.purpose,
    snapshotTokenEstimate: input.snapshot.tokenEstimate,
    includedBlockCount: input.snapshot.blocks.length,
    excludedBlockCount: input.snapshot.explanation?.excluded.length ?? 0,
    promptTextLength: renderSnapshotToPromptText(input.snapshot).length,
    sourceTypeCounts,
    retentionCounts,
  };
}

function buildWarmRoundTrace(input: {
  round: number;
  purpose: BenchmarkRunResult["llmCalls"][number]["purpose"];
  prompt: string;
  snapshot?: ContextSnapshot;
  events: AgentEventEnvelope[];
  mode: WarmBenchmarkMode;
  seedContext: WarmSeedContext;
}): WarmRoundTrace {
  const diagnostics = input.snapshot
    ? buildRoundDiagnostics({
      round: input.round,
      purpose: input.purpose,
      snapshot: input.snapshot,
    })
    : {
      round: input.round,
      purpose: input.purpose,
      snapshotTokenEstimate: 0,
      includedBlockCount: 0,
      excludedBlockCount: 0,
      promptTextLength: 0,
      sourceTypeCounts: {},
      retentionCounts: {},
    };
  const renderedPromptPreview = input.snapshot
    ? compactText(renderSnapshotToPromptText(input.snapshot), 420)
    : "";
  const conversation = buildWarmConversationTrace({
    round: input.round,
    purpose: input.purpose,
    events: input.events,
    mode: input.mode,
    seedContext: input.seedContext,
  });
  return {
    ...diagnostics,
    taskPrompt: input.prompt,
    renderedPromptPreview,
    snapshotBlocks: (input.snapshot?.blocks ?? []).map((block) => ({
      blockId: block.id,
      kind: block.kind,
      title: block.title ?? "Untitled block",
      sourceRef: block.sourceRef,
      sourceType: typeof block.metadata?.["sourceType"] === "string" ? String(block.metadata["sourceType"]) : "unknown",
      retentionAction: typeof block.metadata?.["retentionAction"] === "string" ? String(block.metadata["retentionAction"]) : "expand",
      tokenEstimate: block.tokenEstimate ?? 0,
      preview: compactText(block.content, 120),
    })),
    conversationTurns: conversation.turns,
    eventTimeline: conversation.eventTimeline,
    llmCalls: conversation.totals.llmCalls,
    toolCalls: conversation.totals.toolCalls,
    inputTokens: conversation.totals.inputTokens,
    inputTokensWithCache: conversation.totals.inputTokensWithCache,
    outputTokens: conversation.totals.outputTokens,
  };
}

function buildWarmPassTrace(input: {
  seedContext: WarmSeedContext;
  roundTraces: WarmRoundTrace[];
}): WarmPassTrace {
  const cumulative: WarmTraceStepCumulative = {
    llmCalls: 0,
    inputTokens: 0,
    inputTokensWithCache: 0,
    outputTokens: 0,
    toolCalls: 0,
    readCalls: 0,
    bashCalls: 0,
    editCalls: 0,
  };

  const orderedEvents = [...input.roundTraces]
    .sort((left, right) => left.round - right.round)
    .flatMap((round) => round.eventTimeline);

  const steps: WarmTraceStep[] = orderedEvents
    .filter((event): event is WarmConversationEvent & { kind: "llm" | "tool" } => event.kind === "llm" || event.kind === "tool")
    .map((event, index) => {
    if (event.kind === "llm") {
      cumulative.llmCalls += 1;
      cumulative.inputTokens += event.inputTokens ?? 0;
      cumulative.inputTokensWithCache += event.inputTokensWithCache ?? 0;
      cumulative.outputTokens += event.outputTokens ?? 0;
    } else {
      cumulative.toolCalls += 1;
      if (event.toolName === "read") {
        cumulative.readCalls += 1;
      }
      if (event.toolName === "bash") {
        cumulative.bashCalls += 1;
      }
      if (EDIT_TOOL_NAMES.has(event.toolName ?? "")) {
        cumulative.editCalls += 1;
      }
    }

    return {
      step: index + 1,
      round: event.round,
      timestamp: event.timestamp,
      kind: event.kind,
      label: event.label,
      detail: event.detail,
      purpose: event.kind === "llm" ? event.purpose : undefined,
      toolName: event.kind === "tool" ? event.toolName : undefined,
      targetPath: event.kind === "tool" ? event.targetPath : undefined,
      guidanceTag: event.kind === "tool" ? event.guidanceTag : undefined,
      inputTokens: event.kind === "llm" ? event.inputTokens : undefined,
      inputTokensWithCache: event.kind === "llm" ? event.inputTokensWithCache : undefined,
      outputTokens: event.kind === "llm" ? event.outputTokens : undefined,
      cumulative: { ...cumulative },
    };
    });

  const firstEditStep = steps.find((step) => EDIT_TOOL_NAMES.has(step.toolName ?? ""))?.step;

  return {
    seedContext: input.seedContext,
    totalSteps: steps.length,
    firstEditStep,
    stepsBeforeFirstEdit: typeof firstEditStep === "number" ? Math.max(0, firstEditStep - 1) : steps.length,
    steps,
    rounds: [...input.roundTraces].sort((left, right) => left.round - right.round),
  };
}

function buildWarmToolLabel(call: ToolUseRecord): string {
  return buildWarmToolLabelFromParts(call.toolName, parseJsonRecord(call.inputSignature));
}

function buildWarmToolDetail(call: ToolUseRecord): string {
  return buildWarmToolDetailFromParts(call.toolName, parseJsonRecord(call.inputSignature), call.inputSignature);
}

function classifyWarmGuidance(
  call: ToolUseRecord,
  seedContext: WarmSeedContext,
): WarmTraceStep["guidanceTag"] | undefined {
  return classifyWarmGuidanceFromParts(call.toolName, parseJsonRecord(call.inputSignature), seedContext);
}

function classifyWarmGuidanceFromParts(
  toolName: string,
  input: Record<string, unknown>,
  seedContext: WarmSeedContext,
): WarmGuidanceTag | undefined {
  if (toolName === "bash") {
    const command = firstString(input.command, input.description);
    if (typeof command === "string" && seedContext.recentCommandPreviews.some((preview) => command.includes(preview))) {
      return "seed-command";
    }
  }

  const targetPath = readTargetFromInput(input);
  if (targetPath.length === 0) {
    return undefined;
  }
  if (seedContext.failingTests.some((testId) => `/${testId.split("::")[0]?.replace(/\\/g, "/")}` === targetPath)) {
    return "failing-test";
  }
  if (targetPath === "/SPEC.md") {
    return "task-brief";
  }
  if (seedContext.recentEditedFilePaths.includes(targetPath)) {
    return "from-last-run";
  }
  if (seedContext.recentReadFilePaths.includes(targetPath)) {
    return "recent-read";
  }
  return undefined;
}

function buildWarmConversationTrace(input: {
  round: number;
  purpose: BenchmarkRunResult["llmCalls"][number]["purpose"];
  events: AgentEventEnvelope[];
  mode: WarmBenchmarkMode;
  seedContext: WarmSeedContext;
}): {
  turns: WarmConversationTurn[];
  eventTimeline: WarmConversationEvent[];
  totals: Pick<WarmRoundTrace, "llmCalls" | "toolCalls" | "inputTokens" | "inputTokensWithCache" | "outputTokens">;
} {
  interface WorkingTurn {
    turn: number;
    round: number;
    timestamp: string;
    purpose: BenchmarkRunResult["llmCalls"][number]["purpose"];
    usageSeen: boolean;
    inputTokens: number;
    cacheReadInputTokens: number;
    inputTokensWithCache: number;
    outputTokens: number;
    assistantChunks: string[];
    toolActions: WarmTurnToolAction[];
  }

  const turns: WarmConversationTurn[] = [];
  const eventTimeline: WarmConversationEvent[] = [];
  const toolActionIndex = new Map<string, WarmTurnToolAction>();
  const toolEventIndex = new Map<string, WarmConversationEvent>();
  const totals = {
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    inputTokensWithCache: 0,
    outputTokens: 0,
  };
  let currentTurn: WorkingTurn | null = null;

  const ensureTurn = (timestamp: string): WorkingTurn => {
    if (!currentTurn) {
      currentTurn = {
        turn: turns.length + 1,
        round: input.round,
        timestamp,
        purpose: input.purpose,
        usageSeen: false,
        inputTokens: 0,
        cacheReadInputTokens: 0,
        inputTokensWithCache: 0,
        outputTokens: 0,
        assistantChunks: [],
        toolActions: [],
      };
    }
    return currentTurn;
  };

  const appendEvent = (event: Omit<WarmConversationEvent, "order">): WarmConversationEvent => {
    const nextEvent = {
      order: eventTimeline.length + 1,
      ...event,
    };
    eventTimeline.push(nextEvent);
    return nextEvent;
  };

  const hasOpenUsageTurn = (): boolean => Boolean(currentTurn?.usageSeen);

  const finalizeTurn = (): void => {
    if (!currentTurn) {
      return;
    }
    const assistantMessagePreview = compactText(currentTurn.assistantChunks.join(""), 280);
    if (assistantMessagePreview.length > 0) {
      appendEvent({
        turn: currentTurn.turn,
        round: input.round,
        timestamp: currentTurn.timestamp,
        kind: "assistant",
        label: "Assistant output",
        detail: assistantMessagePreview,
      });
    }
    turns.push({
      turn: currentTurn.turn,
      round: input.round,
      timestamp: currentTurn.timestamp,
      purpose: currentTurn.purpose,
      goal: inferWarmTurnGoal({
        toolActions: currentTurn.toolActions,
        assistantMessagePreview,
      }),
      inputTokens: currentTurn.inputTokens,
      cacheReadInputTokens: currentTurn.cacheReadInputTokens,
      inputTokensWithCache: currentTurn.inputTokensWithCache,
      outputTokens: currentTurn.outputTokens,
      assistantMessagePreview,
      toolActions: currentTurn.toolActions.map((action) => ({ ...action })),
    });
    currentTurn = null;
  };

  for (const event of input.events) {
    if (event.type === "run.usage") {
      if (hasOpenUsageTurn()) {
        finalizeTurn();
      }
      const turn = ensureTurn(event.timestamp);
      const usage = event.payload as {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
      };
      turn.usageSeen = true;
      turn.timestamp = event.timestamp;
      turn.inputTokens = usage.inputTokens ?? 0;
      turn.cacheReadInputTokens = usage.cacheReadInputTokens ?? 0;
      turn.inputTokensWithCache = turn.inputTokens + turn.cacheReadInputTokens;
      turn.outputTokens = usage.outputTokens ?? 0;

      totals.llmCalls += 1;
      totals.inputTokens += turn.inputTokens;
      totals.inputTokensWithCache += turn.inputTokensWithCache;
      totals.outputTokens += turn.outputTokens;

      appendEvent({
        turn: turn.turn,
        round: input.round,
        timestamp: event.timestamp,
        kind: "llm",
        label: `${input.purpose.toUpperCase()} send`,
        detail: `${turn.inputTokens.toLocaleString()} input | ${turn.inputTokensWithCache.toLocaleString()} input+cache | ${turn.outputTokens.toLocaleString()} output`,
        purpose: input.purpose,
        inputTokens: turn.inputTokens,
        cacheReadInputTokens: turn.cacheReadInputTokens,
        inputTokensWithCache: turn.inputTokensWithCache,
        outputTokens: turn.outputTokens,
      });
      continue;
    }

    if (event.type === "tool.call") {
      const payload = event.payload as { callId?: unknown; name?: unknown; input?: unknown };
      const toolName = typeof payload.name === "string" ? payload.name : "unknown_tool";
      const toolInput = payload.input && typeof payload.input === "object" ? payload.input as Record<string, unknown> : {};
      const callId = typeof payload.callId === "string" ? payload.callId : event.id;
      const guidanceTag = input.mode === "platform-context"
        ? classifyWarmGuidanceFromParts(toolName, toolInput, input.seedContext)
        : undefined;
      const targetPath = readTargetFromInput(toolInput);
      const turn = ensureTurn(event.timestamp);
      const action: WarmTurnToolAction = {
        callId,
        toolName,
        label: buildWarmToolLabelFromParts(toolName, toolInput),
        detail: buildWarmToolDetailFromParts(toolName, toolInput),
        inputPreview: compactText(stableJson(toolInput), 160),
        outputPreview: undefined,
        targetPath: targetPath.length > 0 ? targetPath : undefined,
        guidanceTag,
        isError: false,
      };
      turn.toolActions.push(action);
      toolActionIndex.set(callId, action);
      totals.toolCalls += 1;

      const toolEvent = appendEvent({
        turn: turn.turn,
        round: input.round,
        timestamp: event.timestamp,
        kind: "tool",
        label: action.label,
        detail: action.detail,
        toolName,
        targetPath: action.targetPath,
        guidanceTag,
        inputPreview: action.inputPreview,
        outputPreview: undefined,
        isError: false,
      });
      toolEventIndex.set(callId, toolEvent);
      continue;
    }

    if (event.type === "tool.result") {
      const payload = event.payload as { callId?: unknown; output?: unknown; isError?: unknown };
      const callId = typeof payload.callId === "string" ? payload.callId : "";
      if (callId.length === 0) {
        continue;
      }
      const outputPreview = previewWarmValue(payload.output);
      const isError = payload.isError === true;
      const action = toolActionIndex.get(callId);
      if (action) {
        action.outputPreview = outputPreview || undefined;
        action.isError = isError;
      }
      const timelineEvent = toolEventIndex.get(callId);
      if (timelineEvent) {
        timelineEvent.outputPreview = outputPreview || undefined;
        timelineEvent.isError = isError;
      }
      continue;
    }

    if (event.type === "message.delta") {
      const payload = event.payload as { text?: unknown };
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text.length > 0) {
        ensureTurn(event.timestamp).assistantChunks.push(text);
      }
    }
  }

  finalizeTurn();
  return { turns, eventTimeline, totals };
}

function inferWarmTurnGoal(input: {
  toolActions: WarmTurnToolAction[];
  assistantMessagePreview: string;
}): string {
  const firstAction = input.toolActions[0];
  if (!firstAction) {
    return input.assistantMessagePreview.length > 0 ? "Report progress" : "Advance the round";
  }
  if (firstAction.toolName === "read") {
    if (firstAction.guidanceTag === "failing-test") {
      return `Inspect failing test ${firstAction.targetPath ?? ""}`.trim();
    }
    if (firstAction.guidanceTag === "from-last-run") {
      return `Reopen last edited file ${firstAction.targetPath ?? ""}`.trim();
    }
    if (firstAction.guidanceTag === "task-brief") {
      return "Refresh the task brief";
    }
    return `Read ${firstAction.targetPath ?? "relevant file"}`;
  }
  if (EDIT_TOOL_NAMES.has(firstAction.toolName)) {
    return `Patch ${firstAction.targetPath ?? "target file"}`;
  }
  if (firstAction.toolName === "bash") {
    return "Run validation checks";
  }
  if (firstAction.toolName === "glob") {
    return "Search the codebase";
  }
  if (firstAction.toolName === "todowrite") {
    return "Refresh the implementation plan";
  }
  return "Advance the round";
}

function buildWarmToolLabelFromParts(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "read") {
    const path = readTargetFromInput(input);
    return path.length > 0 ? `Read ${path}` : "Read";
  }
  if (toolName === "bash") {
    return "Run test or shell command";
  }
  if (toolName === "glob") {
    return "Search matching files";
  }
  if (toolName === "todowrite") {
    return "Refresh todo plan";
  }
  if (EDIT_TOOL_NAMES.has(toolName)) {
    const path = readTargetFromInput(input);
    return path.length > 0 ? `Edit ${path}` : "Edit file";
  }
  return toolName;
}

function buildWarmToolDetailFromParts(
  toolName: string,
  input: Record<string, unknown>,
  fallback?: string,
): string {
  if (toolName === "bash") {
    return firstString(input.description, input.command, "shell command") ?? "shell command";
  }
  if (toolName === "glob") {
    return firstString(input.pattern, "pattern lookup") ?? "pattern lookup";
  }
  if (toolName === "todowrite") {
    return "task plan updated";
  }
  const targetPath = readTargetFromInput(input);
  if (targetPath.length > 0) {
    return targetPath;
  }
  return compactText(fallback ?? stableJson(input), 96);
}

function previewWarmValue(value: unknown): string {
  if (typeof value === "string") {
    return compactText(value, 180);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!value) {
    return "";
  }
  try {
    return compactText(JSON.stringify(value), 180);
  } catch {
    return "";
  }
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}

function compactText(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function zeroCompletion(): CompletionScore {
  return {
    total: 0,
    publicTestsPassed: 0,
    publicTestsTotal: 0,
    hiddenTestsPassed: 0,
    hiddenTestsTotal: 0,
    codeQualityPoints: 0,
    deliveryPoints: 0,
    processPoints: 0,
  };
}

export function analyzeWarmBenchmarkResults(results: WarmBenchmarkRunResult[]): WarmBenchmarkAnalysis {
  const grouped = groupWarmRunsByMode(results);
  const summaries = Object.entries(grouped).map(([mode, runs]) => summarizeWarmMode(mode as WarmBenchmarkMode, runs));
  const fairness = buildWarmFairnessChecks(grouped);
  return { summaries, fairness };
}

function summarizeWarmMode(mode: WarmBenchmarkMode, runs: WarmBenchmarkRunResult[]): WarmBenchmarkModeSummary {
  const validRuns = runs.filter((run) => !run.pass1TooComplete);
  return {
    mode,
    repeatCount: runs.length,
    validIterationCount: validRuns.length,
    excludedPass1TooCompleteCount: runs.length - validRuns.length,
    partialCompletionAfterPass1: spread(runs.map((run) => run.partialCompletionAfterPass1.total)),
    finalCompletionScore: spread(validRuns.map((run) => run.finalCompletion.total)),
    pass2InputTokensWithCache: spread(validRuns.map((run) => sum(run.pass2.llmCalls.map((call) => call.inputTokens + (call.cacheReadInputTokens ?? 0))))),
    pass2LlmCalls: spread(validRuns.map((run) => run.pass2.llmCalls.length)),
    pass2ToolCalls: spread(validRuns.map((run) => run.pass2.toolCalls.length)),
    pass2ReadToolCalls: spread(validRuns.map((run) => run.pass2.toolCalls.filter((call) => call.toolName === "read").length)),
    pass2RepeatedReadRatio: spread(validRuns.map((run) => calculateRepeatedReadCallRatio(run.pass2.toolCalls))),
    pass2CallsBeforeFirstEdit: spread(validRuns.map((run) => countCallsBeforeFirstEdit(run.pass2))),
  };
}

function buildWarmFairnessChecks(grouped: Record<string, WarmBenchmarkRunResult[]>): WarmBenchmarkAnalysis["fairness"] {
  const leftRuns = (grouped.baseline ?? []).filter((run) => !run.pass1TooComplete);
  const rightRuns = (grouped["platform-context"] ?? []).filter((run) => !run.pass1TooComplete);
  if (leftRuns.length === 0 || rightRuns.length === 0) {
    return [];
  }

  return [
    {
      left: "baseline" as const,
      right: "platform-context" as const,
      check: checkWarmFairness(leftRuns, rightRuns),
    },
  ];
}

function checkWarmFairness(leftRuns: WarmBenchmarkRunResult[], rightRuns: WarmBenchmarkRunResult[]): FairnessCheck {
  const hiddenTestPassDelta = Math.abs(
    median(leftRuns.map((run) => run.finalCompletion.hiddenTestsPassed)) -
      median(rightRuns.map((run) => run.finalCompletion.hiddenTestsPassed)),
  );
  const completionScoreDelta = Math.abs(
    median(leftRuns.map((run) => run.finalCompletion.total)) -
      median(rightRuns.map((run) => run.finalCompletion.total)),
  );
  const reasons: string[] = [];

  if (hiddenTestPassDelta > 1) {
    reasons.push("hidden test pass delta exceeds 1");
  }
  if (completionScoreDelta > 5) {
    reasons.push("completion score delta exceeds 5");
  }

  return {
    valid: reasons.length === 0,
    hiddenTestPassDelta,
    completionScoreDelta,
    reasons,
  };
}

export function formatWarmBenchmarkReport(output: RunWarmBenchmarkOutput): string {
  const lines: string[] = [];
  lines.push("Mode | Repeats | Valid | Excluded | Pass2 Input+Cache | Pass2 LLM Calls | Pass2 Tool Calls | Pass2 Read Calls | Pass2 Repeat Read Ratio | Calls Before First Edit | Final Completion");
  lines.push("--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---");

  for (const summary of output.analysis.summaries) {
    lines.push([
      summary.mode,
      String(summary.repeatCount),
      String(summary.validIterationCount),
      String(summary.excludedPass1TooCompleteCount),
      formatSpread(summary.pass2InputTokensWithCache),
      formatSpread(summary.pass2LlmCalls),
      formatSpread(summary.pass2ToolCalls),
      formatSpread(summary.pass2ReadToolCalls),
      formatSpread(summary.pass2RepeatedReadRatio),
      formatSpread(summary.pass2CallsBeforeFirstEdit),
      formatSpread(summary.finalCompletionScore),
    ].join(" | "));
  }

  lines.push("");
  lines.push("Seed sanity:");
  lines.push("Mode | Seed Completion Before Pass2");
  lines.push("--- | ---");
  for (const summary of output.analysis.summaries) {
    lines.push([
      summary.mode,
      formatSpread(summary.partialCompletionAfterPass1),
    ].join(" | "));
  }

  if (output.analysis.fairness.length > 0) {
    lines.push("");
    lines.push("Fairness checks:");
    for (const item of output.analysis.fairness) {
      lines.push(
        `- ${item.left} vs ${item.right}: ${item.check.valid ? "valid" : "invalid"} (hidden delta=${item.check.hiddenTestPassDelta}, score delta=${item.check.completionScoreDelta})`,
      );
    }
  }

  return lines.join("\n");
}

export function stringifyWarmBenchmarkReport(output: RunWarmBenchmarkOutput): string {
  return JSON.stringify(output, null, 2);
}

function countCallsBeforeFirstEdit(run: BenchmarkRunResult): number {
  const firstEditTimestamp = run.toolCalls
    .filter((call) => EDIT_TOOL_NAMES.has(call.toolName))
    .map((call) => Date.parse(call.timestamp))
    .filter((value) => !Number.isNaN(value))
    .sort((left, right) => left - right)[0];

  if (typeof firstEditTimestamp !== "number") {
    return run.llmCalls.length + run.toolCalls.length;
  }

  const llmCount = run.llmCalls.filter((call) => Date.parse(call.timestamp) < firstEditTimestamp).length;
  const toolCount = run.toolCalls.filter((call) => Date.parse(call.timestamp) < firstEditTimestamp).length;
  return llmCount + toolCount;
}

function calculateRepeatedReadCallRatio(toolCalls: ToolUseRecord[]): number {
  const readTargets = toolCalls
    .filter((call) => call.toolName === "read")
    .map((call) => readTargetFromSignature(call.inputSignature))
    .filter((value): value is string => value.length > 0);

  if (readTargets.length === 0) {
    return 0;
  }

  return (readTargets.length - new Set(readTargets).size) / readTargets.length;
}

function readTargetFromSignature(inputSignature: string): string {
  return readTargetFromInput(parseJsonRecord(inputSignature));
}

function readTargetFromInput(input: Record<string, unknown>): string {
  const rawPath = firstString(input.filePath, input.path, input.file, input.pathname);
  return rawPath ? normalizeContextFilePath(rawPath) : "";
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function groupWarmRunsByMode(results: WarmBenchmarkRunResult[]): Record<string, WarmBenchmarkRunResult[]> {
  const grouped: Record<string, WarmBenchmarkRunResult[]> = {};
  for (const result of results) {
    grouped[result.mode] ??= [];
    grouped[result.mode].push(result);
  }
  return grouped;
}

function buildRealRoundPrompt(prompt: string): string {
  if (prompt.startsWith("[RAW]\n")) {
    return prompt.slice("[RAW]\n".length);
  }
  return [
    "You are resuming work inside the MiniKanban benchmark fixture in the current workspace.",
    "Modify files directly in the repository as needed.",
    "Do not ask clarifying questions.",
    "Be concise and continue the implementation.",
    prompt,
  ].join("\n\n");
}

async function assertRunCompleted(input: {
  client: ReturnType<ReturnType<typeof createContextPlatform>["client"]>;
  runId: string;
  mode: string;
  iteration: number;
  round: number;
}): Promise<void> {
  const run = await input.client.runs.get(input.runId);
  if (run.status === "completed") {
    return;
  }

  const reason = run.error ? `${run.error.code}: ${run.error.message}` : `status=${run.status}`;
  throw new Error(`warm benchmark run failed for mode=${input.mode} iteration=${input.iteration} round=${input.round}: ${reason}`);
}

async function safeCleanup(resource?: { cleanup(): Promise<void> }): Promise<void> {
  if (!resource) {
    return;
  }
  try {
    await resource.cleanup();
  } catch {
    // Ignore temporary cleanup failures for local benchmark runs.
  }
}

function spread(values: number[]): MetricSpread {
  return {
    median: median(values),
    p25: percentile(values, 0.25),
    p75: percentile(values, 0.75),
  };
}

function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * percentileValue)));
  return sorted[index];
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatSpread(spreadValue: MetricSpread): string {
  return `${round(spreadValue.median)} [${round(spreadValue.p25)}-${round(spreadValue.p75)}]`;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

const SEEDED_STORE_PY = `from __future__ import annotations

from app.models import Board, Task


class InMemoryStore:
    def __init__(self) -> None:
        self.boards: dict[int, Board] = {}
        self.tasks: dict[int, Task] = {}
        self._board_seq = 1
        self._task_seq = 1

    def create_board(self, name: str) -> Board:
        board = Board(id=self._board_seq, name=name)
        self.boards[board.id] = board
        self._board_seq += 1
        return board

    def get_board(self, board_id: int) -> Board | None:
        return self.boards.get(board_id)

    def delete_board(self, board_id: int) -> bool:
        if board_id not in self.boards:
            return False
        del self.boards[board_id]
        return True

    def create_task(self, board_id: int, title: str, status: str = "todo", tags: list[str] | None = None) -> Task:
        task = Task(
            id=self._task_seq,
            board_id=board_id,
            title=title,
            status=status,
            tags=list(tags or []),
        )
        self.tasks[task.id] = task
        self._task_seq += 1
        return task

    def get_task(self, task_id: int) -> Task | None:
        return self.tasks.get(task_id)

    def list_tasks(self, board_id: int, tag: str | None = None) -> list[Task]:
        return [task for task in self.tasks.values() if task.board_id == board_id]

    def update_task(
        self,
        task_id: int,
        *,
        title: str | None = None,
        status: str | None = None,
        tags: list[str] | None = None,
    ) -> Task | None:
        task = self.tasks.get(task_id)
        if not task:
            return None
        if title is not None:
            task.title = title
        if status is not None:
            task.status = status
        if tags is not None:
            task.tags = list(tags)
        self.tasks[task_id] = task
        return task

    def delete_task(self, task_id: int) -> bool:
        if task_id not in self.tasks:
            return False
        del self.tasks[task_id]
        return True

    def board_stats(self, board_id: int) -> dict[str, int]:
        return {"todo": 0, "doing": 0, "done": 0}
`;

const SEEDED_BOARDS_PY = `from fastapi import APIRouter, HTTPException

from app.schemas import BoardResponse, CreateBoardRequest, StatsResponse, TaskResponse
from app.store import InMemoryStore


def build_board_router(store: InMemoryStore) -> APIRouter:
    router = APIRouter()

    @router.post("/boards", response_model=BoardResponse)
    def create_board(request: CreateBoardRequest) -> BoardResponse:
        board = store.create_board(request.name)
        return BoardResponse.model_validate(board.model_dump())

    @router.get("/boards/{board_id}", response_model=BoardResponse)
    def get_board(board_id: int) -> BoardResponse:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        return BoardResponse.model_validate(board.model_dump())

    @router.delete("/boards/{board_id}")
    def delete_board(board_id: int) -> dict[str, bool]:
        deleted = store.delete_board(board_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="board not found")
        return {"ok": True}

    @router.get("/boards/{board_id}/tasks", response_model=list[TaskResponse])
    def list_tasks(board_id: int, tag: str | None = None) -> list[TaskResponse]:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        return [TaskResponse.model_validate(task.model_dump()) for task in store.list_tasks(board_id, tag=tag)]

    @router.get("/boards/{board_id}/stats", response_model=StatsResponse)
    def board_stats(board_id: int) -> StatsResponse:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        return StatsResponse.model_validate(store.board_stats(board_id))

    return router
`;

const SEEDED_TASKS_PY = `from fastapi import APIRouter, HTTPException

from app.schemas import CreateTaskRequest, TaskResponse, UpdateTaskRequest
from app.store import InMemoryStore


VALID_STATUSES = {"todo", "doing", "done"}
MAX_TAGS = 5


def _validate_tags(tags: list[str]) -> None:
    if len(tags) > MAX_TAGS:
        raise HTTPException(status_code=422, detail="too many tags")
    if len(set(tags)) != len(tags):
        raise HTTPException(status_code=422, detail="duplicate tags")


def build_task_router(store: InMemoryStore) -> APIRouter:
    router = APIRouter()

    @router.post("/boards/{board_id}/tasks", response_model=TaskResponse)
    def create_task(board_id: int, request: CreateTaskRequest) -> TaskResponse:
        board = store.get_board(board_id)
        if not board:
            raise HTTPException(status_code=404, detail="board not found")
        if request.status not in VALID_STATUSES:
            raise HTTPException(status_code=422, detail="invalid status")
        _validate_tags(request.tags)
        task = store.create_task(board_id, request.title, request.status, request.tags)
        return TaskResponse.model_validate(task.model_dump())

    @router.put("/tasks/{task_id}", response_model=TaskResponse)
    def update_task(task_id: int, request: UpdateTaskRequest) -> TaskResponse:
        current = store.get_task(task_id)
        if not current:
            raise HTTPException(status_code=404, detail="task not found")

        next_title = request.title if request.title is not None else current.title
        next_status = request.status if request.status is not None else current.status
        next_tags = request.tags if request.tags is not None else current.tags

        if next_status not in VALID_STATUSES:
            raise HTTPException(status_code=422, detail="invalid status")

        updated = store.update_task(task_id, title=next_title, status=next_status, tags=next_tags)
        return TaskResponse.model_validate(updated.model_dump())

    @router.delete("/tasks/{task_id}")
    def delete_task(task_id: int) -> dict[str, bool]:
        deleted = store.delete_task(task_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="task not found")
        return {"ok": True}

    return router
`;
