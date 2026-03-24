import {
  assertValidEnvelope,
  type AgentEventEnvelope,
  type CapabilityPolicy,
  type Checkpoint,
  type Run,
} from "@ctx/core";
import type { AdapterRunHandle, AgentAdapter } from "@ctx/adapter-kit";
import type { MemoryAPI, MemoryBindings, PlatformStore, RunHandle } from "../contracts";
import { AsyncEventBuffer } from "./async-event-buffer";
import { maybeCaptureArtifactsFromToolResult } from "./artifact-capture";
import { asSerializedError, mustFind, throwPlatformError } from "./errors";
import { nextId } from "./ids";
import { extractRunExperienceMemory } from "./memory-extraction";
import { buildRunDerivedContext, RUN_SUMMARY_METADATA_KEY, TOOL_CALL_REFS_METADATA_KEY } from "./run-derived-context";
import { buildRunGraphIndex, RUN_GRAPH_INDEX_METADATA_KEY } from "./session-graph";
import { applyNativeTaskMirror, maybeBuildNativeTaskMirror } from "./task-native-mirror";

export function validateFeatureAvailability(policy: CapabilityPolicy): void {
  if (policy.context !== "native" && policy.context !== "inject" && policy.context !== "replace") {
    throwPlatformError("NOT_ENABLED", `context mode is not enabled: ${policy.context}`);
  }
  if (policy.memory !== "off" && policy.memory !== "platform" && policy.memory !== "tool-bridge") {
    throwPlatformError("NOT_ENABLED", `memory mode is not enabled: ${policy.memory}`);
  }
  if (policy.tasks !== "observe-native" && policy.tasks !== "mirror-native" && policy.tasks !== "platform-tools") {
    throwPlatformError("NOT_ENABLED", `tasks mode is not enabled: ${policy.tasks}`);
  }
  if (policy.artifacts !== "observe" && policy.artifacts !== "capture-store") {
    throwPlatformError("NOT_ENABLED", `artifacts mode is not enabled: ${policy.artifacts}`);
  }
}

export function validateMemoryBindings(policy: CapabilityPolicy, bindings?: MemoryBindings): void {
  if ((policy.memory === "platform" || policy.memory === "tool-bridge") && !bindings?.engine) {
    throwPlatformError("NOT_ENABLED", `memory mode ${policy.memory} requires a configured memory engine`);
  }
}

export function validateAdapterCapabilitySupport(adapter: AgentAdapter, policy: CapabilityPolicy): void {
  const support = adapter.capabilities.capabilitySupport;
  const supportsToolBridge =
    adapter.invocationMode === "sdk" ||
    (adapter.invocationMode === "cli-process" && adapter.capabilities.nativeMcp);

  if (policy.context !== "native" && support.context === "observe-only") {
    throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter cannot intercept context capability");
  }
  if (policy.memory === "platform" && support.memory === "observe-only") {
    throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter cannot intercept memory capability");
  }
  if (policy.memory === "tool-bridge" && !supportsToolBridge) {
    throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter cannot expose tool-bridge memory capability");
  }
  if (policy.tasks !== "observe-native" && support.tasks === "observe-only") {
    throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter cannot intercept tasks capability");
  }
  if (policy.artifacts !== "observe" && support.artifacts === "observe-only") {
    throwPlatformError("CAPABILITY_NOT_SUPPORTED", "adapter cannot intercept artifacts capability");
  }
}

export function createRunHandle(
  runId: string,
  store: PlatformStore,
  buffer: AsyncEventBuffer<AgentEventEnvelope>,
  activeInterrupts: Map<string, () => Promise<void>>,
  checkpointRun: () => Promise<Checkpoint>,
): RunHandle {
  return {
    runId,
    get externalRef() {
      return store.getRun(runId)?.externalRef;
    },
    streamEvents() {
      return buffer.stream();
    },
    async interrupt() {
      const interrupt = activeInterrupts.get(runId);
      if (!interrupt) {
        return;
      }
      await interrupt();
    },
    checkpoint() {
      return checkpointRun();
    },
  };
}

