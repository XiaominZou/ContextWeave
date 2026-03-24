import { describe, expect, test } from "vitest";
import { runBenchmark } from "../runner/benchmark-runner";

describe("runBenchmark()", () => {
  test("produces repeated benchmark runs and summaries", async () => {
    const output = await runBenchmark({ repeatCount: 2 });

    expect(output.runs).toHaveLength(6);
    expect(output.analysis.summaries).toHaveLength(3);
    expect(output.analysis.summaries.find((summary) => summary.mode === "baseline")?.repeatCount).toBe(2);
    expect(output.analysis.summaries.find((summary) => summary.mode === "baseline")?.totalInputTokens.median).toBeGreaterThan(0);
    expect(output.analysis.fairness.every((item) => item.check.valid)).toBe(true);
  });
});
