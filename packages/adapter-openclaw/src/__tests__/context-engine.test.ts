import { describe, expect, it, vi } from "vitest";

import {
  createOpenClawContextEngineBridge,
} from "../openclaw-context-engine";

describe("OpenClaw context engine bridge", () => {
  it("passes lifecycle hooks through to the platform bridge", async () => {
    const bootstrap = vi.fn(async () => ({ bootstrapped: true, importedMessages: 2 }));
    const ingest = vi.fn(async () => ({ ingested: true }));
    const assemble = vi.fn(async () => ({
      messages: [{ role: "system", content: "platform context" }],
      estimatedTokens: 24,
      systemPromptAddition: "Task: use the platform context plane.",
    }));
    const compact = vi.fn(async () => ({
      ok: true,
      compacted: false,
      result: { tokensBefore: 100, tokensAfter: 72 },
    }));
    const afterTurn = vi.fn(async () => undefined);

    const engine = createOpenClawContextEngineBridge({
      engineId: "ctx-platform",
      engineName: "Context Platform",
      ownsCompaction: true,
      bootstrap,
      ingest,
      assemble,
      compact,
      afterTurn,
    });

    const bootstrapResult = await engine.bootstrap?.({
      sessionId: "ses_1",
      sessionFile: "session.json",
    });
    const ingestResult = await engine.ingest({
      sessionId: "ses_1",
      message: { role: "user", content: "hello" },
    });
    const assembleResult = await engine.assemble({
      sessionId: "ses_1",
      messages: [{ role: "user", content: "hello" }],
      prompt: "hello",
    });
    const compactResult = await engine.compact({
      sessionId: "ses_1",
      sessionFile: "session.json",
      currentTokenCount: 100,
    });
    await engine.afterTurn?.({
      sessionId: "ses_1",
      sessionFile: "session.json",
      messages: [{ role: "assistant", content: "done" }],
      prePromptMessageCount: 1,
    });

    expect(engine.info).toEqual({
      id: "ctx-platform",
      name: "Context Platform",
      version: undefined,
      ownsCompaction: true,
    });
    expect(bootstrapResult).toEqual({ bootstrapped: true, importedMessages: 2 });
    expect(ingestResult).toEqual({ ingested: true });
    expect(assembleResult).toEqual({
      messages: [{ role: "system", content: "platform context" }],
      estimatedTokens: 24,
      systemPromptAddition: "Task: use the platform context plane.",
    });
    expect(compactResult).toEqual({
      ok: true,
      compacted: false,
      result: { tokensBefore: 100, tokensAfter: 72 },
    });
    expect(bootstrap).toHaveBeenCalledOnce();
    expect(ingest).toHaveBeenCalledOnce();
    expect(assemble).toHaveBeenCalledOnce();
    expect(compact).toHaveBeenCalledOnce();
    expect(afterTurn).toHaveBeenCalledOnce();
  });
});
