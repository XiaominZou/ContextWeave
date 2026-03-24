import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy, validateCapabilityPolicy, type CapabilityPolicy } from "../policies";

describe("validateCapabilityPolicy()", () => {
  test.each([
    ["native", "platform", true],
    ["inject", "platform", false],
    ["replace", "platform", false],
    ["native", "off", false],
    ["native", "tool-bridge", false],
  ])(
    "context=%s + memory=%s -> shouldFail=%s",
    (context, memory, shouldFail) => {
      const policy: CapabilityPolicy = {
        context: context as CapabilityPolicy["context"],
        memory: memory as CapabilityPolicy["memory"],
        tasks: "observe-native",
        artifacts: "observe",
      };

      if (shouldFail) {
        expect(() => validateCapabilityPolicy(policy)).toThrowError(
          expect.objectContaining({ code: "POLICY_CONFLICT" }),
        );
        return;
      }

      expect(() => validateCapabilityPolicy(policy)).not.toThrow();
    },
  );

  test("default policy always passes validation", () => {
    expect(() => validateCapabilityPolicy(defaultCapabilityPolicy)).not.toThrow();
  });
});
