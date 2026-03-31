import { resolve } from "node:path";
import { createContextPlatform } from "@ctx/client";
import { defaultCapabilityPolicy, type CapabilityPolicy, type ContextSnapshot } from "@ctx/core";
import { createInMemoryMemorySubsystem, InMemoryStore } from "@ctx/testing";
import { renderSnapshotToPromptText } from "../../../adapter-opencode/src/context-render";
import { CallRecorder } from "../harness/call-recorder";
import { detectWastedCalls } from "../harness/dedup-detector";
import { tapEventStream } from "../harness/event-stream-tap";
import { analyzeBenchmarkResults } from "../results/analyzer";
import { scoreCompletionForFixture } from "../results/completion-score";
import type { BenchmarkAnalysis, BenchmarkMode, BenchmarkRoundDiagnostics, BenchmarkRunResult } from "../results/schema";
import { BENCHMARK_ROUNDS, type BenchmarkRoundDefinition } from "./round-defs";
import {
  createOpenCodePlatformHost,
  launchOpenCodeRun,
  registerOpenCodeCliAdapter,
  resolveOpenCodeExecution,
  type OpenCodeTransport,
} from "./opencode-runtime-launch";
import { copyFixtureToTemp, prepareBaselineConfigOverlay } from "./opencode-run-env";
import { collectEventsWithTimeout } from "./run-event-timeout";

const OPENCODE_CMD = "C:\\Users\\zxm\\AppData\\Roaming\\npm\\opencode.cmd";
const FIXTURE_DIR = resolve(process.cwd(), "packages/benchmark/fixtures/minikanban");

export interface RunRealBenchmarkInput {
  repeatCount?: number;
  modes?: Array<Extract<BenchmarkMode, "baseline" | "platform-context" | "platform-context-memory-real">>;
  binaryPath?: string;
  binaryArgs?: string[];
  agent?: string;
  fixtureDir?: string;
  roundLimit?: number;
  roundTimeoutMs?: number;
  rounds?: BenchmarkRoundDefinition[];
  transport?: OpenCodeTransport;
}

export interface RunRealBenchmarkOutput {
  runs: BenchmarkRunResult[];
  analysis: BenchmarkAnalysis;
}

export async function runRealBenchmark(input: RunRealBenchmarkInput = {}): Promise<RunRealBenchmarkOutput> {
  const repeatCount = input.repeatCount ?? 1;
  const modes = input.modes ?? ["baseline", "platform-context", "platform-context-memory-real"];
  const runs: BenchmarkRunResult[] = [];

  for (const mode of modes) {
    for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
      runs.push(
        await runRealBenchmarkIteration(mode, iteration, {
          binaryPath: input.binaryPath ?? OPENCODE_CMD,
          binaryArgs: input.binaryArgs,
          agent: input.agent,
          fixtureDir: input.fixtureDir ?? FIXTURE_DIR,
          roundLimit: input.roundLimit,
          roundTimeoutMs: input.roundTimeoutMs ?? 90_000,
          rounds: input.rounds,
          transport: input.transport ?? "cli",
        }),
      );
    }
  }

  return {
    runs,
    analysis: analyzeBenchmarkResults(runs),
  };
}

async function runRealBenchmarkIteration(
  mode: Extract<BenchmarkMode, "baseline" | "platform-context" | "platform-context-memory-real">,
  iteration: number,
  config: {
    binaryPath: string;
    binaryArgs?: string[];
    agent?: string;
    fixtureDir: string;
    roundLimit?: number;
    roundTimeoutMs: number;
    rounds?: BenchmarkRoundDefinition[];
    transport: OpenCodeTransport;
  },
): Promise<BenchmarkRunResult> {
  const fixtureCopy = await copyFixtureToTemp(config.fixtureDir);
  const baselineOverlay = mode === "baseline" ? await prepareBaselineConfigOverlay() : undefined;
  const memorySubsystem = mode === "platform-context-memory-real" ? createInMemoryMemorySubsystem() : undefined;
  const store = new InMemoryStore();
  const platform = createContextPlatform({ store, memory: memorySubsystem });
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
    const client = platform.client();
    const workspaceId = `ws_real_benchmark_${mode}_${iteration}`;
    const session = await client.sessions.create({
      workspaceId,
      title: `real benchmark ${mode} ${iteration}`,
    });
    const task = await client.tasks.create({
      workspaceId,
      sessionId: session.id,
      title: "Implement MiniKanban fixture",
      objective: "Complete the MiniKanban FastAPI fixture to satisfy the benchmark test suite.",
    });

    const sourceRounds = config.rounds ?? BENCHMARK_ROUNDS;
    const rounds = config.roundLimit ? sourceRounds.slice(0, config.roundLimit) : sourceRounds;
    const recorder = new CallRecorder();
    const roundDiagnostics: BenchmarkRoundDiagnostics[] = [];

    for (const round of rounds) {
      const execution = resolveOpenCodeExecution({
        transport: config.transport,
        isBaseline: mode === "baseline",
      });
      const isEarlyRound = round.round <= 2;
      const basePolicy: CapabilityPolicy =
        mode === "baseline"
          ? defaultCapabilityPolicy
          : mode === "platform-context"
            ? { ...defaultCapabilityPolicy, context: "inject" }
            : { ...defaultCapabilityPolicy, context: "inject", memory: "platform" };
      const capabilityPolicy: CapabilityPolicy =
        mode !== "baseline" && isEarlyRound
          ? {
              ...basePolicy,
              contextHints: {
                ...basePolicy.contextHints,
                suppressRunSummaries: true,
              },
            }
          : basePolicy;
      const preview = await client.experimental?.context.preview({
        workspaceId,
        sessionId: session.id,
        taskId: task.id,
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
      const handle = await launchOpenCodeRun({
        platform,
        client,
        host,
        selection: execution,
        workspaceId,
        sessionId: session.id,
        taskId: task.id,
        capabilityPolicy,
        prompt: buildRealRoundPrompt(round.prompt),
      });

      await collectEventsWithTimeout(handle, {
        timeoutMs: config.roundTimeoutMs,
        onEvent: async (event) => {
          recorder.record({
            event,
            mode,
            round: round.round,
            purpose: round.purpose,
          });
        },
      });

      await assertRunCompleted({
        client,
        runId: handle.runId,
        mode,
        iteration,
        round: round.round,
      });
    }

    const snapshot = recorder.snapshot();
    const completion = await scoreCompletionForFixture({
      fixtureDir: fixtureCopy.dir,
    });

    return {
      mode,
      iteration,
      llmCalls: snapshot.llmCalls,
      toolCalls: snapshot.toolCalls,
      wastedCalls: detectWastedCalls(snapshot.toolCalls),
      completion,
      roundDiagnostics,
    };
  } finally {
    await safeCleanup(baselineOverlay);
    await safeCleanup(fixtureCopy);
  }
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

function buildRealRoundPrompt(prompt: string): string {
  if (prompt.startsWith("[RAW]\n")) {
    return prompt.slice("[RAW]\n".length);
  }
  return [
    "You are working inside the MiniKanban benchmark fixture in the current workspace.",
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
  throw new Error(`real benchmark run failed for mode=${input.mode} iteration=${input.iteration} round=${input.round}: ${reason}`);
}

async function safeCleanup(resource?: { cleanup(): Promise<void> }): Promise<void> {
  if (!resource) {
    return;
  }
  try {
    await resource.cleanup();
  } catch {
    // Temporary benchmark artifacts may remain on disk on Windows if a child process
    // still briefly holds the fixture directory. Cleanup failures should not hide the
    // benchmark result or the actual run failure.
  }
}
