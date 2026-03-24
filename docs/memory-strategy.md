# Context Platform Memory Strategy

## 1. 目标

这份文档定义 Context Platform 在 V1.1 及之后的 memory 策略，回答 4 个问题：

- 不同类型的 memory 应该在什么时候读取
- 哪些 memory 应该预注入，哪些应该按需查询
- memory 应该在什么时候写回
- 平台应该如何避免重复、冲突和陈旧结果

本文是 [context-platform-sdk-design.md](e:/vibecoding/sdk/V1/docs/context-platform-sdk-design.md) 的配套策略文档。
主设计文档定义 SDK 边界和 capability 语义；本文定义 memory 的操作策略、触发时机和演进顺序。


## 2. 当前现状

先明确当前代码的真实状态：

- `defaultCapabilityPolicy.memory = "off"`
- `validateFeatureAvailability()` 会拒绝任何 `memory !== "off"` 的运行
- `runs.start()` 传给 adapter 的 `snapshot` 目前固定为 `null`
- 当前没有 memory retrieval
- 当前没有 memory extraction
- 当前也没有在请求前将 memory 注入 prompt

换句话说：

> 当前实现里，memory 还没有真正接入运行链路。现在不是“每次请求都加 memory”，而是“一次都没有加”。


## 3. 核心原则

### 3.1 记忆类型决定检索时机

不要用一个统一触发点处理所有 memory。
不同类型的 memory，有不同的相关性窗口和最佳读取时机。

### 3.2 Run 边界是主边界

对这个平台来说，最稳定的 memory 读取边界是 `runs.start()`，最稳定的写入边界是 `run.completed` 或 `task.completed`。

### 3.3 Tool-Bridge 是纯 On-Demand

`memory: "tool-bridge"` 的语义必须是纯按需查询。
它不做预注入，不主动把 long-term memory 放进 prompt。
预注入属于 `memory: "platform"`。

### 3.4 先读后写，禁止交叉

长期 memory 的写入必须发生在 LLM 响应完成之后，不能与同一轮检索交叉。
否则模型刚生成的推断可能立刻被下一轮检索命中，形成错误反馈回路。

### 3.5 Block Schema 与 Render Convention 分离

`ContextSnapshot` 继续保持 block-based canonical schema。
`memory slot` 是推荐的渲染格式，不是 canonical 数据结构本身。


## 4. Memory 分类

建议平台内部先只保留 3 层 memory。

### 4.1 User Profile Memory

跨 session 的长期稳定偏好或身份信息。

典型内容：

- 语言偏好
- 编码风格偏好
- 长期使用习惯
- 稳定身份信息

特点：

- 稳定性最高
- 适合 session 级低频预载
- 必须依赖稳定用户身份才能安全使用

### 4.2 Task Working Memory

当前 task 完成过程中真正需要的工作记忆。

典型内容：

- 当前仓库技术栈
- 当前 task 的特殊约束
- 已验证过的中间结论
- 当前 task 的关键决策

特点：

- 与 task 强相关
- 适合 `runs.start()` 前检索
- 应支持 task 级缓存和失效策略

### 4.3 Fact / History Memory

具体事实、历史片段、低频引用知识。

典型内容：

- 某次 run 的总结
- 某条历史事实
- 某个文件或 artifact 的摘要

特点：

- 相关性窗口短
- 不适合默认全量预注入
- 更适合通过工具按需查询


## 5. 触发点模型

### Trigger 0: Session-Level Preload

触发时机：`sessions.create()` 后，或 session 首次绑定稳定身份之后。

用途：

- 读取 user profile memory
- 只加载稳定、低变动的长期偏好

前提：

- 必须存在稳定用户身份键，例如 `userId`、`accountId` 或明确的 participant identity
- 如果没有稳定身份，这一步必须跳过

默认频率：

- 每个 session 一次
- 不在同一 session 内重复检索，除非用户明确更新偏好

### Trigger 1: Pre-Run Retrieval

触发时机：`runs.start()` 前。

用途：

- 检索 task working memory
- 检索少量与当前 task 强相关的 long-term memory
- 组装 `ContextSnapshot`

这是 memory=platform 的主读取入口。

### Trigger 2: Post-Run Async Extraction

触发时机：`run.completed` 后。

用途：

- 异步提取候选 memory
- 先写入 working memory
- 只在高置信场景下 promotion 到 long-term

这条路径默认异步，不阻塞主运行链路。

### Trigger 3: Agent Tool Call

触发时机：agent 主动调用 memory 工具。

用途：

- 按需搜索 memory
- 按需写入用户确认的信息

