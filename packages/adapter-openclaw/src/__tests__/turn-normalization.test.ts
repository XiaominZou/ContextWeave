import { describe, expect, it } from "vitest";

import { normalizeOpenClawAfterTurn, sliceOpenClawTurnMessages } from "../openclaw-turn-normalization";

describe("OpenClaw turn normalization", () => {
  it("slices after-turn messages using prePromptMessageCount", () => {
    const messages = [
      { role: "system", content: "ctx" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "working" },
      { role: "tool", name: "read_file", content: "ok" },
    ];

    expect(sliceOpenClawTurnMessages({
      messages,
      prePromptMessageCount: 2,
    })).toEqual([
      { role: "assistant", content: "working" },
      { role: "tool", name: "read_file", content: "ok" },
    ]);
  });

  it("normalizes new assistant and tool messages into canonical bridge events", () => {
    let nextId = 0;
    const result = normalizeOpenClawAfterTurn({
      run: {
        workspaceId: "ws_1",
        sessionId: "sess_1",
        taskId: "task_1",
        runId: "run_1",
      },
      turn: {
        sessionId: "native-session-1",
        model: "claude-test",
        prePromptMessageCount: 2,
        messages: [
          { role: "system", content: "ctx" },
          { role: "user", content: "please inspect" },
          { role: "assistant", id: "msg_1", content: "I checked the file." },
          {
            role: "tool",
            name: "read_file",
            toolCallId: "call_1",
            input: { path: "README.md" },
            content: "done",
          },
        ],
        runtimeContext: {
          usage: {
            input_tokens: 10,
            output_tokens: 5,
          },
        },
        autoCompactionSummary: "compacted",
      },
      createEventId: () => `evt_${++nextId}`,
      now: () => "2026-03-28T12:00:00.000Z",
    });

    expect(result.newMessages).toEqual([
      { role: "assistant", id: "msg_1", content: "I checked the file." },
      {
        role: "tool",
        name: "read_file",
        toolCallId: "call_1",
        input: { path: "README.md" },
        content: "done",
      },
    ]);
    expect(result.events.map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run.started",
        payload: {
          model: "claude-test",
          externalRef: "native-session-1",
        },
      },
      {
        type: "run.usage",
        payload: {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: undefined,
          cacheWriteInputTokens: undefined,
        },
      },
      {
        type: "message.delta",
        payload: {
          role: "assistant",
          text: "I checked the file.",
        },
      },
      {
        type: "message.completed",
        payload: {
          messageId: "msg_1",
        },
      },
      {
        type: "tool.call",
        payload: {
          callId: "call_1",
          name: "read_file",
          input: { path: "README.md" },
        },
      },
      {
        type: "tool.result",
        payload: {
          callId: "call_1",
          output: "done",
          isError: false,
        },
      },
    ]);
    expect(result.finalize).toEqual({
      status: "completed",
      reason: "turn_complete_with_compaction",
    });
  });

  it("normalizes real OpenClaw assistant toolCall blocks and toolResult messages", () => {
    let nextId = 0;
    const result = normalizeOpenClawAfterTurn({
      run: {
        workspaceId: "ws_1",
        sessionId: "sess_1",
        taskId: "task_1",
        runId: "run_1",
      },
      turn: {
        sessionId: "native-session-1",
        prePromptMessageCount: 1,
        messages: [
          { role: "user", content: [{ type: "text", text: "Reply with exactly the word OK." }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "internal" },
              { type: "text", text: "OK" },
              {
                type: "toolCall",
                id: "call_memory_1",
                name: "memory_search",
                arguments: { query: "recent", maxResults: 5 },
              },
            ],
            usage: {
              input: 29,
              output: 48,
              cacheRead: 10816,
              cacheWrite: 0,
            },
          },
          {
            role: "toolResult",
            toolCallId: "call_memory_1",
            toolName: "memory_search",
            content: [{ type: "text", text: "{ \"results\": [] }" }],
            details: { results: [] },
            isError: false,
          },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "internal" },
              { type: "text", text: "OK" },
            ],
            usage: {
              input: 111,
              output: 71,
              cacheRead: 10816,
              cacheWrite: 0,
            },
          },
        ],
      },
      createEventId: () => `evt_${++nextId}`,
      now: () => "2026-03-30T12:00:00.000Z",
    });

    expect(result.newMessages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "OK" },
          {
            type: "toolCall",
            id: "call_memory_1",
            name: "memory_search",
            arguments: { query: "recent", maxResults: 5 },
          },
        ],
        usage: {
          input: 29,
          output: 48,
          cacheRead: 10816,
          cacheWrite: 0,
        },
      },
      {
        role: "toolResult",
        toolCallId: "call_memory_1",
        toolName: "memory_search",
        content: [{ type: "text", text: "{ \"results\": [] }" }],
        details: { results: [] },
        isError: false,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "internal" },
          { type: "text", text: "OK" },
        ],
        usage: {
          input: 111,
          output: 71,
          cacheRead: 10816,
          cacheWrite: 0,
        },
      },
    ]);
    expect(result.events.map((event) => ({ type: event.type, payload: event.payload }))).toEqual([
      {
        type: "run.started",
        payload: {
          model: undefined,
          externalRef: "native-session-1",
        },
      },
      {
        type: "run.usage",
        payload: {
          inputTokens: 111,
          outputTokens: 71,
          cacheReadInputTokens: 10816,
          cacheWriteInputTokens: 0,
        },
      },
      {
        type: "message.delta",
        payload: {
          role: "assistant",
          text: "OK",
        },
      },
      {
        type: "tool.call",
        payload: {
          callId: "call_memory_1",
          name: "memory_search",
          input: { query: "recent", maxResults: 5 },
        },
      },
      {
        type: "message.completed",
        payload: {
          messageId: "openclaw_msg_1",
        },
      },
      {
        type: "tool.result",
        payload: {
          callId: "call_memory_1",
          output: { results: [] },
          isError: false,
        },
      },
      {
        type: "message.delta",
        payload: {
          role: "assistant",
          text: "OK",
        },
      },
      {
        type: "message.completed",
        payload: {
          messageId: "openclaw_msg_2",
        },
      },
    ]);
    expect(result.finalize).toEqual({
      status: "completed",
      reason: "turn_complete",
    });
  });

  it("derives failed and cancelled finalization states from turn metadata", () => {
    const failed = normalizeOpenClawAfterTurn({
      run: {
        workspaceId: "ws_1",
        sessionId: "sess_1",
        taskId: "task_1",
        runId: "run_1",
      },
      turn: {
        sessionId: "native-session-1",
        prePromptMessageCount: 0,
        messages: [],
        status: "failed",
        error: { code: "MODEL_ERROR", message: "upstream failure" },
      },
    });
    const cancelled = normalizeOpenClawAfterTurn({
      run: {
        workspaceId: "ws_1",
        sessionId: "sess_1",
        taskId: "task_1",
        runId: "run_2",
      },
      turn: {
        sessionId: "native-session-1",
        prePromptMessageCount: 0,
        messages: [],
        cancelled: true,
        runtimeContext: { reason: "user interrupted" },
      },
    });

    expect(failed.finalize).toEqual({
      status: "failed",
      reason: "upstream failure",
      error: {
        code: "MODEL_ERROR",
        message: "upstream failure",
        details: { code: "MODEL_ERROR", message: "upstream failure" },
      },
    });
    expect(cancelled.finalize).toEqual({
      status: "cancelled",
      reason: "user interrupted",
    });
  });
});
