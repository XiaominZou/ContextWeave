import type { ToolUseRecord, WastedCallRecord } from "../results/schema";

export function detectWastedCalls(records: ToolUseRecord[]): WastedCallRecord[] {
  const seen = new Map<string, ToolUseRecord>();
  const wasted: WastedCallRecord[] = [];

  for (const record of records) {
    const key = `${record.toolName}::${record.inputSignature}`;
    const previous = seen.get(key);
    const hasRelevantMemory = record.availableMemoryIds.length > 0;
    const yieldedNewInformation = record.yieldedNewInformation ?? true;

    if (previous && hasRelevantMemory && !yieldedNewInformation && !record.isError) {
      wasted.push({
        callId: record.callId,
        runId: record.runId,
        round: record.round,
        toolName: record.toolName,
        inputSignature: record.inputSignature,
        previousCallId: previous.callId,
      });
    }

    if (!previous) {
      seen.set(key, record);
    }
  }

  return wasted;
}