这条路径只属于 `memory: "tool-bridge"`，语义必须是纯 on-demand。


## 6. 按记忆类型定义读取时机

### 6.1 User Profile Memory

推荐时机：Trigger 0。

策略：

- session 创建后低频预载一次
- 整个 session 内复用
- 仅在用户明确更新偏好时失效

注入方式：

- 作为 `user_profile` 固定块
- 优先出现在 memory slot 的前部

### 6.2 Task Working Memory

推荐时机：Trigger 1。

策略：

- 每次 run 都可以读取
- 但不必每次都重新全量检索
- 允许 task 级缓存

注入方式：

- 作为 `task_context` 动态块
- 随 run 刷新

### 6.3 Fact / History Memory

推荐时机：Trigger 3。

策略：

- 默认不预注入
- 让 agent 按需查找
- 仅在相关性非常高时，允许少量随 Trigger 1 混入 `task_context`

注入方式：

- 默认通过 memory tool 返回
- 不是固定 prompt 前缀的一部分


## 7. Task 级缓存与 freshness

同一个 task 可能包含多次 run。仅仅说“在 `runs.start()` 前检索”还不够，必须处理 freshness。

建议先采用轻量 task 级缓存：

- cache key: `taskId`
- cache payload: 上次检索结果 + `retrievedAt` + `runCountSinceRefresh` + `sourceMemoryVersion`

默认失效条件：

- 距上次检索超过 TTL，默认 `2 小时`
- 同 task 下累计运行次数超过 N，默认 `3`
- 有新的 user-confirmed memory 写入
- memory store 的版本号变化

V1.1 不需要做复杂 hash 方案，上述 metadata 就够用。


## 8. 注入策略

### 8.1 `memory: "platform"`

语义：

- 平台在 `runs.start()` 前读取 memory
- memory 进入 `ContextSnapshot`
- run 完成后可异步抽取候选 memory

### 8.2 `memory: "tool-bridge"`

语义：

- 平台不做预注入
- 平台只暴露 `memory.search` / `memory.write` 工具
- agent 自主决定查询时机、查询词和写入内容

这一点必须和 `memory: "platform"` 区分清楚。

### 8.3 `memory: "off"`

语义：

- 不读取 memory
- 不主动写入 memory
- 只记录事件和 canonical run metadata


## 9. 推荐的 Memory Slot 渲染格式

推荐在 adapter 渲染阶段使用稳定的 memory slot，而不是简单拼接 `blocks.map(b => b.content)`。

示意：

```xml
<platform_memory>
  <user_profile>
    ...长期稳定偏好...
  </user_profile>
  <task_context>
    ...当前 task 相关 memory...
  </task_context>
</platform_memory>
```

好处：

- 结构稳定，便于 prompt caching
- 让模型把它当作固定记忆窗口
- 调试时能一眼看出注入了什么

注意：

- 这是一种 render convention
- 不是 `ContextSnapshot` 的 canonical schema


## 10. 注入顺序建议

如果采用 prompt 注入，推荐顺序是：

1. system / adapter 固定前缀
2. `user_profile`（长期偏好，session 级）
3. `task_context`（working memory，run 级）
4. recent message history
5. 当前用户消息

这样比把稳定偏好埋在中间更好，也更能避免 lost-in-the-middle 问题。


## 11. 打分与检索排序

长期记忆和 task 相关记忆的排序建议显式包含 recency。

推荐参考公式：

`finalScore = relevance * 0.45 + importance * 0.25 + confidence * 0.15 + recency * 0.15`

其中：

`recency = exp(-lambda * days_since_written)`

说明：

- `relevance` 仍然是第一权重
- `importance` 和 `confidence` 约束长期质量
- `recency` 防止旧但高重要性的记忆长期霸榜

V1.1 可以先用简化版本，只要保留 recency 维度即可。


## 12. 写入策略

### 12.1 即时同步写入

以下场景应直接写入：

- 用户明确表达稳定偏好
- 用户纠正事实
- 用户明确说“记住这个”
- 人工反馈确认的规则

这类写入默认标记为 `user-confirmed`，并且应高优先级参与后续检索。

### 12.2 Post-Run 异步写入

以下场景应在 `run.completed` 后异步处理：

- task 中形成的重要结论
- 已验证成功的操作经验
- 值得保留的工作记忆

默认流程：

1. 从 run 事件和消息中提取候选 memory
2. 过滤噪音
3. 先写 working memory
4. 只在高置信时 promotion 到 long-term

### 12.3 Write-After-Read 约束

长期 memory 的写入不得发生在 run 执行中。

允许的最小例外：

