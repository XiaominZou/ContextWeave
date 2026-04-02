export interface PinchBenchUsageSummary {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost_usd?: number;
  request_count?: number;
}

export interface PinchBenchGradeRun {
  task_id: string;
  score: number;
  max_score: number;
  grading_type: string;
  breakdown: Record<string, number>;
  notes: string;
}

export interface PinchBenchGradeSummary {
  runs: PinchBenchGradeRun[];
  mean: number;
  std: number;
  min: number;
  max: number;
}

export interface PinchBenchTaskEntry {
  task_id: string;
  status: string;
  timed_out: boolean;
  execution_time: number;
  transcript_length: number;
  usage?: PinchBenchUsageSummary;
  workspace: string;
  grading: PinchBenchGradeSummary;
  frontmatter?: Record<string, unknown>;
}

export interface PinchBenchEfficiencySummary {
  total_tokens?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cost_usd?: number;
  total_requests?: number;
  total_execution_time_seconds?: number;
  tasks_with_usage_data?: number;
  tokens_per_task?: number;
  cost_per_task_usd?: number;
  score_per_1k_tokens?: number | null;
  score_per_dollar?: number | null;
}

export interface PinchBenchAggregateResult {
  model: string;
  benchmark_version: string;
  run_id: string;
  timestamp: number;
  suite: string;
  runs_per_task: number;
  tasks: PinchBenchTaskEntry[];
  efficiency?: PinchBenchEfficiencySummary;
}

export type OpenClawPinchBenchScenario = "without-platform" | "with-platform";

export interface OpenClawPinchBenchScenarioSummary {
  scenario: OpenClawPinchBenchScenario;
  model: string;
  suite: string;
  runId: string;
  benchmarkVersion: string;
  taskRunCount: number;
  uniqueTaskCount: number;
  runsPerTask: number;
  successfulTaskRuns: number;
  timedOutTaskRuns: number;
  totalMeanScore: number;
  overallScorePercent: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  totalCostUsd: number;
  totalExecutionTimeSeconds: number;
  averageTaskRunTimeSeconds: number;
  scorePer1kTokens: number | null;
  scorePerSecond: number | null;
  scorePerRequest: number | null;
}

export interface OpenClawPinchBenchDelta {
  overallScorePercent: number;
  totalMeanScore: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalRequests: number;
  totalCostUsd: number;
  totalExecutionTimeSeconds: number;
  averageTaskRunTimeSeconds: number;
  scorePer1kTokens: number | null;
  scorePerSecond: number | null;
  scorePerRequest: number | null;
}

export interface OpenClawPinchBenchComparison {
  baseline: OpenClawPinchBenchScenarioSummary;
  platform: OpenClawPinchBenchScenarioSummary;
  delta: OpenClawPinchBenchDelta;
}

export interface OpenClawPinchBenchTaskSummary {
  taskId: string;
  runCount: number;
  successCount: number;
  timedOutCount: number;
  meanScore: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageTotalTokens: number;
  averageExecutionTimeSeconds: number;
}

export interface OpenClawPinchBenchTaskComparison {
  taskId: string;
  baseline: OpenClawPinchBenchTaskSummary;
  platform: OpenClawPinchBenchTaskSummary;
  delta: {
    meanScore: number;
    averageInputTokens: number;
    averageOutputTokens: number;
    averageTotalTokens: number;
    averageExecutionTimeSeconds: number;
  };
}

export function summarizeOpenClawPinchBenchScenario(
  scenario: OpenClawPinchBenchScenario,
  aggregate: PinchBenchAggregateResult,
): OpenClawPinchBenchScenarioSummary {
  const taskRuns = Array.isArray(aggregate.tasks) ? aggregate.tasks : [];
  const uniqueTaskIds = new Set<string>();
  const gradingByTaskId = new Map<string, PinchBenchGradeSummary>();

  let successfulTaskRuns = 0;
  let timedOutTaskRuns = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalTokens = 0;
  let totalRequests = 0;
  let totalCostUsd = 0;
  let totalExecutionTimeSeconds = 0;

  for (const taskRun of taskRuns) {
    uniqueTaskIds.add(taskRun.task_id);
    gradingByTaskId.set(taskRun.task_id, taskRun.grading);

    if (taskRun.status === "success") {
      successfulTaskRuns += 1;
    }
    if (taskRun.timed_out) {
      timedOutTaskRuns += 1;
    }

    totalInputTokens += toNumber(taskRun.usage?.input_tokens);
    totalOutputTokens += toNumber(taskRun.usage?.output_tokens);
    totalTokens += toNumber(taskRun.usage?.total_tokens);
    totalRequests += toNumber(taskRun.usage?.request_count);
    totalCostUsd += toNumber(taskRun.usage?.cost_usd);
    totalExecutionTimeSeconds += toNumber(taskRun.execution_time);
  }

  let totalMeanScore = 0;
  for (const grading of gradingByTaskId.values()) {
    totalMeanScore += toNumber(grading.mean);
  }

  const uniqueTaskCount = uniqueTaskIds.size;
  const taskRunCount = taskRuns.length;
  const overallScorePercent = uniqueTaskCount > 0
    ? (totalMeanScore / uniqueTaskCount) * 100
    : 0;
  const averageTaskRunTimeSeconds = taskRunCount > 0
    ? totalExecutionTimeSeconds / taskRunCount
    : 0;
  const scorePer1kTokens = totalTokens > 0
    ? totalMeanScore / (totalTokens / 1000)
    : null;
  const scorePerSecond = totalExecutionTimeSeconds > 0
    ? totalMeanScore / totalExecutionTimeSeconds
    : null;
  const scorePerRequest = totalRequests > 0
    ? totalMeanScore / totalRequests
    : null;

  return {
    scenario,
    model: aggregate.model,
    suite: aggregate.suite,
    runId: aggregate.run_id,
    benchmarkVersion: aggregate.benchmark_version,
    taskRunCount,
    uniqueTaskCount,
    runsPerTask: Math.max(1, toNumber(aggregate.runs_per_task)),
    successfulTaskRuns,
    timedOutTaskRuns,
    totalMeanScore,
    overallScorePercent,
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    totalRequests,
    totalCostUsd,
    totalExecutionTimeSeconds,
    averageTaskRunTimeSeconds,
    scorePer1kTokens,
    scorePerSecond,
    scorePerRequest,
  };
}

