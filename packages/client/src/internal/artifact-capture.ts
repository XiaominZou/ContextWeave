import type { AgentEventEnvelope, CapabilityPolicy, Run } from "@ctx/core";
import type { PlatformStore } from "../contracts";
import { nextId } from "./ids";
import { buildArtifactRecord, extractArtifactCandidates } from "./artifact-records";

export function maybeCaptureArtifactsFromToolResult(input: {
  run: Run;
  event: AgentEventEnvelope;
  priorEvents: AgentEventEnvelope[];
  policy: CapabilityPolicy;
  store: PlatformStore;
  capturedArtifactIds: Set<string>;
}): AgentEventEnvelope[] {
  if (input.event.type !== "tool.result") {
    return [];
  }

  const payload = readObject(input.event.payload);
  const output = payload?.["output"];
  const callId = typeof payload?.["callId"] === "string" ? payload["callId"] : undefined;
  const toolCall = callId ? findToolCall(input.priorEvents, callId) : undefined;
  const toolName = typeof toolCall?.payload === "object" && toolCall?.payload ? readToolName(toolCall.payload) : undefined;
  const created: AgentEventEnvelope[] = [];

  for (const candidate of extractArtifactCandidates(output)) {
    if (input.capturedArtifactIds.has(candidate.id)) {
      continue;
    }
    input.capturedArtifactIds.add(candidate.id);

    const record = buildArtifactRecord({
      run: input.run,
      candidate,
      createdAt: input.event.timestamp,
      toolCallId: callId,
      toolName,
      sourceEventId: input.event.id,
      captureMode: input.policy.artifacts,
    });

    if (input.policy.artifacts === "capture-store") {
      input.store.saveArtifact(record);
    }

    created.push({
      id: nextId("evt"),
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      taskId: input.run.taskId,
      runId: input.run.id,
      adapter: "platform",
      type: "artifact.created",
      timestamp: input.event.timestamp,
      payload: {
        artifactId: record.id,
        type: record.type,
      },
      metadata: {
        uri: record.uri,
        toolCallId: callId,
        toolName,
        captureMode: input.policy.artifacts,
      },
    });
  }

  return created;
}

function findToolCall(events: AgentEventEnvelope[], callId: string): AgentEventEnvelope | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "tool.call") {
      continue;
    }
    const payload = readObject(event.payload);
    if (typeof payload?.["callId"] === "string" && payload["callId"] === callId) {
      return event;
    }
  }
  return undefined;
}

function readToolName(value: unknown): string | undefined {
  const payload = readObject(value);
  return typeof payload?.["name"] === "string" ? payload["name"] : undefined;
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
