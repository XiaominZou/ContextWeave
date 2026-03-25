import { describe, expect, test } from "vitest";
import type { AgentEventEnvelope } from "@ctx/core";
import type { RunHandle } from "@ctx/client";
import { collectEventsWithTimeout } from "../runner/run-event-timeout";

describe("collectEventsWithTimeout()", () => {
  test("resolves when a terminal run event is observed even if the stream stays open", async () => {
    let interrupted = false;
    const handle: RunHandle = {
      runId: "run_test",
      async *streamEvents() {
        yield makeEvent("run.started");
        yield makeEvent("run.failed");
        await new Promise(() => {
          // Keep the iterator pending to simulate adapters that never close the stream.
        });
      },
      async interrupt() {
        interrupted = true;
      },
      async checkpoint() {
        throw new Error("checkpoint not used in test");
      },
    };

    const events = await collectEventsWithTimeout(handle, { timeoutMs: 50 });

    expect(events.map((event) => event.type)).toEqual(["run.started", "run.failed"]);
    expect(interrupted).toBe(false);
  });
});

function makeEvent(type: string): AgentEventEnvelope {
  return {
    id: `${type}-1`,
    workspaceId: "ws_test",
    sessionId: "session_test",
    taskId: "task_test",
    runId: "run_test",
    adapter: "test",
    type,
    timestamp: "2026-03-25T00:00:00.000Z",
    payload: {},
  };
}
