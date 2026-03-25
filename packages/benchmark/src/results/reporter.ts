import type { RunBenchmarkOutput } from "../runner/benchmark-runner";

export function formatBenchmarkReport(output: RunBenchmarkOutput): string {
  const lines: string[] = [];
  lines.push("Mode | Repeats | Input+Cache | LLM Calls | Tool Calls | Read Calls | Distinct Reads | Repeat Read Ratio | Bash Calls | Completion");
  lines.push("--- | --- | --- | --- | --- | --- | --- | --- | --- | ---");

  for (const summary of output.analysis.summaries) {
    lines.push(
      [
        summary.mode,
        String(summary.repeatCount),
        formatSpread(summary.totalInputTokensWithCache),
        formatSpread(summary.totalLlmCalls),
        formatSpread(summary.totalToolCalls),
        formatSpread(summary.readToolCalls),
        formatSpread(summary.distinctReadTargets),
        formatSpread(summary.repeatedReadCallRatio),
        formatSpread(summary.bashToolCalls),
        formatSpread(summary.completionScore),
      ].join(" | "),
    );
  }

  lines.push("");
  lines.push("Token detail:");
  lines.push("Mode | Uncached Input | Cache Read | Input+Cache | R6-R10 Avg Input+Cache | Memory Extract");
  lines.push("--- | --- | --- | --- | --- | ---");
  for (const summary of output.analysis.summaries) {
    lines.push(
      [
        summary.mode,
        formatSpread(summary.totalInputTokens),
        formatSpread(summary.totalCacheReadInputTokens),
        formatSpread(summary.totalInputTokensWithCache),
        formatSpread(summary.averageInputTokensWithCacheR6ToR10),
        formatSpread(summary.memoryExtractionTokens),
      ].join(" | "),
    );
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

export function stringifyBenchmarkReport(output: RunBenchmarkOutput): string {
  return JSON.stringify(output, null, 2);
}

function formatSpread(spread: { median: number; p25: number; p75: number }): string {
  return `${round(spread.median)} [${round(spread.p25)}-${round(spread.p75)}]`;
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
