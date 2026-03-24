import { describe, expect, test } from "vitest";

import { defaultCapabilityPolicy, resolveCapabilityPolicy, type CapabilityPolicy } from "../policies";

describe("resolveCapabilityPolicy()", () => {
  test("run policy overrides profile for specified keys only", () => {
    const profile = {
      context: "native",
      memory: "off",
      tasks: "observe-native",
      artifacts: "observe",
    } as const;

    const run = { context: "inject" } as const;

    const resolved = resolveCapabilityPolicy(profile, run);

    expect(resolved.context).toBe("inject");
    expect(resolved.memory).toBe("off");
    expect(resolved.tasks).toBe("observe-native");
    expect(resolved.artifacts).toBe("observe");
  });

  test("falls back to default when no profile or run policy are given", () => {
    expect(resolveCapabilityPolicy()).toEqual(defaultCapabilityPolicy);
  });

  test("run override does not mutate profile object", () => {
    const profile: CapabilityPolicy = {
      context: "native",
      memory: "off",
      tasks: "observe-native",
      artifacts: "observe",
    };

    resolveCapabilityPolicy(profile, { context: "inject" });

    expect(profile.context).toBe("native");
  });
});

