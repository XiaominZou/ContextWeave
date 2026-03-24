import { describe, expect, test } from "vitest";

import { assertValidEnvelope, type AgentEventEnvelope } from "../events";

const validEnvelope: AgentEventEnvelope = {
  id: "evt_1",
  workspaceId: "ws_1",
  sessionId: "sess_1",
  runId: "run_1",
  adapter: "mock",
  type: "run.started",
  timestamp: "2025-01-01T00:00:00.000Z",
  payload: { model: "claude-opus-4-1" },
};

describe("assertValidEnvelope()", () => {
  test("valid core event passes", () => {
    expect(() => assertValidEnvelope(validEnvelope)).not.toThrow();
  });

  test("envelope missing runId fails", () => {
    const bad = { ...validEnvelope, runId: "" };

    expect(() => assertValidEnvelope(bad)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  test("timestamp must be ISO 8601", () => {
    const bad = { ...validEnvelope, timestamp: "not-a-date" };

    expect(() => assertValidEnvelope(bad)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });

  test("payload is required", () => {
    const bad = { ...validEnvelope, payload: undefined } as unknown as AgentEventEnvelope;

    expect(() => assertValidEnvelope(bad)).toThrowError(
      expect.objectContaining({ code: "INVALID_EVENT" }),
    );
  });
});
