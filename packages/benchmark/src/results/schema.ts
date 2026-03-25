export type BenchmarkMode =
  | "baseline"
  | "platform-context"
  | "platform-context-memory-real"
  | "platform-context-memory-sim";

export interface ContextBreakdown {
  taskBlockTokens?: number;
  memoryTokens?: number;
  historyTokens?: number;
  artifactRefTokens?: number;
  rawHistoryTokens?: number;
  memoryExtractionTokens?: number;
}

export interface LlmCallRecord {
  callId: string;
  runId: string;
  round: number;
  mode: BenchmarkMode;
  purpose: "plan" | "patch" | "debug" | "summarize" | "other";
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  totalTokens: number;
  timestamp: string;
  contextBreakdown?: ContextBreakdown;
}

export interface ToolUseRecord {
  callId: string;
  runId: string;
  round: number;
  toolName: string;
  inputSignature: string;
  timestamp: string;
  isError: boolean;
  availableMemoryIds: string[];
  yieldedNewInformation?: boolean;
}

export interface WastedCallRecord {
  callId: string;
  runId: string;
  round: number;
  toolName: string;
  inputSignature: string;
  previousCallId: string;
}

export interface CompletionScore {
  total: number;
  publicTestsPassed: number;
  publicTestsTotal: number;
  hiddenTestsPassed: number;
  hiddenTestsTotal: number;
  codeQualityPoints: number;
  deliveryPoints: number;
  processPoints: number;
}

export interface BenchmarkRoundDiagnostics {
  round: number;
  purpose: LlmCallRecord["purpose"];
  snapshotTokenEstimate: number;
  includedBlockCount: number;
  excludedBlockCount: number;
  promptTextLength: number;
  sourceTypeCounts: Record<string, number>;
  retentionCounts: Record<string, number>;
}

export interface BenchmarkRunResult {
  mode: BenchmarkMode;
  iteration: number;
  llmCalls: LlmCallRecord[];
  toolCalls: ToolUseRecord[];
  wastedCalls: WastedCallRecord[];
  completion: CompletionScore;
  roundDiagnostics?: BenchmarkRoundDiagnostics[];
}

export interface MetricSpread {
  median: number;
  p25: number;
  p75: number;
}

export interface BenchmarkModeSummary {
  mode: BenchmarkMode;
  repeatCount: number;
  totalInputTokens: MetricSpread;
  totalCacheReadInputTokens: MetricSpread;
  totalInputTokensWithCache: MetricSpread;
  totalOutputTokens: MetricSpread;
  averageInputTokensR6ToR10: MetricSpread;
  averageInputTokensWithCacheR6ToR10: MetricSpread;
  completionScore: MetricSpread;
  totalLlmCalls: MetricSpread;
  totalToolCalls: MetricSpread;
  readToolCalls: MetricSpread;
  distinctReadTargets: MetricSpread;
  repeatedReadCallRatio: MetricSpread;
  bashToolCalls: MetricSpread;
  wastedToolCallRatio: MetricSpread;
  memoryExtractionTokens: MetricSpread;
}

export interface FairnessCheck {
  valid: boolean;
  hiddenTestPassDelta: number;
  completionScoreDelta: number;
  reasons: string[];
}

export interface BenchmarkAnalysis {
  summaries: BenchmarkModeSummary[];
  fairness: Array<{
    left: BenchmarkMode;
    right: BenchmarkMode;
    check: FairnessCheck;
  }>;
}
