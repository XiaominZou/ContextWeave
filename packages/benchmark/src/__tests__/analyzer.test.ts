import { describe, expect, test } from "vitest";
import { analyzeBenchmarkResults } from "../results/analyzer";
import type { BenchmarkRunResult } from "../results/schema";

function makeRun(input: {
  mode: BenchmarkRunResult["mode"];
  iteration: number;
  inputTokens: number[];
  hiddenTestsPassed: number;
  completion: number;
}): BenchmarkRunResult {
  return {
    mode: input.mode,
    iteration: input.iteration,
    llmCalls: input.inputTokens.map((tokens, index) => ({
      callId: `${input.mode}:${input.iteration}:${index}`,
      runId: `run_${input.mode}_${input.iteration}`,
      round: index + 1,
      mode: input.mode,
      purpose: "other",
      inputTokens: tokens,
      outputTokens: 100,
      totalTokens: tokens + 100,
      timestamp: new Date().toISOString(),
      contextBreakdown: { memoryExtractionTokens: input.mode === "platform-context-memory-real" ? 10 : 0 },
    })),
    toolCalls: [],
    wastedCalls: [],
    completion: {
      total: input.completion,
      publicTestsPassed: 23,
      publicTestsTotal: 23,
      hiddenTestsPassed: input.hiddenTestsPassed,
      hiddenTestsTotal: 12,
      codeQualityPoints: 10,
      deliveryPoints: 15,
      processPoints: 15,
    },
  };
}

describe("analyzeBenchmarkResults()", () => {
  test("builds summaries and fairness gates", () => {
    const analysis = analyzeBenchmarkResults([
      makeRun({ mode: "baseline", iteration: 1, inputTokens: [100, 200, 300], hiddenTestsPassed: 12, completion: 95 }),
      makeRun({ mode: "baseline", iteration: 2, inputTokens: [110, 210, 310], hiddenTestsPassed: 12, completion: 94 }),
      makeRun({ mode: "platform-context", iteration: 1, inputTokens: [90, 140, 160], hiddenTestsPassed: 12, completion: 95 }),
      makeRun({ mode: "platform-context", iteration: 2, inputTokens: [95, 145, 165], hiddenTestsPassed: 12, completion: 94 }),
      makeRun({ mode: "platform-context-memory-real", iteration: 1, inputTokens: [80, 120, 150], hiddenTestsPassed: 11, completion: 93 }),
      makeRun({ mode: "platform-context-memory-real", iteration: 2, inputTokens: [82, 122, 152], hiddenTestsPassed: 11, completion: 92 }),
    ]);

    expect(analysis.summaries).toHaveLength(3);
    expect(analysis.fairness.find((item) => item.left === "baseline" && item.right === "platform-context")?.check.valid).toBe(true);
    expect(analysis.fairness.find((item) => item.left === "platform-context" && item.right === "platform-context-memory-real")?.check.valid).toBe(true);
  });
});
