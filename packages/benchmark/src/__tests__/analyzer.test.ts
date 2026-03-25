import { describe, expect, test } from "vitest";
import { analyzeBenchmarkResults } from "../results/analyzer";
import type { BenchmarkRunResult, ToolUseRecord } from "../results/schema";

function makeRun(input: {
  mode: BenchmarkRunResult["mode"];
  iteration: number;
  inputTokens: number[];
  cacheReadInputTokens?: number[];
  toolCalls?: ToolUseRecord[];
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
      cacheReadInputTokens: input.cacheReadInputTokens?.[index] ?? 0,
      totalTokens: tokens + 100,
      timestamp: new Date().toISOString(),
      contextBreakdown: { memoryExtractionTokens: input.mode === "platform-context-memory-real" ? 10 : 0 },
    })),
    toolCalls: input.toolCalls ?? [],
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
      makeRun({ mode: "baseline", iteration: 1, inputTokens: [100, 200, 300], cacheReadInputTokens: [10, 20, 30], hiddenTestsPassed: 12, completion: 95 }),
      makeRun({
        mode: "baseline",
        iteration: 2,
        inputTokens: [110, 210, 310],
        cacheReadInputTokens: [11, 21, 31],
        toolCalls: [
          toolCall("baseline", 2, 1, "read", { filePath: "C:\\tmp\\ctx-benchmark-fixture\\minikanban\\README.md" }),
          toolCall("baseline", 2, 2, "read", { filePath: "/README.md" }),
          toolCall("baseline", 2, 3, "bash", { command: "ls" }),
        ],
        hiddenTestsPassed: 12,
        completion: 94,
      }),
      makeRun({
        mode: "platform-context",
        iteration: 1,
        inputTokens: [90, 140, 160],
        cacheReadInputTokens: [9, 14, 16],
        toolCalls: [
          toolCall("platform-context", 1, 1, "read", { filePath: "/README.md" }),
          toolCall("platform-context", 1, 2, "read", { filePath: "/SPEC.md" }),
          toolCall("platform-context", 1, 3, "bash", { command: "ls -la" }),
        ],
        hiddenTestsPassed: 12,
        completion: 95,
      }),
      makeRun({ mode: "platform-context", iteration: 2, inputTokens: [95, 145, 165], cacheReadInputTokens: [10, 15, 17], hiddenTestsPassed: 12, completion: 94 }),
      makeRun({ mode: "platform-context-memory-real", iteration: 1, inputTokens: [80, 120, 150], cacheReadInputTokens: [8, 12, 15], hiddenTestsPassed: 11, completion: 93 }),
      makeRun({ mode: "platform-context-memory-real", iteration: 2, inputTokens: [82, 122, 152], cacheReadInputTokens: [8, 12, 15], hiddenTestsPassed: 11, completion: 92 }),
    ]);

    expect(analysis.summaries).toHaveLength(3);
    const baselineSummary = analysis.summaries.find((summary) => summary.mode === "baseline");
    const platformSummary = analysis.summaries.find((summary) => summary.mode === "platform-context");
    expect(baselineSummary?.totalCacheReadInputTokens.median).toBe(61.5);
    expect(baselineSummary?.totalInputTokensWithCache.median).toBe(676.5);
    expect(baselineSummary?.readToolCalls.median).toBe(1);
    expect(baselineSummary?.distinctReadTargets.median).toBe(0.5);
    expect(baselineSummary?.repeatedReadCallRatio.median).toBe(0.25);
    expect(platformSummary?.bashToolCalls.median).toBe(0.5);
    expect(analysis.fairness.find((item) => item.left === "baseline" && item.right === "platform-context")?.check.valid).toBe(true);
    expect(analysis.fairness.find((item) => item.left === "platform-context" && item.right === "platform-context-memory-real")?.check.valid).toBe(true);
  });
});

function toolCall(
  mode: BenchmarkRunResult["mode"],
  iteration: number,
  index: number,
  toolName: string,
  input: Record<string, unknown>,
): ToolUseRecord {
  return {
    callId: `${mode}:${iteration}:tool:${index}`,
    runId: `run_${mode}_${iteration}`,
    round: 3,
    toolName,
    inputSignature: JSON.stringify(input),
    timestamp: new Date().toISOString(),
    isError: false,
    availableMemoryIds: [],
  };
}
