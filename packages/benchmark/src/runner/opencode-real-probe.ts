import { createContextPlatform } from "@ctx/client";
import { OpenCodeAdapter } from "@ctx/adapter-opencode";
import { createInMemoryMemorySubsystem, InMemoryStore } from "@ctx/testing";
import { defaultCapabilityPolicy } from "@ctx/core";
import { CallRecorder } from "../harness/call-recorder";
import { tapEventStream } from "../harness/event-stream-tap";
import { detectWastedCalls } from "../harness/dedup-detector";
import type { BenchmarkAnalysis, BenchmarkMode, BenchmarkRunResult, CompletionScore } from "../results/schema";
import { analyzeBenchmarkResults } from "../results/analyzer";
import { prepareBaselineConfigOverlay } from "./opencode-run-env";
import { collectEventsWithTimeout } from "./run-event-timeout";

const OPENCODE_CMD = "C:\\Users\\zxm\\AppData\\Roaming\\npm\\opencode.cmd";

export interface RunRealOpenCodeProbeInput {
  repeatCount?: number;
  binaryPath?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface RunRealOpenCodeProbeOutput {
  runs: BenchmarkRunResult[];
  analysis: BenchmarkAnalysis;
}

export async function runRealOpenCodeProbe(input: RunRealOpenCodeProbeInput = {}): Promise<RunRealOpenCodeProbeOutput> {
  const repeatCount = input.repeatCount ?? 1;
  const runs: BenchmarkRunResult[] = [];
  const cwd = input.cwd ?? process.cwd();
  const binaryPath = input.binaryPath ?? OPENCODE_CMD;

  for (let iteration = 1; iteration <= repeatCount; iteration += 1) {
    const timeoutMs = input.timeoutMs ?? 60_000;
    runs.push(await runProbeIteration("baseline", iteration, { cwd, binaryPath, timeoutMs }));
    runs.push(await runProbeIteration("platform-context", iteration, { cwd, binaryPath, timeoutMs }));
    runs.push(await runProbeIteration("platform-context-memory-real", iteration, { cwd, binaryPath, timeoutMs }));
  }

  return {
    runs,
    analysis: analyzeBenchmarkResults(runs),
  };
}

async function runProbeIteration(
  mode: Extract<BenchmarkMode, "baseline" | "platform-context" | "platform-context-memory-real">,
  iteration: number,
  config: { cwd: string; binaryPath: string; timeoutMs: number },
): Promise<BenchmarkRunResult> {
  const store = new InMemoryStore();
  const memorySubsystem = mode === "platform-context-memory-real" ? createInMemoryMemorySubsystem() : undefined;
  const platform = createContextPlatform({ store, memory: memorySubsystem });
  const baselineOverlay = mode === "baseline" ? await prepareBaselineConfigOverlay() : undefined;
  platform.runtime.adapters.register(
    new OpenCodeAdapter({
      binaryPath: config.binaryPath,
      cwd: config.cwd,
      env: baselineOverlay?.env,
    }),
  );
  try {
    const client = platform.client();
    const workspaceId = `ws_real_probe_${mode}_${iteration}`;
    const session = await client.sessions.create({
      workspaceId,
      title: `real probe ${mode} ${iteration}`,
    });

    const objectiveToken = `OBJECTIVE_TOKEN_${iteration}`;
    const memoryToken = `MEMORY_TOKEN_${iteration}`;

    if (memorySubsystem) {
      await memorySubsystem.provider.put({
        workspaceId,
        ownerRef: { type: "workspace", id: workspaceId },
        scope: "workspace",
        layer: "long_term",
        channel: "collection",
        kind: "procedure",
        status: "active",
        title: "Probe memory token",
        content: memoryToken,
        summary: memoryToken,
        importance: 0.9,
        confidence: 0.9,
      });
    }

    const task = await client.tasks.create({
      workspaceId,
      sessionId: session.id,
      title: `Probe ${mode}`,
      objective: objectiveToken,
    });

    const capabilityPolicy =
      mode === "baseline"
        ? defaultCapabilityPolicy
        : mode === "platform-context"
          ? { ...defaultCapabilityPolicy, context: "inject" as const }
          : {
              ...defaultCapabilityPolicy,
              context: "inject" as const,
              memory: "platform" as const,
            };

    const prompt =
      "Read the available context and reply with every visible TOKEN value separated by commas. If none are visible, reply exactly NONE.";

    const handle = await client.runs.start({
      workspaceId,
      sessionId: session.id,
      taskId: task.id,
      adapter: "opencode",
      capabilityPolicy,
      metadata: { prompt },
    });

    const recorder = new CallRecorder();
    const assistantChunks: string[] = [];
    await collectEventsWithTimeout(handle, {
      timeoutMs: config.timeoutMs,
      onEvent: async (event) => {
        recorder.record({
          event,
          mode,
          round: 1,
          purpose: "other",
        });
        if (event.type === "message.delta") {
          assistantChunks.push(String((event.payload as { text?: unknown }).text ?? ""));
        }
      },
    });

    await assertProbeRunCompleted({
      client,
      runId: handle.runId,
      mode,
      iteration,
    });

    const snapshot = recorder.snapshot();
    const assistantText = assistantChunks.join("");
    const completion = scoreProbeCompletion({
      mode,
      assistantText,
      objectiveToken,
      memoryToken,
    });

    return {
      mode,
      iteration,
      llmCalls: snapshot.llmCalls,
      toolCalls: snapshot.toolCalls,
      wastedCalls: detectWastedCalls(snapshot.toolCalls),
      completion,
    };
  } finally {
    await safeCleanup(baselineOverlay);
  }
}

function scoreProbeCompletion(input: {
  mode: BenchmarkMode;
  assistantText: string;
  objectiveToken: string;
  memoryToken: string;
}): CompletionScore {
  const text = input.assistantText.trim();
  let passed = false;

  if (input.mode === "baseline") {
    passed = text.toUpperCase() === "NONE";
  } else if (input.mode === "platform-context") {
    passed = text.includes(input.objectiveToken);
  } else if (input.mode === "platform-context-memory-real") {
    passed = text.includes(input.objectiveToken) && text.includes(input.memoryToken);
  }

  return {
    total: passed ? 100 : 0,
    publicTestsPassed: passed ? 1 : 0,
    publicTestsTotal: 1,
    hiddenTestsPassed: passed ? 1 : 0,
    hiddenTestsTotal: 1,
    codeQualityPoints: passed ? 10 : 0,
    deliveryPoints: passed ? 15 : 0,
    processPoints: passed ? 15 : 0,
  };
}

async function assertProbeRunCompleted(input: {
  client: ReturnType<ReturnType<typeof createContextPlatform>["client"]>;
  runId: string;
  mode: string;
  iteration: number;
}): Promise<void> {
  const run = await input.client.runs.get(input.runId);
  if (run.status === "completed") {
    return;
  }

  const reason = run.error ? `${run.error.code}: ${run.error.message}` : `status=${run.status}`;
  throw new Error(`real probe run failed for mode=${input.mode} iteration=${input.iteration}: ${reason}`);
}

async function safeCleanup(resource?: { cleanup(): Promise<void> }): Promise<void> {
  if (!resource) {
    return;
  }
  try {
    await resource.cleanup();
  } catch {
    // Ignore temporary overlay cleanup failures during local real-agent probing.
  }
}
