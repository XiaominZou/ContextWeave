import { normalizeContextFilePath } from "@ctx/core";
import type {
  BenchmarkAnalysis,
  BenchmarkMode,
  BenchmarkModeSummary,
  BenchmarkRunResult,
  FairnessCheck,
  MetricSpread,
} from "./schema";

export function analyzeBenchmarkResults(results: BenchmarkRunResult[]): BenchmarkAnalysis {
  const grouped = groupByMode(results);
  const summaries = Object.entries(grouped).map(([mode, runs]) => summarizeMode(mode as BenchmarkMode, runs));
  const fairness = buildFairnessChecks(grouped);
  return { summaries, fairness };
}

function summarizeMode(mode: BenchmarkMode, runs: BenchmarkRunResult[]): BenchmarkModeSummary {
  return {
    mode,
    repeatCount: runs.length,
    totalInputTokens: spread(runs.map((run) => sum(run.llmCalls.map((call) => call.inputTokens)))),
    totalCacheReadInputTokens: spread(runs.map((run) => sum(run.llmCalls.map((call) => call.cacheReadInputTokens ?? 0)))),
    totalInputTokensWithCache: spread(runs.map((run) => sum(run.llmCalls.map((call) => call.inputTokens + (call.cacheReadInputTokens ?? 0))))),
    totalOutputTokens: spread(runs.map((run) => sum(run.llmCalls.map((call) => call.outputTokens)))),
    averageInputTokensR6ToR10: spread(runs.map((run) => average(run.llmCalls.filter((call) => call.round >= 6 && call.round <= 10).map((call) => call.inputTokens)))),
    averageInputTokensWithCacheR6ToR10: spread(runs.map((run) => average(run.llmCalls.filter((call) => call.round >= 6 && call.round <= 10).map((call) => call.inputTokens + (call.cacheReadInputTokens ?? 0))))),
    completionScore: spread(runs.map((run) => run.completion.total)),
    totalLlmCalls: spread(runs.map((run) => run.llmCalls.length)),
    totalToolCalls: spread(runs.map((run) => run.toolCalls.length)),
    readToolCalls: spread(runs.map((run) => countToolCalls(run, "read"))),
    distinctReadTargets: spread(runs.map((run) => countDistinctReadTargets(run))),
    repeatedReadCallRatio: spread(runs.map((run) => calculateRepeatedReadCallRatio(run))),
    bashToolCalls: spread(runs.map((run) => countToolCalls(run, "bash"))),
    wastedToolCallRatio: spread(runs.map((run) => ratio(run.wastedCalls.length, run.toolCalls.length))),
    memoryExtractionTokens: spread(runs.map((run) => sum(run.llmCalls.map((call) => call.contextBreakdown?.memoryExtractionTokens ?? 0)))),
  };
}

function buildFairnessChecks(grouped: Record<string, BenchmarkRunResult[]>): BenchmarkAnalysis["fairness"] {
  const pairs: Array<[BenchmarkMode, BenchmarkMode]> = [
    ["baseline", "platform-context"],
    ["platform-context", "platform-context-memory-real"],
  ];

  return pairs
    .filter(([left, right]) => grouped[left]?.length && grouped[right]?.length)
    .map(([left, right]) => ({
      left,
      right,
      check: checkFairness(grouped[left], grouped[right]),
    }));
}

function checkFairness(leftRuns: BenchmarkRunResult[], rightRuns: BenchmarkRunResult[]): FairnessCheck {
  const hiddenTestPassDelta = Math.abs(median(leftRuns.map((run) => run.completion.hiddenTestsPassed)) - median(rightRuns.map((run) => run.completion.hiddenTestsPassed)));
  const completionScoreDelta = Math.abs(median(leftRuns.map((run) => run.completion.total)) - median(rightRuns.map((run) => run.completion.total)));
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

function groupByMode(results: BenchmarkRunResult[]): Record<string, BenchmarkRunResult[]> {
  const grouped: Record<string, BenchmarkRunResult[]> = {};
  for (const result of results) {
    grouped[result.mode] ??= [];
    grouped[result.mode].push(result);
  }
  return grouped;
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

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return sum(values) / values.length;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function countToolCalls(run: BenchmarkRunResult, toolName: string): number {
  return run.toolCalls.filter((call) => call.toolName === toolName).length;
}

function countDistinctReadTargets(run: BenchmarkRunResult): number {
  const targets = new Set(
    run.toolCalls
      .filter((call) => call.toolName === "read")
      .map((call) => readTargetFromSignature(call.inputSignature))
      .filter((value): value is string => value.length > 0),
  );
  return targets.size;
}

function calculateRepeatedReadCallRatio(run: BenchmarkRunResult): number {
  const readTargets = run.toolCalls
    .filter((call) => call.toolName === "read")
    .map((call) => readTargetFromSignature(call.inputSignature))
    .filter((value): value is string => value.length > 0);

  if (readTargets.length === 0) {
    return 0;
  }

  return (readTargets.length - new Set(readTargets).size) / readTargets.length;
}

function readTargetFromSignature(inputSignature: string): string {
  try {
    const parsed = JSON.parse(inputSignature) as Record<string, unknown>;
    const rawPath = firstString(parsed.filePath, parsed.path, parsed.file, parsed.pathname);
    return rawPath ? normalizeContextFilePath(rawPath) : "";
  } catch {
    return "";
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
