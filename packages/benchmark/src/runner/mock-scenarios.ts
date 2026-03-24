import type { CapabilityPolicy } from "@ctx/core";
import type { MockRawEvent } from "@ctx/testing";
import type { BenchmarkMode, CompletionScore, ContextBreakdown } from "../results/schema";
import { BENCHMARK_ROUNDS } from "./round-defs";

export interface MockRoundScenario {
  rawEvents: MockRawEvent[];
  contextBreakdowns: ContextBreakdown[];
  toolMemoryMap: Record<string, string[]>;
  toolNewInformationMap: Record<string, boolean>;
}

export interface ModeScenario {
  policy: Partial<CapabilityPolicy>;
  completion: CompletionScore;
  rounds: MockRoundScenario[];
}

const BASELINE_INPUTS = [1200, 1800, 2400, 3000, 3600, 4600, 5400, 6200, 7000, 7800];
const CONTEXT_INPUTS = [1180, 1500, 1750, 1950, 2100, 2250, 2350, 2450, 2550, 2650];
const MEMORY_INPUTS = [1170, 1475, 1700, 1830, 1900, 2025, 2100, 2180, 2250, 2325];

const OUTPUTS = [180, 260, 280, 300, 280, 260, 250, 240, 260, 200];

export function buildModeScenario(mode: BenchmarkMode, iteration: number): ModeScenario {
  const jitter = iteration - 1;
  switch (mode) {
    case "baseline":
      return {
        policy: { context: "native", memory: "off" },
        completion: buildCompletion({ total: 95, hiddenPassed: 12, iteration }),
        rounds: BENCHMARK_ROUNDS.map((round, index) =>
          buildRoundScenario({
            mode,
            round: round.round,
            inputTokens: BASELINE_INPUTS[index] + jitter * 40,
            outputTokens: OUTPUTS[index] + jitter * 4,
            duplicateRead: round.round >= 4,
            memoryAvailable: false,
          }),
        ),
      };
    case "platform-context":
      return {
        policy: { context: "inject", memory: "off" },
        completion: buildCompletion({ total: 95, hiddenPassed: 12, iteration }),
        rounds: BENCHMARK_ROUNDS.map((round, index) =>
          buildRoundScenario({
            mode,
            round: round.round,
            inputTokens: CONTEXT_INPUTS[index] + jitter * 25,
            outputTokens: OUTPUTS[index] + jitter * 3,
            duplicateRead: round.round >= 6,
            memoryAvailable: false,
          }),
        ),
      };
    case "platform-context-memory-real":
      return {
        policy: { context: "inject", memory: "platform" },
        completion: buildCompletion({ total: 96, hiddenPassed: 12, iteration }),
        rounds: BENCHMARK_ROUNDS.map((round, index) =>
          buildRoundScenario({
            mode,
            round: round.round,
            inputTokens: MEMORY_INPUTS[index] + jitter * 20,
            outputTokens: OUTPUTS[index] + jitter * 3,
            duplicateRead: round.round >= 8,
            memoryAvailable: round.round >= 4,
            memoryExtractionTokens: round.round >= 4 ? 55 + jitter * 2 : 0,
          }),
        ),
      };
    case "platform-context-memory-sim":
      return {
        policy: { context: "inject", memory: "platform" },
        completion: buildCompletion({ total: 96, hiddenPassed: 12, iteration }),
        rounds: BENCHMARK_ROUNDS.map((round, index) =>
          buildRoundScenario({
            mode,
            round: round.round,
            inputTokens: MEMORY_INPUTS[index] - 100 + jitter * 10,
            outputTokens: OUTPUTS[index] + jitter * 2,
            duplicateRead: false,
            memoryAvailable: round.round >= 4,
          }),
        ),
      };
  }
}

function buildRoundScenario(input: {
  mode: BenchmarkMode;
  round: number;
  inputTokens: number;
  outputTokens: number;
  duplicateRead: boolean;
  memoryAvailable: boolean;
  memoryExtractionTokens?: number;
}): MockRoundScenario {
  const callId = `call_r${input.round}`;
  const duplicateCallId = `call_r${input.round}_dup`;
  const rawEvents: MockRawEvent[] = [
    { type: "run_started", model: "mock-benchmark-model" },
    { type: "tool_call", callId, name: "read_file", input: { path: `fixtures/minikanban/file-${input.round}.py` } },
    { type: "tool_result", callId, output: { ok: true } },
  ];

  if (input.duplicateRead) {
    rawEvents.push(
      { type: "tool_call", callId: duplicateCallId, name: "read_file", input: { path: `fixtures/minikanban/file-${input.round}.py` } },
      { type: "tool_result", callId: duplicateCallId, output: { ok: true } },
    );
  }

  rawEvents.push(
    { type: "run_usage", inputTokens: input.inputTokens, outputTokens: input.outputTokens },
    { type: "text_delta", text: `round ${input.round} complete` },
    { type: "run_completed", reason: "end_turn" },
  );

  const toolMemoryMap: Record<string, string[]> = {};
  const toolNewInformationMap: Record<string, boolean> = {
    [callId]: true,
  };

  if (input.duplicateRead) {
    toolMemoryMap[duplicateCallId] = input.memoryAvailable ? [`mem_r${input.round}`] : [];
    toolNewInformationMap[duplicateCallId] = false;
  }

  const contextBreakdowns: ContextBreakdown[] = [
    {
      taskBlockTokens: 180,
      memoryTokens: input.mode === "platform-context-memory-real" || input.mode === "platform-context-memory-sim" ? 90 : 0,
      historyTokens: input.mode === "baseline" ? 0 : 250,
      artifactRefTokens: input.mode === "baseline" ? 0 : 80,
      rawHistoryTokens: input.mode === "baseline" ? Math.max(0, input.inputTokens - 180) : 0,
      memoryExtractionTokens: input.memoryExtractionTokens ?? 0,
    },
  ];

  return {
    rawEvents,
    contextBreakdowns,
    toolMemoryMap,
    toolNewInformationMap,
  };
}

function buildCompletion(input: {
  total: number;
  hiddenPassed: number;
  iteration: number;
}): CompletionScore {
  return {
    total: input.total - Math.max(0, input.iteration - 1),
    publicTestsPassed: 23,
    publicTestsTotal: 23,
    hiddenTestsPassed: input.hiddenPassed,
    hiddenTestsTotal: 12,
    codeQualityPoints: 10,
    deliveryPoints: 15,
    processPoints: 15,
  };
}
