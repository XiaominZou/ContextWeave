# Context Platform SDK Testing Strategy

## 1. 目标

这份文档定义 Context Platform SDK 的测试分层、测试职责、基础设施和 CI 策略。

目标只有 4 个：

- 验证 canonical model 和 policy 语义没有漂移
- 验证 adapter 实现满足统一 contract
- 验证 `runs.start()` 驱动的主路径稳定可回归
- 验证版本边界清晰，V1 不会被 V1.1/V1.2 的能力拖垮

本文以当前设计文档为准，尤其遵守这些约束：

- 业务层只通过 `RunAPI` 进入执行路径
- Event capture 永远开启
- `POLICY_CONFLICT` 和 `CAPABILITY_NOT_SUPPORTED` 必须在 adapter 调用前失败
- V1 中 `experimental.memory/context/artifacts` 的主动能力返回 `NOT_ENABLED`
- 真实 agent 进程和真实外部 API 不进入 PR CI


## 2. 测试分层

```text
manual e2e
  real agent + real API/DB
  不进 PR CI

integration tests
  client + runtime orchestration + event pipeline
  RawMockAdapter + InMemoryStore / TestPostgresStore

contract tests
  adapter-kit 标准套件
  每个 adapter 包都必须通过

unit tests
  纯函数、schema、policy、状态机
```

| 层级 | 主要目标 | 依赖 | 是否进 PR CI |
|------|----------|------|--------------|
| Unit | policy、schema、状态流转、纯函数逻辑 | 无 | 是 |
| Contract | adapter contract 一致性 | fixtures，无真实 agent | 是 |
| Integration | 平台主路径、事件管道、run 生命周期 | mock adapter + test store | 是 |
| Store Integration | postgres/object-store 适配正确性 | 测试基础设施 | 可单独 nightly |
| Manual E2E | 真实 OpenClaw / Claude Code / OpenCode 接入 | 真实 API / CLI / DB | 否 |

原则：

- 单元测试保证语义正确
- contract tests 保证适配器不跑偏
- integration tests 保证平台真正把东西串起来了
- manual e2e 只验证“和真实外部世界接起来还能跑”


## 3. 测试基础设施

建议统一放在 `@ctx/testing`。

### 3.1 Test Fixtures

提供稳定的最小对象工厂：

- `workspace()`
- `profile()`
- `session()`
- `task()`
- `run()`
- `contextSnapshot()`
- `memoryRecord()`
- `coreEvent()`

示例：

```ts
// packages/testing/src/fixtures.ts

export const fixtures = {
  workspace: (override: Partial<Workspace> = {}): Workspace => ({
    id: 'ws_test',
    name: 'Test Workspace',
    createdAt: now(),
    updatedAt: now(),
    ...override,
  }),

  session: (override: Partial<Session> = {}): Session => ({
    id: 'sess_test',
    workspaceId: 'ws_test',
    status: 'active',
    createdAt: now(),
    updatedAt: now(),
    ...override,
  }),

  task: (override: Partial<Task> = {}): Task => ({
    id: 'task_test',
    workspaceId: 'ws_test',
    sessionId: 'sess_test',
    title: 'Test Task',
    status: 'ready',
    createdAt: now(),
    updatedAt: now(),
    ...override,
  }),
};
```

### 3.2 InMemoryStore

给 unit 和大部分 integration tests 用。

要求：

- 每个 test case 都 `new InMemoryStore()`
- 支持 `sessions/tasks/runs/events/messages` 的最小 CRUD
- 支持按 `runId`、`taskId`、`sessionId` 查询
- 支持 run 状态更新与事件追加

### 3.3 RawMockAdapter

这是最重要的测试基础设施之一。

它必须模拟“真实 adapter 吐 raw events，再由平台调用 `normalizeEvent()`”的路径，而不是直接吐已经封装好的 envelope。

