## Context

### 背景
Context Platform V1 当前实现了事件观察功能，但 `context=inject` 和 `memory=platform` 被 `validateFeatureAvailability()` 阻塞，返回 `NOT_ENABLED`。为了验证平台的核心价值（token 节省），需要先设计 benchmark 框架，然后在启用这些功能前后分别测量。

### 当前状态
- `run.usage` 事件在 `events.ts` 中已定义，但 adapter 层未实现上报
- Memory 系统的 provider 和 engine 在 `testing/src/in-memory-memory.ts` 中已实现
- Context snapshot 构建在 `client/src/internal/memory-context-snapshot.ts` 中已实现
- 但 `run-runtime.ts` 会拒绝任何非 native 模式

### 约束
- Benchmark 必须公平：两组完成度分差 ≤ 5 分
- 任务结果必须可量化：pytest 通过率
- 需要体现两个优势点：context 过滤 + memory 注入

## Goals / Non-Goals

**Goals:**
1. 设计一个 8-12 轮 LLM 调用的长程任务，能产生上下文膨胀
2. 实现四种执行模式的对比（Baseline / Platform+Context / Platform+Context+Memory-sim / Platform+Context+Memory-real）
3. 建立 token 计量体系，精确记录每次 LLM 调用的 input/output token，包括 memoryExtractionTokens
4. 定义客观的完成度评分标准
5. 量化"浪费工具调用"（wasted calls）以体现 memory 价值

**Non-Goals:**
1. 不实现 embedding 向量检索（V1.1 之后）
2. 不实现 session-level preload（V1.1 之后）
3. 不实现 task freshness 缓存
4. 不在本 change 中启用 `context=inject` 和 `memory=platform`（那是 v1.1-context-injection 和 v1.1-memory-platform 的任务）

## Decisions

### D1: 任务选择 - MiniKanban FastAPI Service

**选择**: 使用 FastAPI + pytest 实现看板 API

**理由**:
- 跨文件修改（models/routes/tests）
- 多轮需求变更（Phase 1-4）
- 有业务规则需要"记住"（done 状态不可改标题、标签限制）
- pytest 提供客观 pass/fail 验收
- 工程上真实，有代表性

**替代方案**:
- CLI 工具：缺乏 API 测试的标准化
- 前端组件：测试环境复杂，难以量化
- 纯算法题：太短，无法产生上下文膨胀

### D2: 四种模式分层对比

**选择**: 
- Mode A (Baseline): context=native, memory=off
- Mode B (Platform+Context): context=inject, memory=off  
- Mode C-sim (Platform+Context+Memory-sim): context=inject, memory=platform, 确定性提取
- Mode C-real (Platform+Context+Memory-real): context=inject, memory=platform, LLM 提取

**理由**: 分层设计能独立验证两个优势点和提取成本
- Mode B vs A: 验证 context 过滤节省
- Mode C-sim vs B: 验证 memory 注入的理论上限节省
- Mode C-real vs C-sim: 量化 memory 提取的 LLM 成本
- Mode C-real vs B: 验证真实场景下的净节省

### D3: Memory 提取策略 - C-sim 和 C-real 双轨制

**选择**: 提供 C-sim（确定性提取）和 C-real（LLM 提取）两种子模式

**C-sim (Simulated)**:
- 使用基于规则的确定性提取，不调用 LLM
- 结果代表"理论上限"
- 适合验证框架正确性和快速迭代

**C-real (Realistic)**:
- 使用 LLM 进行 memory 提取
- 计入 `memoryExtractionTokens` 成本
- 结果代表"真实场景下的净节省"

**理由**:
- C-sim 用于早期验证和开发调试
- C-real 用于生产环境真实评估
- 两者对比可以量化 memory 提取的 LLM 成本

**已决策**: "浪费工具调用"定义为"当 availableMemoryIds 非空时仍重复执行相同 inputSignature 的 tool call"

### D4: 隐藏测试设计

**选择**: 12 个隐藏测试，覆盖边界条件和业务规则

**内容**:
- 边界条件（空标签、超过 5 个标签、重复标签）
- 业务规则违反（done 状态改标题、级联删除验证）
- 错误处理（不存在的 board/task ID）

**理由**: 防止 agent 针对公开测试过拟合

### D5: Token 计量来源

**选择**: 优先使用 LLM API proxy interceptor

**理由**:
- 更通用，不依赖 adapter 实现
- 精确，直接从 API 响应获取

**备选**: 在各 adapter 的 normalizeEvent() 中解析并 emit `run.usage`

## Risks / Trade-offs

### R1: run.usage 未实现
**风险**: adapter 层未上报 token 使用量，无法计量
**缓解**: 
1. 优先方案：实现 LLM API proxy interceptor
2. 备选：在 OpenCode adapter 中解析输出并 emit `run.usage`

### R2: Mode B/C 功能未启用
**风险**: `validateFeatureAvailability()` 阻塞非 native 模式
**缓解**: 
1. 先用 RawMockAdapter 模拟验证框架正确性
2. 在 v1.1-context-injection change 中移除限制

### R3: 预期节省数据不可靠
**风险**: -41%、-57% 的预估值缺乏依据
**缓解**: 在报告中明确标注为"待验证"，不作为承诺

### R4: Memory 提取成本被忽略（已通过 C-real 模式解决）

~~**风险**: 确定性提取不反映真实场景的 LLM 成本~~
**解决方案**: 提供 C-real 模式，使用 LLM 提取并计入 memoryExtractionTokens

### R5: ~~双层 session-task 图未体现~~（已解决）

~~**风险**: 10 轮指令是线性的，未体现 task graph 的层级调度~~
**解决方案**: 已在 D7 中决策，R5 拆分为两个并行子任务

### D6: 隐藏测试具体内容

**已决策**: 12 个隐藏测试已在 benchmark-plan.md 中详细定义，覆盖：
- 边界条件（空标签列表、超过 5 个标签、重复标签）
- 业务规则违反（done 状态改标题、级联删除验证）
- 错误处理（不存在的 board/task ID）

### D7: R5 并行子任务设计

**已决策**: R5 拆分为两个并行子任务：
- T3.1: 实现级联删除（DELETE /boards/{id}）
- T3.2: 补充级联删除测试

这体现了"双层 session-task 图"的优势：父任务完成基础实现后，子任务可并行执行。

## Open Questions

1. **embedding 向量检索**: V1.1 是否需要实现？还是继续用文本匹配？
