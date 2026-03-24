import type { AgentEventEnvelope } from "@ctx/core";
import type { ContextBreakdown, LlmCallRecord, ToolUseRecord, BenchmarkMode } from "../results/schema";

export interface RecordEventInput {
  event: AgentEventEnvelope;
  mode: BenchmarkMode;
  round: number;
  purpose?: LlmCallRecord["purpose"];
  contextBreakdowns?: ContextBreakdown[];
  toolMemoryMap?: Record<string, string[]>;
  toolNewInformationMap?: Record<string, boolean>;
}

export interface CallRecorderSnapshot {
  llmCalls: LlmCallRecord[];
  toolCalls: ToolUseRecord[];
}

export class CallRecorder {
  private readonly llmCalls: LlmCallRecord[] = [];
  private readonly toolCalls: ToolUseRecord[] = [];
  private readonly toolCallIndex = new Map<string, number>();
  private llmCallCounter = 0;

  record(input: RecordEventInput): void {
    const { event } = input;
    if (event.type === "run.usage") {
      const usage = event.payload as { inputTokens?: number; outputTokens?: number };
      const contextBreakdown = input.contextBreakdowns?.[this.llmCallCounter];
      this.llmCallCounter += 1;
      this.llmCalls.push({
        callId: `${event.runId}:llm:${this.llmCallCounter}`,
        runId: event.runId,
        round: input.round,
        mode: input.mode,
        purpose: input.purpose ?? "other",
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        timestamp: event.timestamp,
        contextBreakdown,
      });
      return;
    }

    if (event.type === "tool.call") {
      const payload = event.payload as { callId: string; name: string; input: unknown };
      this.toolCallIndex.set(payload.callId, this.toolCalls.length);
      this.toolCalls.push({
        callId: payload.callId,
        runId: event.runId,
        round: input.round,
        toolName: payload.name,
        inputSignature: stableStringify(payload.input),
        isError: false,
        availableMemoryIds: input.toolMemoryMap?.[payload.callId] ?? [],
        yieldedNewInformation: input.toolNewInformationMap?.[payload.callId],
      });
      return;
    }

    if (event.type === "tool.result") {
      const payload = event.payload as { callId: string; isError?: boolean };
      const index = this.toolCallIndex.get(payload.callId);
      if (typeof index !== "number") {
        return;
      }
      const current = this.toolCalls[index];
      this.toolCalls[index] = {
        ...current,
        isError: payload.isError ?? false,
      };
    }
  }

  snapshot(): CallRecorderSnapshot {
    return {
      llmCalls: [...this.llmCalls],
      toolCalls: [...this.toolCalls],
    };
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortValue(child)]),
    );
  }
  return value;
}