```ts
// packages/testing/src/raw-mock-adapter.ts

export class RawMockAdapter implements AgentAdapter {
  readonly name = 'mock';
  readonly version = '0.1.0';
  readonly invocationMode = 'sdk' as const;

  constructor(private config: {
    rawEvents: unknown[];
    externalRef?: string;
    capabilitySupport?: Partial<AdapterCapabilitySupport>;
  }) {}

  readonly capabilities: AdapterCapabilities = {
    invocationMode: 'sdk',
    streaming: true,
    toolCalls: true,
    checkpoints: false,
    resume: false,
    interrupt: true,
    nativeMcp: false,
    capabilitySupport: {
      context: 'intercept',
      memory: 'intercept',
      tasks: 'intercept',
      artifacts: 'intercept',
      ...this.config.capabilitySupport,
    },
  };

  async renderContext(input: RenderContextInput): Promise<AdapterPayload> {
    return {
      mode: 'sdk',
      systemPrompt: input.snapshot ? renderSnapshotToText(input.snapshot) : '',
      messages: [],
      tools: [],
    };
  }

  async createRun(): Promise<AdapterRunHandle> {
    const rawEvents = this.config.rawEvents;
    return {
      externalRef: this.config.externalRef ?? 'mock-ext-ref-123',
      async *streamEvents() {
        for (const raw of rawEvents) {
          yield raw;
        }
      },
      cancel: async () => {},
    };
  }

  normalizeEvent(rawEvent: unknown): AgentEventEnvelope | null {
    return normalizeMockRawEvent(rawEvent, { adapter: this.name });
  }
}
```

### 3.4 EnvelopeMockAdapter

只给少量单元测试或特殊场景使用。

用途：

- 测 RunHandle 行为
- 测终态事件收口
- 不用于验证真实 event pipeline

### 3.5 Test Platform Helper

```ts
// packages/testing/src/test-platform.ts

export function createTestPlatform(config?: {
  adapters?: AgentAdapter[];
  store?: PlatformStore;
}) {
  const store = config?.store ?? new InMemoryStore();
  const platform = createContextPlatform({ store });

  for (const adapter of config?.adapters ?? []) {
    platform.runtime.adapters.register(adapter);
  }

  return {
    platform,
    client: platform.client(),
    store,
  };
}

export async function drainHandle(handle: RunHandle): Promise<AgentEventEnvelope[]> {
  const events: AgentEventEnvelope[] = [];
  for await (const event of handle.streamEvents()) {
    events.push(event);
  }
  return events;
}
```

注意：`AdapterRegistry` 是平台内部组件，所以 helper 应该通过 `platform.runtime.adapters.register()` 之类的内部入口注册，而不是让业务侧 client 暴露 adapters。


## 4. Unit Tests

范围：`@ctx/core`

原则：纯函数、无 IO、无 mock 进程。

### 4.1 CapabilityPolicy 解析

要覆盖：

- run override 只覆盖声明的字段
- profile 缺省时回退到 default policy
- 不可变性，不修改输入对象

```ts
describe('resolveCapabilityPolicy()', () => {
  test('run override only overrides specified keys', () => {
    const profile = {
      context: 'native',
      memory: 'off',
      tasks: 'observe-native',
      artifacts: 'observe',
    } satisfies CapabilityPolicy;

    const resolved = resolveCapabilityPolicy(profile, { context: 'inject' });

    expect(resolved).toEqual({
      context: 'inject',
      memory: 'off',
      tasks: 'observe-native',
      artifacts: 'observe',
    });
  });
});
```

### 4.2 Policy 校验

要覆盖：

- `memory=platform` 但 `context=native` -> `POLICY_CONFLICT`
- adapter `observe-only` 却请求 `platform-tools` -> `CAPABILITY_NOT_SUPPORTED`
- V1.1: `context=inject` and `context=replace` can run when the adapter supports interception

这里要区分两类错误：

- 语义冲突：`POLICY_CONFLICT`
- 版本未启用：`NOT_ENABLED`

### 4.3 Event Schema 校验

要覆盖：

- envelope 必填字段
- `timestamp` 必须是 ISO 8601
- `type/payload` 必须匹配 core event schema
- adapter extension events 只校验 envelope 结构，不套 core payload 规则

### 4.4 Run 状态机

建议单独测：

- `queued -> running -> completed`
- `queued -> running -> failed`
- `queued -> running -> cancelled`
- 终态不可再次流转


## 5. Adapter Contract Tests

范围：`@ctx/adapter-kit`

原则：fixture-driven，不启动真实进程，不访问真实 API。

每个 adapter 包都必须跑同一套 contract tests。

### 5.1 Contract Tests 应测试什么

#### A. capabilities 声明正确

- `adapter.invocationMode` 与 `capabilities.invocationMode` 一致
- `capabilitySupport` 覆盖 `context/memory/tasks/artifacts`
- 值只能是 `intercept | observe-only`

#### B. `renderContext()` 行为正确

