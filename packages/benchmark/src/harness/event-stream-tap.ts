import type { AgentEventEnvelope } from "@ctx/core";
import type { RunHandle } from "@ctx/client";

export async function tapEventStream(
  handle: RunHandle,
  onEvent?: (event: AgentEventEnvelope) => void | Promise<void>,
): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  for await (const event of handle.streamEvents()) {
    events.push(event);
    await onEvent?.(event);
  }
  return events;
}
