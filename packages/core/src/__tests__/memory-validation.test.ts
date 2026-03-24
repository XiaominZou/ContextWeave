import { describe, expect, test } from "vitest";

import {
  resolveDefaultMemoryChannel,
  validateWriteConfirmedInput,
  validateWriteExperienceInput,
  type WriteConfirmedInput,
  type WriteExperienceInput,
} from "../index";

function makeBaseRecord() {
  return {
    workspaceId: "ws_1",
    sessionId: "sess_1",
    taskId: "task_1",
    runId: "run_1",
    ownerRef: { type: "run" as const, id: "run_1" },
    scope: "run" as const,
    layer: "experience" as const,
    channel: "collection" as const,
    kind: "insight" as const,
    title: "Successful pattern",
    content: "Use the provider-engine split for memory SPI.",
  };
}

describe("memory validation", () => {
  test("accepts a valid experience write", () => {
    const input: WriteExperienceInput = {
      record: makeBaseRecord(),
    };

    expect(() => validateWriteExperienceInput(input)).not.toThrow();
  });

  test("rejects global scope in V1.1", () => {
    const input: WriteExperienceInput = {
      record: {
        ...makeBaseRecord(),
        scope: "global",
      },
    };

    expect(() => validateWriteExperienceInput(input)).toThrowError(
      expect.objectContaining({ code: "NOT_ENABLED" }),
    );
  });

  test("rejects task scope without taskId", () => {
    const input: WriteExperienceInput = {
      record: {
        ...makeBaseRecord(),
        scope: "task",
        taskId: undefined,
        ownerRef: { type: "session", id: "sess_1" },
      },
    };

    expect(() => validateWriteExperienceInput(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_MEMORY_WRITE" }),
    );
  });

  test("rejects ownerRef mismatch", () => {
    const input: WriteExperienceInput = {
      record: {
        ...makeBaseRecord(),
        ownerRef: { type: "task", id: "task_other" },
      },
    };

    expect(() => validateWriteExperienceInput(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_MEMORY_WRITE" }),
    );
  });

  test("defaults preference to profile and insight to collection", () => {
    expect(resolveDefaultMemoryChannel("preference")).toBe("profile");
    expect(resolveDefaultMemoryChannel("insight")).toBe("collection");
    expect(resolveDefaultMemoryChannel("constraint")).toBe("collection");
  });

  test("rejects profile channel for unstable scopes", () => {
    const input: WriteExperienceInput = {
      record: {
        ...makeBaseRecord(),
        channel: "profile",
      },
    };

    expect(() => validateWriteExperienceInput(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_MEMORY_WRITE" }),
    );
  });

  test("rejects system-written experience profile memory", () => {
    const input: WriteExperienceInput = {
      record: {
        ...makeBaseRecord(),
        scope: "user",
        userId: "user_1",
        ownerRef: { type: "user", id: "user_1" },
        channel: "profile",
        kind: "preference",
        confirmedBy: "system",
      },
    };

    expect(() => validateWriteExperienceInput(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_MEMORY_WRITE" }),
    );
  });

  test("confirmed writes require confirmedBy", () => {
    const input = {
      record: {
        ...makeBaseRecord(),
      },
    } as WriteConfirmedInput;

    expect(() => validateWriteConfirmedInput(input)).toThrowError(
      expect.objectContaining({ code: "INVALID_MEMORY_WRITE" }),
    );
  });

  test("accepts user-confirmed profile writes at stable scope", () => {
    const input: WriteConfirmedInput = {
      record: {
        ...makeBaseRecord(),
        scope: "user",
        userId: "user_1",
        ownerRef: { type: "user", id: "user_1" },
        layer: "long_term",
        channel: "profile",
        kind: "preference",
        confirmedBy: "user",
      },
    };

    expect(() => validateWriteConfirmedInput(input)).not.toThrow();
  });
});
