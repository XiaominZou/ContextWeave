import type { RunBenchmarkOutput } from "../runner/benchmark-runner";

export function formatBenchmarkReport(output: RunBenchmarkOutput): string {
  const lines: string[] = [];
  lines.push("Mode | Repeats | Input(median) | R6-R10 Avg Input | Completion | Memory Extract");
  lines.push("--- | --- | --- | --- | --- | ---");

  for (const summary of output.analysis.summaries) {
    lines.push(
      [
        summary.mode,
        String(summary.repeatCount),
        formatSpread(summary.totalInputTokens),
        formatSpread(summary.averageInputTokensR6ToR10),
        formatSpread(summary.completionScore),
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