export async function processRunStream(input: {
  store: PlatformStore;
  adapter: AgentAdapter;
  adapterHandle: AdapterRunHandle;
  runId: string;
  buffer: AsyncEventBuffer<AgentEventEnvelope>;
  memoryApi?: MemoryAPI;
  policy: CapabilityPolicy;
  onSettled?: () => Promise<void> | void;
}): Promise<void> {
  let sawTerminalEvent = false;
  const collectedEvents: AgentEventEnvelope[] = [];
  const capturedArtifactIds = new Set<string>();

  try {
    for await (const rawEvent of input.adapterHandle.streamEvents()) {
      const envelope = input.adapter.normalizeEvent(rawEvent);
      if (!envelope) {
        continue;
      }

      assertValidEnvelope(envelope);
      collectedEvents.push(envelope);
      input.store.appendEvent(envelope);
      input.buffer.push(envelope);

      const currentRun = mustFind(input.store.getRun(input.runId), "Run", input.runId);
      const artifactEvents = maybeCaptureArtifactsFromToolResult({
        run: currentRun,
        event: envelope,
        priorEvents: collectedEvents,
        policy: input.policy,
        store: input.store,
        capturedArtifactIds,
      });
      for (const artifactEvent of artifactEvents) {
        collectedEvents.push(artifactEvent);
        input.store.appendEvent(artifactEvent);
        input.buffer.push(artifactEvent);
      }

      maybeMirrorNativeTaskState({
        store: input.store,
        taskId: currentRun.taskId,
        event: envelope,
        priorEvents: collectedEvents,
        policy: input.policy,
      });

      if (envelope.type === "run.started") {
        const externalRef = (envelope.payload as { externalRef?: string }).externalRef;
        if (externalRef && currentRun.externalRef !== externalRef) {
          input.store.saveRun({ ...currentRun, externalRef });
        }
        continue;
      }

      if (envelope.type === "run.usage") {
        const payload = envelope.payload as { inputTokens?: number; outputTokens?: number };
        input.store.saveRun({
          ...currentRun,
          usage: {
            inputTokens: (currentRun.usage?.inputTokens ?? 0) + (payload.inputTokens ?? 0),
            outputTokens: (currentRun.usage?.outputTokens ?? 0) + (payload.outputTokens ?? 0),
          },
        });
        continue;
      }

      if (!isTerminalEvent(envelope.type)) {
        continue;
      }

      sawTerminalEvent = true;

      if (isTerminalStatus(currentRun.status)) {
        continue;
      }

      if (envelope.type === "run.completed") {
        const completedRun = input.store.saveRun({
          ...currentRun,
          status: "completed",
          endedAt: new Date().toISOString(),
        });
        void persistRunDerivedContext({
          store: input.store,
          run: completedRun,
          events: collectedEvents,
        });
        await maybeExtractExperienceMemory({
          run: completedRun,
          terminalEvent: envelope,
          store: input.store,
          buffer: input.buffer,
          memoryApi: input.memoryApi,
          policy: input.policy,
        });
        continue;
      }

      if (envelope.type === "run.failed") {
        const failedRun = input.store.saveRun({
          ...currentRun,
          status: "failed",
          endedAt: new Date().toISOString(),
          error: (envelope.payload as { error: Run["error"] }).error ?? undefined,
        });
        void persistRunDerivedContext({
          store: input.store,
          run: failedRun,
          events: collectedEvents,
        });
        continue;
      }

      const cancelledRun = input.store.saveRun({ ...currentRun, status: "cancelled", endedAt: new Date().toISOString() });
      void persistRunDerivedContext({
        store: input.store,
        run: cancelledRun,
        events: collectedEvents,
      });
    }

    if (!sawTerminalEvent) {
      const run = mustFind(input.store.getRun(input.runId), "Run", input.runId);
      if (isTerminalStatus(run.status)) {
        return;
      }

      const failedRun = input.store.saveRun({
        ...run,
        status: "failed",
        endedAt: new Date().toISOString(),
        error: {
          code: "RUN_STREAM_ENDED_WITHOUT_TERMINAL_EVENT",
          message: "Adapter stream ended without terminal event",
        },
      });
      void persistRunDerivedContext({
        store: input.store,
        run: failedRun,
        events: collectedEvents,
      });
    }
  } catch (error) {
    const run = mustFind(input.store.getRun(input.runId), "Run", input.runId);
    if (isTerminalStatus(run.status)) {
      return;
    }

    const failedRun = input.store.saveRun({
      ...run,
      status: "failed",
      endedAt: new Date().toISOString(),
      error: asSerializedError(error),
    });
    void persistRunDerivedContext({
      store: input.store,
      run: failedRun,
      events: collectedEvents,
    });
  } finally {
    try {
      await input.onSettled?.();
    } catch {
      // Cleanup failures must not affect the run lifecycle.
    }
    input.buffer.close();
  }
}