- `context=native` 不产生平台注入
- `context=inject` 时 snapshot block 内容被渲染进去
- `payload.mode` 与 adapter invocation mode 一致

注意：contract tests 不应该要求 adapter 自己生成完整的 canonical envelope 上下文。

#### C. `normalizeEvent()` 行为正确

这里建议改成测试“归一化结果”，而不是强行要求 adapter 单独补齐平台上下文字段。

更合理的 contract 是：

```ts
interface NormalizedEventResult {
  type: string;
  payload: unknown;
  rawRef?: string;
}
```

如果你们暂时不想改接口，也至少要在 contract tests 里明确：

- `workspaceId/sessionId/runId` 可以由测试 harness 注入
- adapter 负责的是 `type/payload` 正确映射
- `id/timestamp` 可由 harness 或 helper 生成

否则 adapter 会被迫持有不必要的运行态。

### 5.2 推荐的 contract harness

```ts
runAdapterContractTests({
  adapter,
  fixtures,
  envelopeContext: {
    workspaceId: 'ws_test',
    sessionId: 'sess_test',
    runId: 'run_test',
  },
});
```

### 5.3 OpenClaw / Claude Code / OpenCode 的差异点

- `openclaw`：重点测 SSE raw event 到 core events 的映射
- `claude-code`：重点测 CLI stream-json + hooks 事件映射
- `opencode`：重点测和 `claude-code` 类似的 CLI 映射，但 fixture 独立维护

不要把一个 adapter 的 raw event fixture 假设成另一个 adapter 也兼容。


## 6. Integration Tests

范围：`@ctx/client`

原则：验证平台主路径，而不是某个纯函数。

依赖：`RawMockAdapter + InMemoryStore`

### 6.1 Run 生命周期

必须覆盖：

- `runs.start()` 返回 `RunHandle`
- 创建 run 后状态为 `running`
- 流结束后自动收口到终态
- `externalRef` 被正确回填

```ts
describe('Run lifecycle', () => {
  test('queued -> running -> completed', async () => {
    const { client } = createTestPlatform({
      adapters: [new RawMockAdapter({
        rawEvents: [
          { type: 'run_started', model: 'mock-model' },
          { type: 'text_delta', text: 'hello' },
          { type: 'run_completed', reason: 'end_turn' },
        ],
      })],
    });

    const session = await client.sessions.create({ workspaceId: 'ws_1', title: 'test' });
    const task = await client.tasks.create({ workspaceId: 'ws_1', sessionId: session.id, title: 'test' });

    const handle = await client.runs.start({
      workspaceId: 'ws_1',
      sessionId: session.id,
      taskId: task.id,
      adapter: 'mock',
    });

    expect(handle.runId).toMatch(/^run_/);

    await drainHandle(handle);

    const run = await client.runs.get(handle.runId);
    expect(run.status).toBe('completed');
    expect(run.externalRef).toBe('mock-ext-ref-123');
  });
});
```

### 6.2 事件管道

必须覆盖：

- raw events 被 `normalizeEvent()` 转成 canonical events
- canonical events 被持久化
- 业务层从 `RunHandle.streamEvents()` 收到的是规范化后的事件
- 不同 run 之间事件隔离

这是当前平台最关键的集成测试之一。

### 6.3 启动前校验

必须覆盖：

- `POLICY_CONFLICT`
- `CAPABILITY_NOT_SUPPORTED`
- `NOT_ENABLED`

这里要先统一实现语义，再写断言。

当前推荐语义：

- adapter 不会被调用
- 不会创建外部 run
- canonical `Run` 记录是否落库，必须与主设计保持一致

由于当前设计文档写的是“Run record is marked failed before start”，integration tests 应该按这个语义写，而不是断言 `runs.list()` 长度为 0。

推荐断言：

```ts
await expect(client.runs.start(...)).rejects.toMatchObject({ code: 'POLICY_CONFLICT' });

const runs = await client.runs.list({ taskId: task.id });
expect(runs.items).toHaveLength(1);
expect(runs.items[0].status).toBe('failed');
```

如果你们最终决定“不落 run record”，那就必须先改主设计文档，再回头改测试。

### 6.4 V1 版本边界

这一组测试非常重要，用来防止 V1 被未来能力拖垮。

V1 中应断言：

- `context=native` 可以正常运行
- `context=inject` can run when adapter supports context interception
- `memory=tool-bridge` + configured memory engine -> bridge is exposed, with no automatic retrieval/extraction
- `memory=platform` + `context=native` -> 优先返回 `POLICY_CONFLICT`
- `tasks=observe-native` 可以正常运行
- `tasks=mirror-native` -> mirrors native todo state into canonical task metadata and status heuristics
- `tasks=platform-tools` -> exposes canonical platform task tools

