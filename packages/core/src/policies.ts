export type ContextMode = "native" | "inject" | "replace";

export type MemoryMode = "off" | "tool-bridge" | "platform";

export type TasksMode = "observe-native" | "mirror-native" | "platform-tools";

export type ArtifactsMode = "observe" | "capture-store";

export interface CapabilityContextHints {
  suppressRunSummaries?: boolean;
}

export interface CapabilityPolicy {
  context: ContextMode;
  memory: MemoryMode;
  tasks: TasksMode;
  artifacts: ArtifactsMode;
  contextHints?: CapabilityContextHints;
}

export const defaultCapabilityPolicy: CapabilityPolicy = {
  context: "native",
  memory: "off",
  tasks: "observe-native",
  artifacts: "observe",
};

export type CapabilityInterceptLevel = "intercept" | "observe-only";

export interface AdapterCapabilitySupport {
  context: CapabilityInterceptLevel;
  memory: CapabilityInterceptLevel;
  tasks: CapabilityInterceptLevel;
  artifacts: CapabilityInterceptLevel;
}

export function resolveCapabilityPolicy(
  profilePolicy?: Partial<CapabilityPolicy>,
  runPolicy?: Partial<CapabilityPolicy>,
): CapabilityPolicy {
  return {
    ...defaultCapabilityPolicy,
    ...profilePolicy,
    ...runPolicy,
  };
}

export function validateCapabilityPolicy(policy: CapabilityPolicy): void {
  if (policy.memory === "platform" && policy.context === "native") {
    const error = new Error("memory=platform requires context=inject or replace") as Error & {
      code: string;
    };
    error.code = "POLICY_CONFLICT";
    throw error;
  }
}
