import { runAdapterContractTests, buildSnapshotFixture } from "@ctx/adapter-kit/testing";

import { OpenClawAdapter } from "../openclaw-adapter";

const adapter = new OpenClawAdapter();

runAdapterContractTests(adapter, {
  minimalSnapshot: buildSnapshotFixture(),
  snapshotWithBlocks: buildSnapshotFixture([
    {
      id: "block_1",
      kind: "system",
      title: "Task",
      content: "[PLATFORM_CONTEXT]\nCurrent task: repair context selection",
      sourceRef: "task:task_test",
      tokenEstimate: 8,
    },
    {
      id: "block_2",
      kind: "memory",
      title: "Memory",
      content: "Remember to preserve canonical run ownership in the platform.",
      sourceRef: "memory:mem_1",
      tokenEstimate: 10,
    },
  ]),
  eventNormalizationCases: [
    {
      description: "run started event",
      rawEvent: { type: "run_started", model: "claude-sonnet-4-5", runId: "ocl_run_1" },
      expectedType: "run.started",
      expectedPayloadShape: { model: "claude-sonnet-4-5", externalRef: "ocl_run_1" },
    },
    {
      description: "assistant text delta",
      rawEvent: { type: "response.output_text.delta", delta: { text: "hello" } },
      expectedType: "message.delta",
      expectedPayloadShape: { role: "assistant", text: "hello" },
    },
    {
      description: "tool call event",
      rawEvent: { type: "tool_use", id: "call_1", name: "search_files", input: { query: "adapter" } },
      expectedType: "tool.call",
      expectedPayloadShape: { callId: "call_1", name: "search_files", input: { query: "adapter" } },
    },
    {
      description: "usage event",
      rawEvent: { type: "usage", input_tokens: 1200, output_tokens: 250 },
      expectedType: "run.usage",
      expectedPayloadShape: { inputTokens: 1200, outputTokens: 250 },
    },
    {
      description: "run completed event",
      rawEvent: { type: "response.completed", reason: "end_turn" },
      expectedType: "run.completed",
      expectedPayloadShape: { reason: "end_turn" },
    },
  ],
  unrecognizedRawEvent: { type: "totally.unknown" },
});