也就是说，测试必须区分：

- 语义错误
- 能力未实现
- adapter 不支持

### 6.5 Interrupt / Cancel

建议补上：

- `handle.interrupt()` 后 run 进入 `cancelled`
- interrupt 后不再继续发事件
- 若 adapter 不支持 interrupt，要么在 `runs.start()` 前校验，要么在调用时返回明确错误

### 6.6 流异常收口

建议补上：

- stream 抛异常但没有显式 `run.failed` 事件时，平台是否自动收口为 `failed`
- 收口时是否记录标准化错误信息


## 7. Store Integration Tests

范围：`@ctx/store-postgres`

这些测试不建议进每次 PR 的默认 CI，可以单独 nightly 或在数据库可用时跑。

覆盖：

- sessions/tasks/runs/messages/events CRUD
- 事务边界
- 并发更新 run 状态
- event append 顺序
- 查询分页和索引命中相关行为

如果有 object store adapter，也应补：

- raw event 存储与读取
- artifact 内容存取
- checkpoint payload 存取


## 8. Manual E2E

只做手动验证，不进 PR CI。

### 8.1 OpenClaw

验证：

- 能真实完成一次 run
- 能看到 `message.delta`
- 能正确收口为 `completed`
- usage 回填正常

### 8.2 Claude Code

验证：

- CLI 进程可启动
- stream-json 事件可捕获
- 至少能看到 `tool.call` 和 `run.completed`
- 如果 hooks 已接好，能看到 CLI extension events

### 8.3 OpenCode

验证目标与 Claude Code 类似，但 fixture 与脚本分开维护。

原则：

- 手动 e2e 只验证真实接线
- 不承担完整回归职责
- 不替代 contract tests 和 integration tests


## 9. 包级测试职责

| 包 | 主要测试内容 | 测试类型 |
|----|--------------|----------|
| `@ctx/core` | policy 解析、校验、event schema、状态机 | unit |
| `@ctx/adapter-kit` | contract harness 本身 | unit |
| `@ctx/adapter-openclaw` | renderContext + normalizeEvent fixtures | contract |
| `@ctx/adapter-claude-code` | CLI raw event/hook fixtures | contract |
| `@ctx/adapter-opencode` | CLI raw event/hook fixtures | contract |
| `@ctx/client` | run lifecycle、event pipeline、policy enforcement | integration |
| `@ctx/store-postgres` | repository/store 正确性 | store integration |
| `@ctx/context-engine` | ranking、budget、explanation | unit + integration (V1.1) |
| `@ctx/memory` | search、put、extract、promote | unit + integration (V1.1+) |
| `e2e/` | 真实 agent 接线验证 | manual |


## 10. CI 策略

### 每次 PR

跑：

- `@ctx/core` unit tests
- `@ctx/adapter-kit` unit tests
- 所有 adapter contract tests
- `@ctx/client` integration tests

不跑：

- 真实 agent 进程
- 真实外部 API
- 手动 e2e

### Nightly 或手动触发

跑：

- `@ctx/store-postgres` integration tests
- object store integration tests

### 发布前手动检查

跑：

- `e2e/openclaw`
- `e2e/claude-code`
- `e2e/opencode`


## 11. 新增 Adapter Checklist

新增一个 adapter 时，至少完成：

- [ ] 收集真实 raw event 样本
- [ ] 为 `normalizeEvent()` 建立 fixture cases
- [ ] contract tests 全通过
- [ ] `context=native` 与 `context=inject` 的 `renderContext()` 行为清晰
- [ ] `capabilitySupport` 声明与实现一致
- [ ] 至少完成一次手动 e2e 接线验证


## 12. 推荐的最小测试集

如果现在就开工，我建议第一批只先写这些：

1. `resolveCapabilityPolicy()` unit tests
2. `validateCapabilityPolicy()` unit tests
3. event envelope/schema unit tests
4. `RawMockAdapter` 驱动的 run lifecycle integration tests
5. event pipeline integration tests
6. `POLICY_CONFLICT / CAPABILITY_NOT_SUPPORTED / NOT_ENABLED` integration tests
7. `adapter-openclaw` contract tests

这样可以先把 V1 最关键的骨架守住，再往上扩。
