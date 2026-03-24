import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { createContextPlatform } from '@ctx/client';
import type { AgentEventEnvelope, MemoryRecordDraftV1_1, Run } from '@ctx/core';
import { OpenCodeHostAdapter } from '../index';
import { createInMemoryMemorySubsystem, InMemoryStore } from '@ctx/testing';

const fakeHostPath = fileURLToPath(new URL('./fixtures/fake-opencode-host-server.mjs', import.meta.url));

describe('OpenCodeHostAdapter transparent host path', () => {
  test('lets the platform assemble context before calling the OpenCode host API', async () => {
    const store = new InMemoryStore();
    const memory = createInMemoryMemorySubsystem();
    const adapter = new OpenCodeHostAdapter({
      binaryPath: process.execPath,
      binaryArgs: [fakeHostPath],
      cwd: process.cwd(),
    });

    const memoryRecord: MemoryRecordDraftV1_1 = {
      workspaceId: 'ws_host',
      ownerRef: { type: 'workspace', id: 'ws_host' },
      scope: 'workspace',
      layer: 'long_term',
      channel: 'collection',
      kind: 'procedure',
      status: 'active',
      title: 'Visible host token',
      content: 'HOST_MEMORY_TOKEN_2048',
      summary: 'HOST_MEMORY_TOKEN_2048',
      importance: 0.9,
      confidence: 0.9,
    };
    await memory.provider.put(memoryRecord);

    const platform = createContextPlatform({ store, memory });
    platform.runtime.adapters.register(adapter);
    const client = platform.client();

    const session = await client.sessions.create({
      workspaceId: 'ws_host',
      title: 'host integration',
      metadata: { userId: 'user_host' },
    });
    const task = await client.tasks.create({
      workspaceId: 'ws_host',
      sessionId: session.id,
      title: 'transparent host task',
      objective: 'HOST_OBJECTIVE_TOKEN_1024',
    });

    const handle = await client.runs.start({
      workspaceId: 'ws_host',
      sessionId: session.id,
      taskId: task.id,
      adapter: 'opencode-host',
      capabilityPolicy: {
        context: 'inject',
        memory: 'platform',
        tasks: 'observe-native',
        artifacts: 'observe',
      },
      metadata: {
        prompt: 'Return every visible TOKEN value separated by commas.',
      },
    });

    const events = await collectEvents(handle);
    const run = await client.runs.get(handle.runId);

    expect(run.status).toBe('completed');
    expect(run.externalRef).toMatch(/^fake_session_/);
    expect(run.snapshotId).toBeDefined();

    const text = events
      .filter((event) => event.type === 'message.delta')
      .map((event) => String((event.payload as { text?: unknown }).text ?? ''))
      .join('');

    expect(text).toContain('HOST_OBJECTIVE_TOKEN_1024');
    expect(text).toContain('HOST_MEMORY_TOKEN_2048');
  });

  test('normalizes tool parts returned by the host API', async () => {
    const adapter = new OpenCodeHostAdapter({
      binaryPath: process.execPath,
      binaryArgs: [fakeHostPath],
      cwd: process.cwd(),
    });

    const run = buildRunFixture({ metadata: { prompt: 'Call platform_task_update then answer DONE.' } });
    const payload = await adapter.renderContext({
      snapshot: null,
      policy: {
        context: 'native',
        memory: 'off',
        tasks: 'observe-native',
        artifacts: 'observe',
      },
      run,
    });

    const handle = await adapter.createRun({
      run,
      payload,
      policy: {
        context: 'native',
        memory: 'off',
        tasks: 'observe-native',
        artifacts: 'observe',
      },
    });

    const normalized = await collectNormalizedEvents(adapter, handle);
    expect(normalized.map((event) => event.type)).toEqual([
      'run.started',
      'tool.call',
      'tool.result',
      'message.delta',
      'run.completed',
    ]);
  });
});

async function collectEvents(handle: { streamEvents(): AsyncIterable<AgentEventEnvelope> }): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  for await (const event of handle.streamEvents()) {
    events.push(event);
  }
  return events;
}

async function collectNormalizedEvents(
  adapter: OpenCodeHostAdapter,
  handle: Awaited<ReturnType<OpenCodeHostAdapter['createRun']>>,
): Promise<AgentEventEnvelope[]> {
  const normalized: AgentEventEnvelope[] = [];
  for await (const rawEvent of handle.streamEvents()) {
    const envelope = adapter.normalizeEvent(rawEvent);
    if (envelope) {
      normalized.push(envelope);
    }
  }
  return normalized;
}

function buildRunFixture(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run_host_test',
    workspaceId: 'ws_host',
    sessionId: 'sess_host',
    taskId: 'task_host',
    adapter: 'opencode-host',
    status: 'running',
    attempt: 1,
    ...overrides,
  };
}
