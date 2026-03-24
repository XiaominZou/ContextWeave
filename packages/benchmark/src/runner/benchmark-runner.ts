import { createInMemoryMemorySubsystem, createTestPlatform, RawMockAdapter } from "@ctx/testing";
import { detectWastedCalls } from "../harness/dedup-detector";
import { tapEventStream } from "../harness/event-stream-tap";
import { CallRecorder } from "../harness/call-recorder";
import type { BenchmarkAnalysis, BenchmarkMode, BenchmarkRunResult } from "../results/schema";
import { analyzeBenchmarkResults } from "../results/analyzer";
import { BENCHMARK_ROUNDS } from "./round-defs";
import { buildModeScenario } from "./mock-scenarios";

export interface RunBenchmarkInput {
  modes?: BenchmarkMode[];
  repeatCount?: number;
  includeAuxiliaryMode?: boolean;
}

export interface RunBenchmarkOutput {
  runs: BenchmarkRunResult[];
  analysis: BenchmarkAnalysis;
}

export async function runBenchmark(input: RunBenchmarkInput = {}): Promise<RunBenchmarkOutput> {
  const repeatCount = input.repeatCount ?? 5;
  const modes = input.modes ?? [
    "baseline",
    "platform-context",
    "platform-context-memory-real",
  ];
  const selectedModes = input.includeAuxiliaryMode && !modes.includes("platform-context-memory-sim")
    ? [...modes, "platform-context-memory-sim"] as BenchmarkMode[]
    : modes;

  const runs: BenchmarkRunResult[] = [];
  for (const mode of selectedModes) {
    for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
      runs.push(await runModeIteration(mode, iteration));
    }
  }

  return {
    runs,
    analysis: analyzeBenchmarkResults(runs),
  };
}

async function runModeIteration(mode: BenchmarkMode, iteration: number): Promise<BenchmarkRunResult> {
  const scenario = buildModeScenario(mode, iteration);
  const llmCalls = [];
  const toolCalls = [];

  for (const roundDef of BENCHMARK_ROUNDS) {
    const roundScenario = scenario.rounds[roundDef.round - 1];
    const memorySubsystem = scenario.policy.memory === "platform" ? createInMemoryMemorySubsystem() : undefined;
    const { client } = createTestPlatform({
      adapters: [new RawMockAdapter({ rawEvents: roundScenario.rawEvents })],
      memory: memorySubsystem,
    });

    const session = await client.sessions.create({
      workspaceId: `ws_benchmark_${mode}_${iteration}`,
      title: `benchmark ${mode} ${iteration}`,
    });
    const task = await client.tasks.create({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      title: `round ${roundDef.round}`,
      objective: roundDef.prompt,
    });

    const recorder = new CallRecorder();
    const handle = await client.runs.start({
      workspaceId: session.workspaceId,
      sessionId: session.id,
      taskId: task.id,
      adapter: "mock",
      capabilityPolicy: scenario.policy,
      metadata: { prompt: roundDef.prompt },
    });

    await tapEventStream(handle, async (event) => {
      recorder.record({
        event,
        mode,
        round: roundDef.round,
        purpose: roundDef.purpose,
        contextBreakdowns: roundScenario.contextBreakdowns,
        toolMemoryMap: roundScenario.toolMemoryMap,
        toolNewInformationMap: roundScenario.toolNewInformationMap,
      });
    });

    const snapshot = recorder.snapshot();
    llmCalls.push(...snapshot.llmCalls);
    toolCalls.push(...snapshot.toolCalls);
  }

  const wastedCalls = detectWastedCalls(toolCalls);
  return {
    mode,
    iteration,
    llmCalls,
    toolCalls,
    wastedCalls,
    completion: scenario.completion,
  };
}
