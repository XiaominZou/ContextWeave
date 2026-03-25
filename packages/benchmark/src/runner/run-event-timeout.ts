import type { AgentEventEnvelope } from "@ctx/core";
import type { RunHandle } from "@ctx/client";

export async function collectEventsWithTimeout(
  handle: RunHandle,
  input: {
    timeoutMs: number;
    onEvent?: (event: AgentEventEnvelope) => void | Promise<void>;
  },
): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  let settled = false;

  const drainPromise = (async () => {
    for await (const event of handle.streamEvents()) {
      events.push(event);
      await input.onEvent?.(event);
      if (isTerminalRunEvent(event.type)) {
        settled = true;
        break;
      }
    }
    settled = true;
    return events;
  })();

  const timeoutPromise = new Promise<AgentEventEnvelope[]>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Timed out waiting for run ${handle.runId} after ${input.timeoutMs}ms. Events seen: ${events.map((event) => event.type).join(", ")}`));
    }, input.timeoutMs);
  });

  try {
    return await Promise.race([drainPromise, timeoutPromise]);
  } catch (error) {
    if (!settled) {
      await handle.interrupt();
    }
    throw error;
  }
}

function isTerminalRunEvent(type: string): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled";
}
