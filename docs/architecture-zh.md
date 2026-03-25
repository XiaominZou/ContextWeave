# Context Platform 架构说明

## 1. 目标

本文档基于当前仓库实现，说明 Context Platform 的运行时架构、能力路由、适配器分层，以及最新的 OpenCode benchmark 相关逻辑。

与本文对应的英文文档：

- `docs/architecture.md`
- `docs/benchmark-diagnostics.md`

当前架构围绕 4 个基本原则展开：

- 平台始终拥有 canonical 的 `Session`、`Task`、`Run`
- 业务代码只能通过 `RunAPI` 进入执行链路
- adapter 是运行时集成层，不是业务侧直接操作的 SDK 对象
- 无论能力模式如何，事件采集与 canonical 持久化都必须成立


## 2. 系统总览

```text
业务应用
  -> @ctx/client
     -> SessionAPI / TaskAPI / RunAPI / EventAPI / experimental{...}
        -> CapabilityRouter
           -> Platform Runtime
              -> AdapterRegistry
              -> Event Pipeline
              -> Store Layer
              -> Optional Capability Engines
```

高层数据流：

```text
业务应用
  -> client.runs.start()
     -> resolve policy
     -> validate policy / adapter support
     -> 可选的 session-level memory preload
     -> 在 context 启用时构建 ContextSnapshot
     -> 在 memory=platform 时检索任务相关 memory
     -> render adapter payload
     -> create adapter run
     -> capture / normalize / persist / emit events
     -> terminal event 到达后收口 run
     -> run 完成后可选地异步提取 memory
```


## 3. 核心组件

### 3.1 `@ctx/client`

业务侧唯一稳定入口。

职责：

- 暴露 `SessionAPI`、`TaskAPI`、`RunAPI`、`EventAPI`
- 暴露 `experimental.memory/context/artifacts`
- 屏蔽 adapter 细节
- 将执行入口统一收敛到 `RunAPI.start()`

关键入口：

- [platform.ts](/E:/vibecoding/sdk/V1/packages/client/src/platform.ts)
- [contracts.ts](/E:/vibecoding/sdk/V1/packages/client/src/contracts.ts)

### 3.2 CapabilityRouter

位于 client/runtime 边界内部的编排层。

职责：

- 解析最终 `CapabilityPolicy`
- 校验 policy 语义冲突
- 校验 adapter 是否支持所请求的拦截能力
- 在能力启用时路由到平台自有实现
- 在能力关闭时退回 native 行为

### 3.3 Platform Runtime

平台内部的执行层。

职责：

- 管理 adapter registry
- 创建 canonical run
- 启动并维护 event pipeline
- 更新 canonical run 状态
- 暴露内部 bootstrap / registration 能力

### 3.4 Adapters

adapter 是 runtime 集成模块，不拥有业务语义。

当前实现可以分成两类：

- black-box adapter：外部拉起 runtime，观测事件，拦截能力有限
- transparent runtime adapter：更靠近 runtime 的 context plane，尽量让上下文主控权前置到平台

当前仓库里的主要目标 adapter：

- `adapter-openclaw`
- `adapter-opencode`

adapter 的职责：

- 渲染 runtime 所需 payload
- 创建 native run
- 归一化原始 runtime 事件
- 声明 capability support

adapter 不负责：

- canonical session/task/run 所有权
- 业务语义
- policy 决策

### 3.5 Store Layer

用于保存 canonical 状态和大对象。

当前测试/本地路径大量依赖内存实现，但架构上推荐拆分为：

- 关系型数据库：canonical entity 与事务性元数据
- 对象存储：raw events、checkpoints、大型 artifacts
- Redis：热缓存或短生命周期状态
- 向量库或 `pgvector`：后续 semantic memory

### 3.6 Optional Capability Engines

这些能力按阶段逐步引入：

- context assembly
- memory retrieval / extraction / consolidation
- artifact capture
- task mirroring / platform tools

它们都不应成为 V1 主执行链路的前置条件。


## 4. Canonical Control Plane

平台控制面从 `RunAPI.start()` 开始。

### 4.1 `runs.start()` 主链路

```text
1. 校验 workspace / session / task / adapter 引用
2. 创建 queued 状态的 canonical Run
3. resolve effective CapabilityPolicy
4. validate policy semantics
5. validate adapter capability support
6. 若请求的功能当前不可用，则返回 NOT_ENABLED
7. 若 context 模式要求构建 snapshot，则 build ContextSnapshot
8. render adapter payload
9. create adapter run
10. 将 Run 更新为 running，并绑定 externalRef
11. 启动后台 event pipeline
12. 向业务层返回 RunHandle
```

### 4.2 Adapter 调用前失败

以下失败发生在 adapter 被真正调用前：

