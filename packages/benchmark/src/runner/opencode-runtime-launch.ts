import type { ContextPlatform, RunHandle } from "@ctx/client";
import type { CapabilityPolicy } from "@ctx/core";
import { OpenCodeAdapter, OpenCodePlatformHost } from "@ctx/adapter-opencode";

export type OpenCodeTransport = "cli" | "host" | "mixed-host";

export interface OpenCodeRuntimeOptions {
  binaryPath: string;
  binaryArgs?: string[];
  agent?: string;
  cwd: string;
  env?: Record<string, string>;
  startupTimeoutMs?: number;
}

export interface OpenCodeExecutionSelection {
  usePlatformHost: boolean;
  previewAdapter: string;
  adapterName?: "opencode";
}

export function registerOpenCodeCliAdapter(platform: ContextPlatform, options: OpenCodeRuntimeOptions): void {
  platform.runtime.adapters.register(
    new OpenCodeAdapter({
      binaryPath: options.binaryPath,
      binaryArgs: options.binaryArgs,
      agent: options.agent,
      cwd: options.cwd,
      env: options.env,
    }),
  );
}

export function createOpenCodePlatformHost(options: OpenCodeRuntimeOptions): OpenCodePlatformHost {
  return new OpenCodePlatformHost({
    binaryPath: options.binaryPath,
    binaryArgs: options.binaryArgs,
    agent: options.agent,
    cwd: options.cwd,
    env: options.env,
    startupTimeoutMs: options.startupTimeoutMs,
  });
}

export function resolveOpenCodeExecution(input: {
  transport: OpenCodeTransport;
  isBaseline: boolean;
}): OpenCodeExecutionSelection {
  if (input.transport === "cli") {
    return {
      usePlatformHost: false,
      previewAdapter: "opencode",
      adapterName: "opencode",
    };
  }
  if (input.transport === "host") {
    return {
      usePlatformHost: true,
      previewAdapter: "opencode-platform-host",
    };
  }
  if (input.isBaseline) {
    return {
      usePlatformHost: false,
      previewAdapter: "opencode",
      adapterName: "opencode",
    };
  }
  return {
    usePlatformHost: true,
    previewAdapter: "opencode-platform-host",
  };
}

export async function launchOpenCodeRun(input: {
  platform: ContextPlatform;
  client: ReturnType<ContextPlatform["client"]>;
  host: OpenCodePlatformHost;
  selection: OpenCodeExecutionSelection;
  workspaceId: string;
  sessionId: string;
  taskId: string;
  capabilityPolicy: CapabilityPolicy;
  prompt: string;
}): Promise<RunHandle> {
  if (!input.selection.usePlatformHost) {
    return await input.client.runs.start({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      adapter: input.selection.adapterName ?? "opencode",
      capabilityPolicy: input.capabilityPolicy,
      metadata: {
        prompt: input.prompt,
      },
    });
  }

  const hostHandle = await input.host.startRun({
    bridge: input.platform.runtime.bridge,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    capabilityPolicy: input.capabilityPolicy,
    metadata: {
      prompt: input.prompt,
    },
  });

  return {
    runId: hostHandle.runId,
    streamEvents() {
      return hostHandle.streamEvents();
    },
    interrupt() {
      return hostHandle.interrupt();
    },
    checkpoint() {
      return hostHandle.checkpoint();
    },
  };
}