export function compareOpenClawPinchBenchScenarios(
  baseline: OpenClawPinchBenchScenarioSummary,
  platform: OpenClawPinchBenchScenarioSummary,
): OpenClawPinchBenchComparison {
  return {
    baseline,
    platform,
    delta: {
      overallScorePercent: platform.overallScorePercent - baseline.overallScorePercent,
      totalMeanScore: platform.totalMeanScore - baseline.totalMeanScore,
      totalInputTokens: platform.totalInputTokens - baseline.totalInputTokens,
      totalOutputTokens: platform.totalOutputTokens - baseline.totalOutputTokens,
      totalTokens: platform.totalTokens - baseline.totalTokens,
      totalRequests: platform.totalRequests - baseline.totalRequests,
      totalCostUsd: roundTo(platform.totalCostUsd - baseline.totalCostUsd, 6),
      totalExecutionTimeSeconds: platform.totalExecutionTimeSeconds - baseline.totalExecutionTimeSeconds,
      averageTaskRunTimeSeconds: platform.averageTaskRunTimeSeconds - baseline.averageTaskRunTimeSeconds,
      scorePer1kTokens: subtractNullable(platform.scorePer1kTokens, baseline.scorePer1kTokens),
      scorePerSecond: subtractNullable(platform.scorePerSecond, baseline.scorePerSecond),
      scorePerRequest: subtractNullable(platform.scorePerRequest, baseline.scorePerRequest),
    },
  };
}

export function formatOpenClawPinchBenchReport(
  comparison: OpenClawPinchBenchComparison,
): string {
  const lines: string[] = [];
  lines.push("Scenario | Score % | Mean Score | Total Tokens | Input | Output | Requests | Total Time (s) | Avg Task-Run (s) | Score / 1K Tokens");
  lines.push("--- | --- | --- | --- | --- | --- | --- | --- | --- | ---");
  lines.push(formatScenarioRow(comparison.baseline));
  lines.push(formatScenarioRow(comparison.platform));
  lines.push(formatDeltaRow(comparison.delta));
  return lines.join("\n");
}

export function compareOpenClawPinchBenchTasks(
  baselineAggregate: PinchBenchAggregateResult,
  platformAggregate: PinchBenchAggregateResult,
): OpenClawPinchBenchTaskComparison[] {
  const baselineByTask = summarizeTasks(baselineAggregate);
  const platformByTask = summarizeTasks(platformAggregate);
  const taskIds = [...new Set([...baselineByTask.keys(), ...platformByTask.keys()])].sort();

  const comparisons: OpenClawPinchBenchTaskComparison[] = [];
  for (const taskId of taskIds) {
    const baseline = baselineByTask.get(taskId);
    const platform = platformByTask.get(taskId);
    if (!baseline || !platform) {
      continue;
    }
    comparisons.push({
      taskId,
      baseline,
      platform,
      delta: {
        meanScore: platform.meanScore - baseline.meanScore,
        averageInputTokens: platform.averageInputTokens - baseline.averageInputTokens,
        averageOutputTokens: platform.averageOutputTokens - baseline.averageOutputTokens,
        averageTotalTokens: platform.averageTotalTokens - baseline.averageTotalTokens,
        averageExecutionTimeSeconds: platform.averageExecutionTimeSeconds - baseline.averageExecutionTimeSeconds,
      },
    });
  }
  return comparisons;
}

