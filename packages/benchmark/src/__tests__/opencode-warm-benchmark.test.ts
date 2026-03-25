import { describe, expect, test } from "vitest";
import { analyzeWarmBenchmarkResults } from "../runner/opencode-warm-benchmark";
import type { BenchmarkRunResult, CompletionScore, ToolUseRecord } from "../results/schema";
import type { WarmBenchmarkRunResult } from "../runner/opencode-warm-benchmark";

describe("analyzeWarmBenchmarkResults()", () => {
  test("excludes pass1-too-complete iterations and computes pass2 recovery metrics", () => {
    const analysis = analyzeWarmBenchmarkResults([
      makeWarmRun({
        mode: "baseline",
        iteration: 1,
        partialScore: 55,
        finalScore: 92,
        pass1TooComplete: false,
        pass2LlmTimestamps: [
          "2026-03-25T10:00:00.000Z",
          "2026-03-25T10:00:02.000Z",
          "2026-03-25T10:00:05.000Z",
        ],
        pass2Tools: [
          toolCall("baseline", 1, "read", "2026-03-25T10:00:01.000Z", { filePath: "C:\\tmp\\ctx-benchmark-fixture\\minikanban\\README.md" }),
          toolCall("baseline", 1, "read", "2026-03-25T10:00:03.000Z", { filePath: "/README.md" }),
          toolCall("baseline", 1, "edit", "2026-03-25T10:00:04.000Z", { filePath: "/app/main.py" }),
        ],
      }),
      makeWarmRun({
        mode: "baseline",
        iteration: 2,
        partialScore: 75,
        finalScore: 98,
        pass1TooComplete: true,
        pass2LlmTimestamps: ["2026-03-25T11:00:00.000Z"],
        pass2Tools: [toolCall("baseline", 2, "edit", "2026-03-25T11:00:01.000Z", { filePath: "/app/main.py" })],
      }),
      makeWarmRun({
        mode: "platform-context",
        iteration: 1,
        partialScore: 52,
        finalScore: 94,
        pass1TooComplete: false,
        pass2LlmTimestamps: [
          "2026-03-25T10:10:00.000Z",
          "2026-03-25T10:10:02.000Z",
        ],
        pass2Tools: [
          toolCall("platform-context", 1, "edit", "2026-03-25T10:10:01.000Z", { filePath: "/app/main.py" }),
          toolCall("platform-context", 1, "read", "2026-03-25T10:10:03.000Z", { filePath: "/SPEC.md" }),
        ],
      }),
    ]);

    const baseline = analysis.summaries.find((summary) => summary.mode === "baseline");
    const platform = analysis.summaries.find((summary) => summary.mode === "platform-context");

    expect(baseline?.repeatCount).toBe(2);
    expect(baseline?.validIterationCount).toBe(1);
    expect(baseline?.excludedPass1TooCompleteCount).toBe(1);
    expect(baseline?.pass2CallsBeforeFirstEdit.median).toBe(4);
    expect(baseline?.pass2RepeatedReadRatio.median).toBe(0.5);
    expect(platform?.pass2CallsBeforeFirstEdit.median).toBe(1);
    expect(analysis.fairness[0]?.check.valid).toBe(true);
  });
});

function makeWarmRun(input: {
  mode: WarmBenchmarkRunResult["mode"];
  iteration: number;
  partialScore: number;
  finalScore: number;
  pass1TooComplete: boolean;
  pass2LlmTimestamps: string[];
  pass2Tools: ToolUseRecord[];
}): WarmBenchmarkRunResult {
  return {
    mode: input.mode,
    iteration: input.iteration,
    pass1: makeBenchmarkRun({
      mode: input.mode,
      iteration: input.iteration,
      completion: completion(input.partialScore),
      llmTimestamps: ["2026-03-25T09:00:00.000Z"],
      toolCalls: [],
    }),
    pass2: makeBenchmarkRun({
      mode: input.mode,
      iteration: input.iteration,
      completion: completion(input.finalScore),
      llmTimestamps: input.pass2LlmTimestamps,
      toolCalls: input.pass2Tools,
    }),
    partialCompletionAfterPass1: completion(input.partialScore),
    finalCompletion: completion(input.finalScore),
    pass1TooComplete: input.pass1TooComplete,
  };
}

function makeBenchmarkRun(input: {
  mode: WarmBenchmarkRunResult["mode"];
  iteration: number;
  completion: CompletionScore;
  llmTimestamps: string[];
  toolCalls: ToolUseRecord[];
}): BenchmarkRunResult {
  return {
    mode: input.mode,
    iteration: input.iteration,
    llmCalls: input.llmTimestamps.map((timestamp, index) => ({
      callId: `${input.mode}:${input.iteration}:llm:${index}`,
      runId: `run_${input.mode}_${input.iteration}`,
      round: 4,
      mode: input.mode,
      purpose: "patch",
      inputTokens: 100 + index,
      outputTokens: 50,
      cacheReadInputTokens: 20,
      totalTokens: 150 + index,
      timestamp,
    })),
    toolCalls: input.toolCalls,
    wastedCalls: [],
    completion: input.completion,
    roundDiagnostics: [],
  };
}

function toolCall(
  mode: WarmBenchmarkRunResult["mode"],
  iteration: number,
  toolName: string,
  timestamp: string,
  input: Record<string, unknown>,
): ToolUseRecord {
  return {
    callId: `${mode}:${iteration}:${toolName}:${timestamp}`,
    runId: `run_${mode}_${iteration}`,
    round: 4,
    toolName,
    inputSignature: JSON.stringify(input),
    timestamp,
    isError: false,
    availableMemoryIds: [],
  };
}

function completion(total: number): CompletionScore {
  return {
    total,
    publicTestsPassed: 10,
    publicTestsTotal: 23,
    hiddenTestsPassed: 10,
    hiddenTestsTotal: 12,
    codeQualityPoints: 10,
    deliveryPoints: 15,
    processPoints: 15,
  };
}
