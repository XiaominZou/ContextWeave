import type { ContextBlock, ContextSnapshot, Run, Session, Task, Workspace } from "@ctx/core";

function now(): string {
  return new Date().toISOString();
}

export const fixtures = {
  workspace: (override: Partial<Workspace> = {}): Workspace => ({
    id: "ws_test",
    name: "Test Workspace",
    createdAt: now(),
    updatedAt: now(),
    ...override,
  }),

  session: (override: Partial<Session> = {}): Session => ({
    id: "sess_test",
    workspaceId: "ws_test",
    status: "active",
    createdAt: now(),
    updatedAt: now(),
    ...override,
  }),

  task: (override: Partial<Task> = {}): Task => ({
    id: "task_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    title: "Test Task",
    status: "ready",
    createdAt: now(),
    updatedAt: now(),
    ...override,
  }),

  run: (override: Partial<Run> = {}): Run => ({
    id: "run_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    taskId: "task_test",
    adapter: "mock",
    status: "running",
    attempt: 1,
    ...override,
  }),

  contextSnapshot: (blocks: ContextBlock[] = []): ContextSnapshot => ({
    id: "ctx_test",
    workspaceId: "ws_test",
    sessionId: "sess_test",
    blocks,
    tokenEstimate: blocks.reduce((sum, block) => sum + (block.tokenEstimate ?? 0), 0),
    createdAt: now(),
  }),
};