async function maybeExtractExperienceMemory(input: {
  run: Run;
  terminalEvent: AgentEventEnvelope;
  store: PlatformStore;
  buffer: AsyncEventBuffer<AgentEventEnvelope>;
  memoryApi?: MemoryAPI;
  policy: CapabilityPolicy;
}): Promise<void> {
  if (!input.memoryApi || input.policy.memory !== "platform") {
    return;
  }

  try {
    const extracted = await extractRunExperienceMemory({
      run: input.run,
      terminalEvent: input.terminalEvent,
      memoryApi: input.memoryApi,
    });

    if (extracted.length === 0) {
      return;
    }

    const extractionEvent: AgentEventEnvelope<{ memoryIds: string[]; runId: string }> = {
      id: nextId("evt"),
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      taskId: input.run.taskId,
      runId: input.run.id,
      adapter: "platform",
      type: "memory.extracted",
      timestamp: new Date().toISOString(),
      payload: {
        memoryIds: extracted.map((record) => record.id),
        runId: input.run.id,
      },
    };

    input.store.appendEvent(extractionEvent);
    input.buffer.push(extractionEvent);
  } catch {
    // Extraction failures must not affect the terminal run state in V1.1.
  }
}

async function persistRunDerivedContext(input: {
  store: PlatformStore;
  run: Run;
  events: AgentEventEnvelope[];
}): Promise<void> {
  try {
    const derived = buildRunDerivedContext({
      run: input.run,
      events: input.events,
    });
    const current = input.store.getRun(input.run.id);
    if (!current) {
      return;
    }
    input.store.saveRun({
      ...current,
      metadata: {
        ...current.metadata,
        [RUN_SUMMARY_METADATA_KEY]: derived.runSummary,
        [TOOL_CALL_REFS_METADATA_KEY]: derived.toolCallRefs,
        [RUN_GRAPH_INDEX_METADATA_KEY]: buildRunGraphIndex({
          run: current,
          runSummary: derived.runSummary,
          toolCallRefs: derived.toolCallRefs,
        }),
      },
    });
  } catch {
    // Derived run context must never affect the main run lifecycle.
  }
}

function isTerminalEvent(type: AgentEventEnvelope["type"]): boolean {
  return type === "run.completed" || type === "run.failed" || type === "run.cancelled";
}

function isTerminalStatus(status: Run["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}



function maybeMirrorNativeTaskState(input: {
  store: PlatformStore;
  taskId?: string;
  event: AgentEventEnvelope;
  priorEvents: AgentEventEnvelope[];
  policy: CapabilityPolicy;
}): void {
  if (input.policy.tasks !== "mirror-native") {
    return;
  }

  const taskId = input.taskId;
  if (!taskId) {
    return;
  }

  const task = input.store.getTask(taskId);
  if (!task) {
    return;
  }

  const mirror = maybeBuildNativeTaskMirror({
    task,
    event: input.event,
    priorEvents: input.priorEvents,
  });
  if (!mirror) {
    return;
  }

  input.store.saveTask(applyNativeTaskMirror(task, mirror));
}
