import { describe, expect, it } from "vitest";

import {
  compareOpenClawPinchBenchScenarios,
  formatOpenClawPinchBenchReport,
  summarizeOpenClawPinchBenchScenario,
  type PinchBenchAggregateResult,
} from "../pinchbench/openclaw-pinchbench";

describe("openclaw pinchbench summary", () => {
  it("summarizes repeated task runs without double-counting mean score", () => {
    const aggregate: PinchBenchAggregateResult = {
      model: "openrouter/test-model",
      benchmark_version: "abc123",
      run_id: "0001",
      timestamp: Date.now(),
      suite: "task_08_memory",
      runs_per_task: 2,
      tasks: [
        {
          task_id: "task_08_memory",
          status: "success",
          timed_out: false,
          execution_time: 10,
          transcript_length: 5,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            request_count: 2,
          },
          workspace: "/tmp/a",
          grading: {
            runs: [],
            mean: 0.75,
            std: 0.1,
            min: 0.7,
            max: 0.8,
          },
        },
        {
          task_id: "task_08_memory",
          status: "success",
          timed_out: false,
          execution_time: 12,
          transcript_length: 6,
          usage: {
            input_tokens: 110,
            output_tokens: 12,
            total_tokens: 122,
            request_count: 2,
          },
          workspace: "/tmp/b",
          grading: {
            runs: [],
            mean: 0.75,
            std: 0.1,
            min: 0.7,
            max: 0.8,
          },
        },
      ],
    };

    const summary = summarizeOpenClawPinchBenchScenario("without-platform", aggregate);
    expect(summary.uniqueTaskCount).toBe(1);
    expect(summary.taskRunCount).toBe(2);
    expect(summary.totalMeanScore).toBeCloseTo(0.75);
    expect(summary.overallScorePercent).toBeCloseTo(75);
    expect(summary.totalTokens).toBe(232);
    expect(summary.totalRequests).toBe(4);
  });

  it("formats an A/B report with deltas", () => {
    const baseline = summarizeOpenClawPinchBenchScenario("without-platform", {
      model: "m",
      benchmark_version: "1",
      run_id: "a",
      timestamp: Date.now(),
      suite: "all",
      runs_per_task: 1,
      tasks: [
        {
          task_id: "task_a",
          status: "success",
          timed_out: false,
          execution_time: 20,
          transcript_length: 2,
          usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150, request_count: 2 },
          workspace: "/tmp/a",
          grading: { runs: [], mean: 0.5, std: 0, min: 0.5, max: 0.5 },
        },
      ],
    });
    const platform = summarizeOpenClawPinchBenchScenario("with-platform", {
      model: "m",
      benchmark_version: "1",
      run_id: "b",
      timestamp: Date.now(),
      suite: "all",
      runs_per_task: 1,
      tasks: [
        {
          task_id: "task_a",
          status: "success",
          timed_out: false,
          execution_time: 15,
          transcript_length: 2,
          usage: { input_tokens: 80, output_tokens: 40, total_tokens: 120, request_count: 1 },
          workspace: "/tmp/b",
          grading: { runs: [], mean: 0.8, std: 0, min: 0.8, max: 0.8 },
        },
      ],
    });

    const report = formatOpenClawPinchBenchReport(compareOpenClawPinchBenchScenarios(baseline, platform));
    expect(report).toContain("without-platform");
    expect(report).toContain("with-platform");
    expect(report).toContain("delta (platform - baseline)");
    expect(report).toContain("+30.00");
  });
});