- `POLICY_CONFLICT`
- `CAPABILITY_NOT_SUPPORTED`
- `NOT_ENABLED`
- adapter 不存在或 bootstrap 解析失败

当前一致性约束：

- canonical `Run` 可能已经被创建
- 如果验证失败，run 要被标记为 failed-before-start
- 不应创建外部 runtime run

### 4.3 RunHandle

业务层拿到的是 `RunHandle`，不是 adapter handle。

```ts
interface RunHandle {
  runId: string;
  externalRef?: string;
  streamEvents(): AsyncIterable<AgentEventEnvelope>;
  interrupt(): Promise<void>;
  checkpoint(): Promise<Checkpoint>;
}
```


## 5. Event Pipeline

Event Pipeline 是平台运行时的核心循环。

### 5.1 原则

adapter 产出原始 runtime 事件，平台负责把它们：

- 归一化为 canonical event
- 校验 envelope
- 持久化
- 发回给业务层订阅者

```text
raw runtime event
  -> adapter.normalizeEvent(raw)
  -> canonical event envelope
  -> schema validation
  -> persistence
  -> RunHandle.streamEvents()
```

### 5.2 Pipeline 阶段

```text
1. 从 adapter stream 读取 raw event
2. 在需要时保留 raw event ref
3. normalize 成 canonical event
4. validate envelope / payload
5. persist 到 run_events
6. 触发 side effects
7. emit 给 RunHandle 订阅者
8. 观察 terminal event 后收口 run 状态
```

### 5.3 Side Effects

根据 capability mode 和当前实现，pipeline 还会：

- 追加 normalized messages
- 记录 token usage
- 创建 artifact 记录
- 更新 `externalRef`
- 将 run 转为 `completed` / `failed` / `cancelled`
- 在 run 完成后写入 run/task/session derived context
- 在 `memory=platform` 时触发异步 memory extraction

### 5.4 Terminal State Ownership

terminal state 由平台 runtime 管理。

也就是说：

- 业务层不会直接调用 run 的 complete/fail
- run 的结束状态来自 terminal event 或 terminal stream failure
- 如果 stream 无 terminal event 就异常结束，平台必须将 run 关闭为 `failed`

补充一点最新实现细节：

- benchmark 侧的 `collectEventsWithTimeout()` 现在在看到 `run.completed`、`run.failed`、`run.cancelled` 时会主动收口，不再继续傻等 stream 自然结束


## 6. Capability Routing Model

平台始终拥有 canonical entity，但 capability 行为是增量启用的。

### 6.1 Effective Policy Resolution

```text
Run.capabilityPolicy
  > AgentProfile.capabilityPolicy
  > defaultCapabilityPolicy
```

### 6.2 Context Capability

模式：

- `native`
- `inject`
- `replace`

运行时语义：

- `native`：不构建 snapshot，由 agent 自己管理上下文
- `inject`：平台构建 snapshot，并把平台内容附加注入
- `replace`：平台构建 snapshot，并完全主控发送的上下文

当前实现要点：

- `native`、`inject`、`replace` 都可用
- snapshot 构建走 collector pipeline，来源包括 task、task summary、run summaries、session summary、memory hits 等
- graph-aware candidate scoring 已启用
- block 会被标注 `drop` / `summary-only` / `expand`
- `summary-only` 在当前实现里已经真正影响渲染，不再只是 metadata 标签

### 6.3 Context Hints

`CapabilityPolicy` 现在额外支持 `contextHints`，用于对 snapshot 构建做更细粒度控制。

当前已实现的 hint：

- `suppressRunSummaries?: boolean`

用途：

- benchmark 诊断中发现，早期轮次注入 run-summary 会改变 OpenCode 的执行策略
- 因此在 real benchmark 的早期轮次，对非-baseline 模式可以显式压制 run summaries

### 6.4 Memory Capability

模式：

- `off`
- `tool-bridge`
- `platform`

运行时语义：

- `off`：仅观察，不主动提供 memory 能力
- `tool-bridge`：把平台 memory 工具暴露给 runtime，走纯按需路径
- `platform`：run 前检索任务相关 memory，run 后异步抽取 candidate memory

约束：

- `memory=platform` 依赖 `context=inject|replace`
- 长期 memory 的写回发生在 run 完成后，而不是同一轮检索周期中

当前实现要点：

- session-level profile preload 可用
- pre-run retrieval 可用
- post-run extraction 可用
- task-level consolidation 与 session archive consolidation 已接通

### 6.5 Tasks Capability

模式：

- `observe-native`
- `mirror-native`
- `platform-tools`

当前实现状态：

- `observe-native` 是默认基线
- `mirror-native` 已通过 native todo 工具结果镜像到 task metadata
- `platform-tools` 已通过 task bridge 生效

### 6.6 Artifacts Capability

模式：

- `observe`
- `capture-store`

当前实现状态：

