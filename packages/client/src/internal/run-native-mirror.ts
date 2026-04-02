import type { AgentEventEnvelope, Run } from "@ctx/core";

export const RUN_NATIVE_MIRROR_METADATA_KEY = "platformNativeRunMirror";

export interface NativeRunMirrorV1 {
  version: "1";
  runtime: string;
  nativeSessionRef?: string;
  latestMessageId?: string;
  assistantDeltaCount: number;
  assistantMessageCount: number;
  assistantCharCount: number;
  lastActivityAt: string;
  lastMessageCompletedAt?: string;
}

export function applyRunNativeMirror(run: Run, event: AgentEventEnvelope): Run {
  const current = readNativeRunMirror(run) ?? createEmptyMirror(run);
  const next = evolveNativeRunMirror(current, event);
  if (next === current) {
    return run;
  }

  return {
    ...run,
    metadata: {
      ...run.metadata,
      [RUN_NATIVE_MIRROR_METADATA_KEY]: next,
    },
  };
}

export function readNativeRunMirror(run: Run): NativeRunMirrorV1 | undefined {
  const value = run.metadata?.[RUN_NATIVE_MIRROR_METADATA_KEY];
  return isNativeRunMirror(value) ? value : undefined;
}

function createEmptyMirror(run: Run): NativeRunMirrorV1 {
  return {
    version: "1",
    runtime: run.adapter,
    assistantDeltaCount: 0,
    assistantMessageCount: 0,
    assistantCharCount: 0,
    lastActivityAt: new Date().toISOString(),
  };
}

function evolveNativeRunMirror(mirror: NativeRunMirrorV1, event: AgentEventEnvelope): NativeRunMirrorV1 {
  const timestamp = event.timestamp || new Date().toISOString();

  if (event.type === "run.started") {
    const payload = event.payload as { externalRef?: string };
    return {
      ...mirror,
      nativeSessionRef: payload.externalRef ?? mirror.nativeSessionRef,
      lastActivityAt: timestamp,
    };
  }

  if (event.type === "message.delta") {
    const payload = event.payload as { text?: string };
    const text = typeof payload.text === "string" ? payload.text : "";
    return {
      ...mirror,
      assistantDeltaCount: mirror.assistantDeltaCount + 1,
      assistantCharCount: mirror.assistantCharCount + text.length,
      lastActivityAt: timestamp,
    };
  }

  if (event.type === "message.completed") {
    const payload = event.payload as { messageId?: string };
    return {
      ...mirror,
      latestMessageId: payload.messageId ?? mirror.latestMessageId,
      assistantMessageCount: mirror.assistantMessageCount + 1,
      lastActivityAt: timestamp,
      lastMessageCompletedAt: timestamp,
    };
  }

  return mirror;
}

function isNativeRunMirror(value: unknown): value is NativeRunMirrorV1 {
  return Boolean(value)
    && typeof value === "object"
    && (value as { version?: string }).version === "1"
    && typeof (value as { assistantDeltaCount?: unknown }).assistantDeltaCount === "number"
    && typeof (value as { assistantMessageCount?: unknown }).assistantMessageCount === "number";
}
