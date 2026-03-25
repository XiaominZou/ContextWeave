import { runAdapterContractTests } from "@ctx/adapter-kit/testing";
import type { ContextSnapshot } from "@ctx/core";
import { OpenCodeAdapter } from "../opencode-adapter";

const minimalSnapshot: ContextSnapshot = {
  id: "ctx_test",
  workspaceId: "ws_test",
  sessionId: "sess_test",
  blocks: [],
  tokenEstimate: 0,
  createdAt: new Date().toISOString(),
};

const snapshotWithBlocks: ContextSnapshot = {
  id: "ctx_test_2",
  workspaceId: "ws_test",
  sessionId: "sess_test",
  blocks: [
    { id: "b1", kind: "task", content: "Refactor auth middleware", sourceRef: "task_1", tokenEstimate: 5 },
    { id: "b2", kind: "memory", content: "User prefers TypeScript", sourceRef: "mem_1", tokenEstimate: 4 },
  ],
  tokenEstimate: 9,
  createdAt: new Date().toISOString(),
};

runAdapterContractTests(new OpenCodeAdapter({ binaryPath: "opencode" }), {
  minimalSnapshot,
  snapshotWithBlocks,
  unrecognizedRawEvent: { randomKey: "garbage_value_xyz" },
  eventNormalizationCases: [
    {
      description: "real step_start event becomes run.started",
      rawEvent: {
        type: "step_start",
        timestamp: 1773928199662,
        sessionID: "ses_real_123",
        part: {
          id: "prt_step_start",
          sessionID: "ses_real_123",
          messageID: "msg_real_123",
          type: "step-start",
        },
      },
      expectedType: "run.started",
      expectedPayloadShape: { externalRef: "ses_real_123" },
    },
    {
      description: "real text event reads nested part.text",
      rawEvent: {
        type: "text",
        timestamp: 1773928201314,
        sessionID: "ses_real_123",
        part: {
          id: "prt_text_1",
          sessionID: "ses_real_123",
          messageID: "msg_real_123",
          type: "text",
          text: "Hello",
        },
      },
      expectedType: "message.delta",
      expectedPayloadShape: { role: "assistant", text: "Hello" },
    },
    {
      description: "tool use call with nested state input",
      rawEvent: {
        type: "tool_use",
        timestamp: 1774427685541,
        sessionID: "ses_real_123",
        part: {
          id: "prt_tool_1",
          sessionID: "ses_real_123",
          messageID: "msg_real_123",
          type: "tool",
          callID: "call_abc",
          tool: "read",
          state: {
            status: "completed",
            input: { filePath: "E:\\vibecoding\\sdk\\V1\\package.json" },
          },
        },
      },
      expectedType: "tool.call",
      expectedPayloadShape: {
        callId: "call_abc",
        name: "read",
        input: { filePath: "E:\\vibecoding\\sdk\\V1\\package.json" },
      },
    },
    {
      description: "tool result",
      rawEvent: { type: "tool_result", tool_use_id: "call_abc", content: "file.ts" },
      expectedType: "tool.result",
      expectedPayloadShape: { callId: "call_abc", isError: false },
    },
    {
      description: "usage event",
      rawEvent: { type: "usage", input_tokens: 1200, output_tokens: 250 },
      expectedType: "run.usage",
      expectedPayloadShape: { inputTokens: 1200, outputTokens: 250 },
    },
    {
      description: "real run_completed event becomes run.completed",
      rawEvent: {
        type: "run_completed",
        timestamp: 1773928201332,
        sessionID: "ses_real_123",
        reason: "stop",
      },
      expectedType: "run.completed",
      expectedPayloadShape: { reason: "stop" },
    },
    {
      description: "run failure",
      rawEvent: { type: "error", error: { type: "api_error", message: "rate limited" } },
      expectedType: "run.failed",
    },
  ],
});