- `observe` 会保留 artifact-like 事件与引用
- `capture-store` 会持久化规范化后的 `Artifact` 记录，并通过 `experimental.artifacts` 暴露

### 6.7 Capability Support vs Policy

policy 表示平台“想做什么”，adapter capability support 表示 runtime“能拦到什么”。

如果 policy 请求的拦截能力超出 adapter 支持范围，平台必须 fail fast，不能静默降级。


## 7. Context Assembly 与裁剪

### 7.1 Snapshot 来源

当前 `ContextSnapshot` 的 collector pipeline 会从这些来源收集候选：

- 当前 task
- task summary
- dependency task summaries
- prior run summaries
- session summary
- memory preload / memory search 命中

### 7.2 Graph-Aware Pruning

平台不会直接篡改 canonical timeline，而是在其之上维护一个派生检索结构。

当前方向是：

- canonical truth 保持时间序列
- 额外派生 graph 结构做检索与裁剪
- 优先使用 summary 和轻量 ref，而不是盲目展开原文
- 每个 block 决策为 `drop` / `summary-only` / `expand`

### 7.3 Summary-Only 渲染

这是最近一次重要修正。

之前：

- graph 会给 block 打 `summary-only`
- 但最终渲染时仍把完整 `content` 注入 prompt

现在：

- 渲染统一走 `renderSnapshotToPromptText()`
- `summary-only` block 会被压缩渲染
- `expand` 才会输出完整内容

这使得 retention 决策终于从“只存在于 metadata”变成“真正影响 token”

### 7.4 Token Budget 与去重

当前 snapshot 组装还具备这些能力：

- 总 token budget 约束
- path normalization，避免相同文件因绝对路径差异被视为不同对象
- run-derived context 中记录 `readFilePaths`

`readFilePaths` 的意义不是强制 agent 不再重读，而是把“上一轮读过哪些文件”变成平台可注入的事实。


## 8. OpenCode 集成现状

OpenCode 目前是仓库里最完整的一条真实 adapter 路径。

### 8.1 CLI Adapter

实现：

- [opencode-adapter.ts](/E:/vibecoding/sdk/V1/packages/adapter-opencode/src/opencode-adapter.ts)

特点：

- 通过子进程执行 `opencode run --format json`
- 从 stdout 按行读取 JSON 事件
- 将 OpenCode 事件映射为平台 canonical event

### 8.2 Host Adapter

实现：

- [opencode-host-adapter.ts](/E:/vibecoding/sdk/V1/packages/adapter-opencode/src/opencode-host-adapter.ts)

特点：

- 启动 `opencode serve`
- 通过 HTTP API 创建 session / 发送消息 / 轮询状态
- 比 CLI 模式更接近透明运行时接管

### 8.3 统一 Context 渲染

实现：

- [context-render.ts](/E:/vibecoding/sdk/V1/packages/adapter-opencode/src/context-render.ts)

作用：

- CLI 与 host 两条 OpenCode 路径共享同一份 snapshot 渲染逻辑
- 保证 `summary-only` / `expand` 的行为一致

### 8.4 Usage Accounting

OpenCode benchmark 最近补齐了 cache-aware usage 统计。

现在会同时记录：

- `inputTokens`
- `cacheReadInputTokens`
- `cacheWriteInputTokens`

因此 benchmark 里可以同时看：

- 未缓存输入成本
- 含 cache read 的真实总提示规模


## 9. Benchmark 架构

### 9.1 Real Probe 与 Real Benchmark

当前 benchmark 包里已经有这些真实 runner：

- `opencode-real-probe`
- `opencode-real-benchmark`
- `opencode-warm-benchmark`

对应脚本：

- [run-opencode-real-probe.ts](/E:/vibecoding/sdk/V1/packages/benchmark/scripts/run-opencode-real-probe.ts)
- [run-opencode-real-benchmark.ts](/E:/vibecoding/sdk/V1/packages/benchmark/scripts/run-opencode-real-benchmark.ts)
- [run-opencode-warm-benchmark.ts](/E:/vibecoding/sdk/V1/packages/benchmark/scripts/run-opencode-warm-benchmark.ts)

### 9.2 Round Diagnostics

real benchmark 现在会输出每轮诊断信息：

- `snapshotTokenEstimate`
- `includedBlockCount`
- `excludedBlockCount`
- `promptTextLength`
- `sourceTypeCounts`
- `retentionCounts`

这让我们能区分：

- 是 prompt 真的变大了
- 还是 agent 行为路径变长了

### 9.3 Tool 行为诊断

benchmark 聚合层现在还会统计：

- `totalToolCalls`
- `readToolCalls`
- `distinctReadTargets`
- `repeatedReadCallRatio`
- `bashToolCalls`

再配合 path normalization，可以更稳定地判断 agent 是否在重复读同一份文件。

### 9.4 Warm Continuation Benchmark