- run-local progress state
- 不参与后续检索的瞬时状态

但任何会进入长期检索池的 memory，都必须在 `run.completed` 之后写入。


## 13. 去重与冲突处理

### 13.1 V1.1 最小策略

V1.1 不需要一开始就依赖 embeddings 才能去重。

建议先做：

- exact match dedupe
- normalized text dedupe
- 同一维度字段的 overwrite / mark-conflict 规则

例如：

- 同一用户偏好重复出现：更新 `confidence` 和 `updatedAt`
- 同一字段出现冲突值：标记为 `conflict`，等待人工或后续模型确认

### 13.2 V1.2 语义去重

到 V1.2 再引入 semantic dedupe：

- embedding similarity 检查
- 阈值可配置，不写死在策略文档里
- 命中高相似时合并或刷新，而不是无脑新增

原因：

- 不同 embedding 模型的分布差异很大
- 固定阈值更适合实现配置，不适合写成统一规范


## 14. 预算建议

memory 最容易吃掉上下文预算，因此必须先定预算。

默认建议：

- `user_profile`: `<= 10%`
- `task_context`: `<= 25%`
- recent message history: `<= 35%`
- 其余预算留给当前用户输入、system prompt 和工具结果

如果 budget 不够，建议裁剪顺序：

1. 先裁非关键 long-term memory
2. 再裁旧的 history summary
3. 最后才裁 task working memory


## 15. 解释性要求

每次 memory 被注入时，都建议至少保留以下元信息：

- memory id
- memory kind
- source scope
- inclusion reason
- token estimate
- retrieval trigger

这样以后可以回答：

- 为什么这次注入了这条记忆
- 它是 session preload 进来的，还是 run 前检索命中的
- 哪类记忆最容易污染上下文


## 16. 推荐的能力模式语义

### `memory: "off"`

- 不读 memory
- 不写 memory
- 仅记录事件

### `memory: "tool-bridge"`

- 不预注入 memory
- 平台暴露 memory 工具
- agent 自主查询和写入

### `memory: "platform"`

- Trigger 0: 可选 session-level preload
- Trigger 1: pre-run retrieval
- Trigger 2: post-run async extraction
- 需要 `context: "inject"` 或 `context: "replace"`


## 17. V1.1 最小可落地方案

建议 V1.1 只做最小闭环：

1. 支持 `memory: "platform"` 的 pre-run retrieval
2. 支持 `ContextSnapshot` 注入
3. 支持 `run.completed` 后异步提取 working memory
4. 支持 user-confirmed memory 的即时写入
5. 支持最小 task 级缓存和失效策略

明确不做：

- 复杂冲突自动裁决
- 写死 embedding 阈值
- 运行中 long-term memory 写入
- tool-bridge 和 platform 语义混合


## 18. 与当前代码的结合点

### 18.1 Read Path Hook

最自然的插入点是 `startRun()` 里当前固定 `snapshot: null` 的位置。

```ts
const snapshot = await buildContextSnapshot({
  taskId: runInput.taskId,
  sessionId: runInput.sessionId,
  workspaceId: runInput.workspaceId,
  policy: effectivePolicy,
  store,
  memoryEngine,
});

const payload = await adapter.renderContext({
  snapshot,
  policy: effectivePolicy,
  run,
});
```

### 18.2 Write Path Hook

最自然的插入点是 `processRunStream()` 终态处理之后。

```ts
if (envelope.type === "run.completed") {
  store.saveRun({ ...currentRun, status: "completed", ... });
  void extractMemoryCandidates({ runId, store, memoryEngine });
}
```


## 19. 推荐的实现顺序

### V1

- 不启用 memory
- 只保留 canonical `MemoryRecord` 类型和事件位点

### V1.1

- `buildContextSnapshot()`
- `memory.search()`
- task 级缓存
- `context=inject + memory=platform`
- `run.completed` 后异步抽取 working memory
- user-confirmed fast path

### V1.2

- `memory: "tool-bridge"`
- session-level preload with stable identity
- semantic dedupe
- promotion / conflict resolution
- richer retrieval ranking


## 20. 最终建议

一句话总结：

> 对这个平台来说，memory 应该按类型分层处理：用户稳定偏好低频预载，task working memory 在 run 边界读取，特定事实通过工具按需查询；长期写入必须在 run 完成后进行，不能和读取交叉。

如果只能先做一条最小实现路径，优先做：

> `runs.start()` 前检索 task memory -> 组装 `ContextSnapshot` -> `context=inject` 注入 -> `run.completed` 后异步抽取 working memory，并为后续 task run 提供缓存与失效机制。