export function formatOpenClawPinchBenchTaskReport(
  comparisons: OpenClawPinchBenchTaskComparison[],
): string {
  const lines: string[] = [];
  lines.push("Task | Base Score | Plat Score | Delta Score | Base Avg Tokens | Plat Avg Tokens | Delta Tokens | Base Avg Time (s) | Plat Avg Time (s) | Delta Time (s)");
  lines.push("--- | --- | --- | --- | --- | --- | --- | --- | --- | ---");
  for (const comparison of comparisons) {
    lines.push([
      comparison.taskId,
      formatFixed(comparison.baseline.meanScore),
      formatFixed(comparison.platform.meanScore),
      formatSigned(comparison.delta.meanScore),
      formatInt(comparison.baseline.averageTotalTokens),
      formatInt(comparison.platform.averageTotalTokens),
      formatSignedInt(comparison.delta.averageTotalTokens),
      formatFixed(comparison.baseline.averageExecutionTimeSeconds),
      formatFixed(comparison.platform.averageExecutionTimeSeconds),
      formatSigned(comparison.delta.averageExecutionTimeSeconds),
    ].join(" | "));
  }
  return lines.join("\n");
}

function formatScenarioRow(summary: OpenClawPinchBenchScenarioSummary): string {
  return [
    summary.scenario,
    formatFixed(summary.overallScorePercent),
    formatFixed(summary.totalMeanScore),
    formatInt(summary.totalTokens),
    formatInt(summary.totalInputTokens),
    formatInt(summary.totalOutputTokens),
    formatInt(summary.totalRequests),
    formatFixed(summary.totalExecutionTimeSeconds),
    formatFixed(summary.averageTaskRunTimeSeconds),
    formatNullable(summary.scorePer1kTokens),
  ].join(" | ");
}

function formatDeltaRow(delta: OpenClawPinchBenchDelta): string {
  return [
    "delta (platform - baseline)",
    formatSigned(delta.overallScorePercent),
    formatSigned(delta.totalMeanScore),
    formatSignedInt(delta.totalTokens),
    formatSignedInt(delta.totalInputTokens),
    formatSignedInt(delta.totalOutputTokens),
    formatSignedInt(delta.totalRequests),
    formatSigned(delta.totalExecutionTimeSeconds),
    formatSigned(delta.averageTaskRunTimeSeconds),
    formatSignedNullable(delta.scorePer1kTokens),
  ].join(" | ");
}

function toNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function subtractNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) {
    return null;
  }
  return left - right;
}

function formatInt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatSignedInt(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) {
    return "0";
  }
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("en-US")}`;
}

function formatFixed(value: number): string {
  return roundTo(value, 2).toFixed(2);
}

function formatSigned(value: number): string {
  const rounded = roundTo(value, 2);
  if (rounded === 0) {
    return "0.00";
  }
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(2)}`;
}

function formatNullable(value: number | null): string {
  return value === null ? "n/a" : formatFixed(value);
}

function formatSignedNullable(value: number | null): string {
  return value === null ? "n/a" : formatSigned(value);
}

function roundTo(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function summarizeTasks(aggregate: PinchBenchAggregateResult): Map<string, OpenClawPinchBenchTaskSummary> {
  const buckets = new Map<string, {
    runCount: number;
    successCount: number;
    timedOutCount: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    totalExecutionTimeSeconds: number;
    meanScore: number;
  }>();

  for (const taskRun of aggregate.tasks ?? []) {
    const existing = buckets.get(taskRun.task_id) ?? {
      runCount: 0,
      successCount: 0,
      timedOutCount: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalTokens: 0,
      totalExecutionTimeSeconds: 0,
      meanScore: toNumber(taskRun.grading?.mean),
    };
    existing.runCount += 1;
    existing.successCount += taskRun.status === "success" ? 1 : 0;
    existing.timedOutCount += taskRun.timed_out ? 1 : 0;
    existing.totalInputTokens += toNumber(taskRun.usage?.input_tokens);
    existing.totalOutputTokens += toNumber(taskRun.usage?.output_tokens);
    existing.totalTokens += toNumber(taskRun.usage?.total_tokens);
    existing.totalExecutionTimeSeconds += toNumber(taskRun.execution_time);
    existing.meanScore = toNumber(taskRun.grading?.mean);
    buckets.set(taskRun.task_id, existing);
  }

  const summaries = new Map<string, OpenClawPinchBenchTaskSummary>();
  for (const [taskId, bucket] of buckets.entries()) {
    summaries.set(taskId, {
      taskId,
      runCount: bucket.runCount,
      successCount: bucket.successCount,
      timedOutCount: bucket.timedOutCount,
      meanScore: bucket.meanScore,
      averageInputTokens: bucket.runCount > 0 ? bucket.totalInputTokens / bucket.runCount : 0,
      averageOutputTokens: bucket.runCount > 0 ? bucket.totalOutputTokens / bucket.runCount : 0,
      averageTotalTokens: bucket.runCount > 0 ? bucket.totalTokens / bucket.runCount : 0,
      averageExecutionTimeSeconds: bucket.runCount > 0 ? bucket.totalExecutionTimeSeconds / bucket.runCount : 0,
    });
  }
  return summaries;
}