最近新增了 seeded warm benchmark。

设计目标：

- 不再靠 live pass1 生成半完成状态
- 直接从“确定性的半完成代码 + 确定性的 seeded platform state”起跑
- 测 continuation，而不是测冷启动 prompt following

当前实现要点：

- 每个 iteration 都重新复制 fixture，保证跨 iteration 隔离
- 同一 iteration 内共享同一个 fixture 副本
- 通过代码 seed 将 MiniKanban 固定在一个稳定的半完成状态
- 通过 synthetic run/task/session summary 预灌平台上下文
- 输出 `pass2CallsBeforeFirstEdit`、`pass2ReadToolCalls`、`pass2RepeatedReadRatio` 等 continuation 指标

### 9.5 当前 Warm Benchmark 结论

当前 seeded warm benchmark 已经能稳定产出有效样本，但默认 `repeat=3` 的正式长跑仍容易因为单轮过长而超时。

就现有单次样本看：

- `platform-context` 在重复读和工具往返上已经优于 baseline
- 但 cache-aware token 总量仍更高

因此 warm benchmark 目前更适合：

- 做 continuation 行为诊断
- 验证平台是否减少重复 onboarding / 重复读取

而不是直接把“总 token 更低”当作唯一成功标准


## 10. Persistence Model

推荐的 canonical 表包括：

- `workspaces`
- `agent_profiles`
- `sessions`
- `tasks`
- `runs`
- `messages`
- `memory_records`
- `memory_links`
- `artifacts`
- `checkpoints`
- `context_policies`
- `context_snapshots`
- `context_snapshot_blocks`
- `run_events`
- `run_event_raw_refs`

事件持久化建议拆分为：

```text
normalized canonical events -> relational store
raw event blobs             -> object store
```


## 11. Package Dependency Model

推荐依赖方向：

```text
@ctx/core
  <- @ctx/adapter-kit
  <- @ctx/testing
  <- @ctx/client
  <- @ctx/adapter-openclaw
  <- @ctx/adapter-opencode

@ctx/context-engine
@ctx/memory
  -> enabled 时由 @ctx/client/runtime 消费
```

规则：

- `@ctx/core` 保持轻依赖
- adapter 依赖 core contract，不依赖业务代码
- 业务代码依赖 `@ctx/client`，不直接依赖 adapter 包


## 12. 当前版本边界

### 12.1 V1 已落地

- canonical entity ownership
- `RunAPI.start()` 主路径
- 内部 adapter registry
- event capture / persistence
- baseline capability modes

### 12.2 V1.1 / 当前活跃能力

- `ContextSnapshot` build path
- `context=inject|replace`
- `memory=platform`
- session preload / pre-run retrieval / post-run extraction
- run/task/session summary
- graph-aware retrieval / pruning
- minimal task bridge / memory bridge / artifact capture

### 12.3 V1.2 / 当前扩展

- `adapter-opencode`
- CLI extension events
- cache-aware usage accounting
- real benchmark / warm benchmark runner
- path normalization
- continuation-oriented benchmark instrumentation


## 13. 总结

当前架构可以概括为一句话：

平台负责 canonical state 和 context lifecycle，adapter 负责 runtime 集成，agent 负责真正执行。

更具体一点：

- `@ctx/core` 负责 canonical contract
- `@ctx/client` 负责统一 SDK 和 orchestration
- Platform Runtime 负责 run 生命周期与 capability routing
- Event Pipeline 负责把 runtime 输出变成平台事实
- Context / Memory / Artifact 负责运行前后的知识组织
- Benchmark 层负责把这些能力变化转成可诊断的行为指标

如果后续继续看代码，推荐顺序是：

1. [platform.ts](/E:/vibecoding/sdk/V1/packages/client/src/platform.ts)
2. [run-runtime.ts](/E:/vibecoding/sdk/V1/packages/client/src/internal/run-runtime.ts)
3. [memory-context-snapshot.ts](/E:/vibecoding/sdk/V1/packages/client/src/internal/memory-context-snapshot.ts)
4. [session-graph.ts](/E:/vibecoding/sdk/V1/packages/client/src/internal/session-graph.ts)
5. [opencode-adapter.ts](/E:/vibecoding/sdk/V1/packages/adapter-opencode/src/opencode-adapter.ts)
6. [opencode-host-adapter.ts](/E:/vibecoding/sdk/V1/packages/adapter-opencode/src/opencode-host-adapter.ts)
7. [opencode-real-benchmark.ts](/E:/vibecoding/sdk/V1/packages/benchmark/src/runner/opencode-real-benchmark.ts)
8. [opencode-warm-benchmark.ts](/E:/vibecoding/sdk/V1/packages/benchmark/src/runner/opencode-warm-benchmark.ts)

读完这几层，基本就能把“平台控制面”和“agent 执行面”的边界看清楚。
