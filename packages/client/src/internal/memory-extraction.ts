import type {
  AgentEventEnvelope,
  MemoryRecordV1_1,
  Run,
  WriteExperienceInput,
} from "@ctx/core";
import { resolveDefaultMemoryChannel } from "@ctx/core";
import type { MemoryAPI } from "../contracts";

export async function extractRunExperienceMemory(input: {
  run: Run;
  terminalEvent: AgentEventEnvelope;
  memoryApi: MemoryAPI;
}): Promise<MemoryRecordV1_1[]> {
  if (input.terminalEvent.type !== "run.completed") {
    return [];
  }

  const record = await input.memoryApi.writeExperience({
    record: buildExperienceRecord(input),
  });

  return [record];
}

function buildExperienceRecord(input: {
  run: Run;
  terminalEvent: AgentEventEnvelope;
}): WriteExperienceInput["record"] {
  const title = buildTitle(input.run);
  const content = buildContent(input.run, input.terminalEvent);
  const summary = buildSummary(input.run, input.terminalEvent);

  return {
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sessionId,
    taskId: input.run.taskId,
    runId: input.run.id,
    ownerRef: { type: "run", id: input.run.id },
    scope: "run",
    layer: "experience",
    channel: resolveDefaultMemoryChannel("insight"),
    kind: "insight",
    status: "candidate",
    title,
    content,
    summary,
    importance: 0.55,
    confidence: 0.6,
    sourceRefs: [
      { type: "run", id: input.run.id },
      { type: "event", id: input.terminalEvent.id },
    ],
    confirmedBy: "system",
  };
}

function buildTitle(run: Run): string {
  const prompt = typeof run.metadata?.["prompt"] === "string" ? String(run.metadata["prompt"]).trim() : undefined;
  if (prompt) {
    return `Run experience: ${truncate(prompt, 80)}`;
  }
  return `Run experience for task ${run.taskId}`;
}

function buildSummary(run: Run, terminalEvent: AgentEventEnvelope): string {
  const reason = readReason(terminalEvent);
  const prompt = typeof run.metadata?.["prompt"] === "string" ? String(run.metadata["prompt"]).trim() : undefined;
  const fragments = [
    `Run ${run.id} completed`,
    reason ? `with reason: ${reason}` : undefined,
    prompt ? `for prompt: ${truncate(prompt, 120)}` : undefined,
  ].filter((value): value is string => Boolean(value));
  return fragments.join("; ");
}

function buildContent(run: Run, terminalEvent: AgentEventEnvelope): string {
  const lines = [
    `Run ID: ${run.id}`,
    `Task ID: ${run.taskId}`,
    `Adapter: ${run.adapter}`,
    run.model ? `Model: ${run.model}` : undefined,
    readReason(terminalEvent) ? `Completion reason: ${readReason(terminalEvent)}` : undefined,
    typeof run.metadata?.["prompt"] === "string" ? `Prompt: ${String(run.metadata["prompt"]).trim()}` : undefined,
  ].filter((value): value is string => Boolean(value));

  return lines.join("\n");
}

function readReason(event: AgentEventEnvelope): string | undefined {
  const payload = event.payload as { reason?: unknown } | undefined;
  return typeof payload?.reason === "string" ? payload.reason : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

