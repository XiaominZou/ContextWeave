# Benchmark 设计：Context Platform Token 节省量化

> v2 - 综合自研方案 + GPT + GLM 意见，修正关键问题

---

## 一、设计原则

### 1）任务要足够长
不能是单轮写函数。需要 **8~12 个 LLM 调用轮次的演进**，覆盖：初始开发 → bug 修复 → 需求变更 → 补测试 → 最终交付。只有长程任务才会产生上下文膨胀。

### 2）完成度要客观可衡量
用 **pytest 通过率 + 隐藏测试** 作为唯一验收标准，不依赖人工判断。两组必须达到相同完成度，token 比较才有效。

### 3）两组信息总量一致
不能让"平台组"知道更多内容。区别只在于**同样的信息如何组装成 context window**。

### 4）任务天然依赖历史状态
Agent 需要频繁引用：之前修了什么 bug、哪些接口已改、哪些测试失败过、确认过什么设计规则。这样平台的"结构化状态调度"才有价值。

### 关键区别
平台减少的是**每次 LLM 调用时的 input context 大小**，不是减少人的操作。两组用户发送的 10 条指令完全相同；差别在于 agent 每次调用 LLM 时看到的 context window：

- **无平台组**：每次 LLM 调用 = system prompt + 完整对话历史（含前几轮所有 tool call 输入输出）
- **有平台组**：每次 LLM 调用 = system prompt + 平台组装的最小 context（当前 task block + 相关记忆 + 精简历史摘要）

---

## 二、Benchmark Task：MiniKanban FastAPI Service

### 技术栈
Python 3.11 + FastAPI + Pydantic + pytest（in-memory 存储，无需数据库）

### 任务四阶段

| 阶段 | 内容 |
|------|------|
| Phase 1 | 基础 CRUD API（看板、任务、状态流转、标签） |
| Phase 2 | 业务约束（done 不可改标题、最多 5 标签、标签不可重复、**级联删除**） |
| Phase 3 | 需求变更（按标签过滤、看板统计接口） |
| Phase 4 | 收尾（统一错误码、README、修复残留 bug） |

### API 清单（8 个路由）
```
POST   /boards              创建看板
GET    /boards/{id}         查看看板
DELETE /boards/{id}         删除看板（级联删除任务）
POST   /boards/{id}/tasks   创建任务
PUT    /tasks/{id}          更新任务（标题/状态/标签）
GET    /boards/{id}/tasks   查询任务列表（支持标签过滤）
GET    /boards/{id}/stats   看板统计（todo/doing/done 数量）
DELETE /tasks/{id}          删除任务
```

### 初始骨架状态（两组共用同一份）
```
minikanban/
  app/
    main.py          ← FastAPI app 已启动，未注册路由
    models.py        ← Board/Task 模型，缺少 tags 字段
    schemas.py       ← 部分 Pydantic schema，缺少 StatsResponse
    store.py         ← InMemoryStore，缺少 delete_board / filter_by_tag
    routes/
      boards.py      ← GET/POST 已有，DELETE 缺失
      tasks.py       ← POST 已有，PUT/DELETE/GET 缺失
  tests/
    test_boards.py   ← 8 个测试（4 通过，4 故意失败）
    test_tasks.py    ← 10 个测试（6 通过，4 故意失败）
    test_stats.py    ← 5 个测试（全部失败，接口未实现）
    conftest.py      ← pytest fixtures
  SPEC.md
  README.md          ← 空白，待填写
```

**公开测试**：23 个（初始约 10 通过，13 失败）
**隐藏测试**：12 个（最终统一跑，agent 不知道内容，见第三节）
**总验收测试**：35 个

---

## 三、隐藏测试清单（12 个）

隐藏测试验证边界条件、业务规则一致性和错误处理，是 agent 最容易遗漏的部分。

| # | 测试名 | 分类 | 验证点 |
|---|--------|------|--------|
| H1 | `test_add_tag_exactly_5` | 边界 | 第 5 个标签可以添加成功 |
| H2 | `test_add_tag_exceeds_5` | 边界 | 第 6 个标签返回 422 |
| H3 | `test_add_duplicate_tag` | 边界 | 重复标签返回 422 |
| H4 | `test_empty_tags_list` | 边界 | tags 为空列表时更新正常 |
| H5 | `test_done_cannot_change_title` | 业务规则 | done 状态改标题返回 409 |
| H6 | `test_done_can_change_tags` | 业务规则 | done 状态可以改标签（规则仅限标题） |
| H7 | `test_delete_board_cascades_tasks` | 业务规则 | 删除 board 后其 tasks 不可访问 |
| H8 | `test_delete_board_stats_gone` | 业务规则 | 删除 board 后 stats 接口返回 404 |
| H9 | `test_filter_by_nonexistent_tag` | 错误处理 | 按不存在的标签过滤返回空列表（不报错） |
| H10 | `test_get_nonexistent_board` | 错误处理 | GET /boards/999 返回 404 |
| H11 | `test_update_nonexistent_task` | 错误处理 | PUT /tasks/999 返回 404 |
| H12 | `test_stats_counts_correct` | 统计 | todo/doing/done 数量与实际任务状态一致 |

---

## 四、固定 10 轮用户指令与 Task Graph 设计

两组发送**完全相同**的 10 条用户指令。平台组在内部将轮次映射到 Task Graph 节点。

### Task Graph 结构（平台组专属）

```
ROOT Task: MiniKanban 项目交付
├── T1: 分析与计划（R1）
├── T2: 基础 CRUD 实现（R2）
│   └── T2.1: 测试修复（R3）
├── T3: 业务约束实现（R4）
│   ├── T3.1: 级联删除（R5-sub1）  ← 并行子任务
│   └── T3.2: 级联删除测试（R5-sub2）← 并行子任务
├── T4: 新功能（R6, R7）
└��─ T5: 收尾（R8, R9, R10）
```

**R5 拆分的意义**：`T3.1`（实现 `store.delete_board` + 路由）和 `T3.2`（补测试）可以在平台的 task graph 中标记为并行，两个 run 的 context 各自隔离，不互相污染。Baseline 组只能串行，且后一个 run 携带前一个 run 的全部工具调用历史。

### 轮次说明

| Round | 用户指令 | 平台 Task | 平台节省点 |
|-------|----------|----------|-----------|
| R1 | 阅读 SPEC.md 和代码，总结缺什么，给出实施计划，不写代码 | T1 | 无（初始轮） |
| R2 | 实现基础 CRUD，只改最必要文件 | T2 | context 只含 T1 输出摘要，不含 R1 的文件读取原文 |
| R3 | 运行测试，列失败原因，修复前 5 个 | T2.1 | 注入测试失败摘要（working memory），不重放 R2 的代码写入历史 |
| R4 | 加入业务约束：done 不可改标题、最多 5 标签、不可重复 | T3 | episodic memory 注入"R2 确认的数据模型"，context 不含 R2/R3 tool call 原文 |
| R5 | 新增级联删除看板任务，补测试 | T3.1 + T3.2（并行） | 两个子任务 context 各自独立；baseline 串行且历史累积 |
| R6 | 新需求：按标签过滤任务列表 | T4 | context 只含相关路由 artifact 摘要，不含前 5 轮完整历史 |
| R7 | 新增统计接口 | T4 | episodic memory 注入"已有状态枚举"（R2 确认的 TaskStatus） |
| R8 | 统一错误码，更新 README | T5 | artifact 引用所有已定路由摘要，agent 不需重新列举 |
| R9 | 重跑测试，修复残留，不做重构 | T5 | working memory 只含仍在失败的测试 ID，不含已修复项历史 |
| R10 | 最终交付摘要 | T5 | structured task summary，不需重建完整历史 |

---

## 五、计量体系

### P0 依赖：run.usage token 上报

**这是计量的前提，必须优先解决。**

当前 `run.usage` 事件在 `packages/core/src/events.ts` 已定义，但 OpenCode adapter 尚未 emit。

**方案 1（推荐）：LLM API Proxy Interceptor**

在 LLM API 调用路径上插入 HTTP 代理，拦截每次请求/响应，从响应 body 解析 `usage.input_tokens` / `usage.output_tokens`，通过内部 channel 推送给 CallRecorder。优点：与 adapter 实现解耦，对所有 adapter 通用。

```
Agent → [Proxy Interceptor] → Anthropic API
                ↓
          CallRecorder (token 统计)
```

**方案 2（备选）：adapter normalizeEvent 层上报**

在 OpenCode adapter 的 `normalizeEvent()` 中解析 OpenCode 输出日志中的 token 信息并 emit `run.usage`。依赖 OpenCode 是否输出 token 统计，稳定性较低。

### 层级 1：LLM API 调用记录

```typescript
interface LlmCallRecord {
  callId: string;
  round: number;                    // 用户轮次 1-10
  subtaskId?: string;               // R5 有 T3.1 / T3.2
  mode: "baseline" | "platform-context" | "platform-context-memory-sim" | "platform-context-memory-real";
  purpose: "plan" | "patch" | "debug" | "summarize" | "other";
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timestamp: string;
  // 平台组专属：
  contextBreakdown?: {
    taskBlockTokens: number;        // 当��� task 描述
    memoryTokens: number;           // 注入的 memory records
    historyTokens: number;          // 过滤后的历史摘要
    artifactRefTokens: number;      // artifact 引用摘要
    rawHistoryTokens: number;       // 原始历史（baseline 组，平台组为 0）
    memoryExtractionTokens: number; // Mode C-real 专属：提取记忆的 LLM 成本
  };
}
```

### 层级 2：工具调用记录

```typescript
interface ToolUseRecord {
  callId: string;
  round: number;
  toolName: string;         // read_file / bash_exec / write_file
  inputSignature: string;   // JSON.stringify(input) 用于重复检测
  isError: boolean;
  availableMemoryIds: string[]; // 该 tool call 发生时平台已有的相关 memory record IDs
}
```

### Wasted Call 精确定义

**wasted call = 在 `availableMemoryIds` 非空（平台已有相关记忆）的情况下，仍然重新执行了本可由该记忆直接回答的 tool call。**

区别于"跨 round 的正常重读"：

| 场景 | 是否算 wasted |
|------|--------------|
| R1 读 models.py，R4 再读，但平台无记忆 | ❌ 不算（没有记忆可用） |
| R1 读 models.py，R4 再读，但平台已有 "Task 模型字段" 记忆 | ✅ 算（有记忆但仍重读） |
| R3 运行测试失败，R4 再运行测试确认修复效果 | ❌ 不算（目的不同） |
| R9 重跑已在 R3 通过的测试 | ✅ 算（无新信息，working memory 有记录） |

### 6 个核心指标

| 指标 | 说明 | 为什么重要 |
|------|------|-----------|
| 总 input token | 主要成本来源 | 最能体现平台压缩效果 |
| 总 output token | 通常差异较小 | 完整成本记录 |
| 总 LLM 调用次数 | 平台减少返工时也会降低 | 反映 agent 效率 |
| R6-R10 平均 input token | 后半程上下文膨胀段 | 平台优势最集中的区域 |
| 浪费工具调用比率 | wastedCalls / totalToolCalls | 反映记忆效果 |
| 单位完成成本 | 总 token / 最终完成分数 | 跨任务可比的归一化指标 |

---

## 六、完成度评分（Completion Score，100 分）

**只有两组分差 ≤ 5 分时，token 对比才有效。**

| 维度 | 分项 | 分值 |
|------|------|------|
| 功能正确性 | 公开测试通过率 (23 个) | 35 |
| 功能正确性 | 隐藏测试通过率 (12 个) | 25 |
| 代码质量 | ruff/flake8 无错误 | 10 |
| 交付质量 | README 含启动方法 + 错误码说明 | 15 |
| 过程约束 | 未删除/跳过失败测试 | 10 |
| 过程约束 | 最终代码可直接运行 | 5 |

---

## 七、三种执行模式

### Mode A：Baseline（无平台）
- 每个 round 的 LLM 调用携带完整对话历史
- `capabilityPolicy: { context: "native", memory: "off" }`

### Mode B：Platform + Context
- 平台 task graph：每个 round 对应一个 Task，R5 对应两个并行 Task
- `context=inject`：每次 run 只注入当前 task 相关的 context block
- `memory=off`
- **体现优势**：消除历史积累 + task 并行隔离

### Mode C-sim：Platform + Context + Memory（模拟上限）
- `memory=platform`，memory-extractor 使用**确定性提取**（预设内容，无 LLM 成本）
- 代表平台记忆机制的**理论最优**，不计提取成本
- 标注：⚠️ 理论上限，非真实场景

### Mode C-real：Platform + Context + Memory（真实场景）
- 同 Mode C-sim，但 memory-extractor 调用真实 LLM 进行记忆提取
- `memoryExtractionTokens` 计入总成本
- 代表实际部署下的真实节省量

> **为什么拆成两个子模式**：C-sim 展示"平台记忆机制的价值上限"；C-real 展示"扣除提取成本后的净收益"。两者都要汇报，不能只报乐观数据。

---

## 八、预期节省分析（估算，待实测验证）

> ⚠️ 以下数字基于典型 LLM coding agent 行为推算，不是实测数据。执行 benchmark 后用实际结果替换。

### 估算依据

每轮 baseline context 构成：
- system prompt：~800 tokens（固定）
- 当前指令：~100 tokens
- 累积对话历史（含 tool call IO）：随轮次线性增长，约 2,500~4,500 tokens/轮

R6 时 baseline 携带约 R1-R5 的历史 ~15,000 tokens；R9 时约 25,000+ tokens。

### Context 过滤节省（Mode B vs A）

| 轮次 | Baseline 多余历史 | Mode B 节省 |
|------|-----------------|------------|
| R1-R2 | 0~3,500 | 少 |
| R3-R5 | 3,500~10,000 | 中 |
| R6-R10 | 10,000~25,000+ | **多** |

**估算节省：input token -35~45%**，集中在 R6-R10

### 记忆节省（Mode C vs B）

典型受益场景（3 处，各约 1-2 次 LLM 调用节省）：
- R4：无需重读 models.py 确认字段（有 R2 写入的结构记忆）
- R7：无需重新探索 TaskStatus 枚举（有 R2 写入的状态记忆）
- R9：无需重跑已通过测试（有 R3 写入的 passing tests 记忆）

**估算净节省（C-real）：input token 额外 -8~12%，LLM 调用减少 10~20%**
（C-sim 理论上限约 -15%，C-real 扣除提取成本后约 -8~12%）

### 综合预估表

| 模式 | 总 Input Token | 总 LLM 调用次数 | 浪费工具调用 | vs Baseline |
|------|--------------|--------------|------------|------------|
| Baseline | ~88,000 | ~43 | ~8 | — |
| Platform+Context | ~52,000 | ~36 | ~7 | **-41%**（估算） |
| Platform+Context+Memory (C-sim) | ~38,000 | ~30 | ~3 | **-57%**（理论上限） |
| Platform+Context+Memory (C-real) | ~44,000 | ~32 | ~3 | **-50%**（含提取成本） |

---

## 九、执行路径（分阶段）

### 现在可实现（V1）

| 工作 | 说明 |
|------|------|
| `fixtures/minikanban/` | Python 骨架 + SPEC.md + 公开测试 + 隐藏测试（12 条已定义） |
| `src/harness/` | CallRecorder + ToolUseRecord + event-stream-tap + dedup-detector |
| `src/results/` | Schema + analyzer |
| LLM API Proxy Interceptor | **P0**，实现 token 上报，不依赖 adapter |
| Mode A Runner | baseline 模式，接入 OpenCode adapter |

### V1.1 后接入

| 工作 | 依赖 |
|------|------|
| Mode B Runner | `context=inject` 启用 |
| Mode C-sim Runner | `memory=platform` + deterministic extractor |
| Mode C-real Runner | `memory=platform` + LLM extractor（需计 `memoryExtractionTokens`） |

### 早期验证（模拟路径）

在 V1.1 之前，用 `RawMockAdapter` 注入预脚本化事件序列，配合 `contextBreakdown` 手工填写，验证 harness + analyzer + reporter 正确性，产出"理论对比报告"。

---

## 十、文件结构

```
packages/benchmark/
  package.json           (private: true)
  tsconfig.json

  fixtures/
    minikanban/
      app/
        main.py
        models.py
        schemas.py
        store.py
        routes/
          boards.py
          tasks.py
      tests/
        conftest.py
        test_boards.py   (公开，含故意失败)
        test_tasks.py    (公开，含故意失败)
        test_stats.py    (公开，全部失败)
        test_hidden.py   (隐藏，12 条，见第三节)
      SPEC.md
      README.md
      pyproject.toml

  src/
    harness/
      call-recorder.ts
      event-stream-tap.ts
      dedup-detector.ts
      llm-proxy-interceptor.ts  ← P0，token 上报核心
    runner/
      benchmark-runner.ts
      round-defs.ts             (10 轮指令 + task graph 映射)
      memory-extractor-sim.ts   (确定性提取，Mode C-sim)
      memory-extractor-real.ts  (LLM 提取，Mode C-real)
    modes/
      baseline.ts
      platform-context.ts
      platform-memory-sim.ts
      platform-memory-real.ts
    results/
      schema.ts
      analyzer.ts
      reporter.ts
    __tests__/
      harness.test.ts
      analyzer.test.ts
  scripts/
    run-benchmark.ts
    score-completion.ts
```

---

## 十一、关键依赖文件

| 文件 | 用途 |
|------|------|
| `packages/core/src/events.ts` | `run.usage`, `tool.call`, `tool.result` 事件类型 |
| `packages/testing/src/raw-mock-adapter.ts` | harness 单测 mock |
| `packages/testing/src/in-memory-store.ts` | benchmark 内存存储 |
| `packages/client/src/platform.ts` | `runs.start()` → RunHandle |
| `packages/client/src/internal/memory-context-snapshot.ts` | Mode C 的 context 装配入口 |
| `packages/core/src/types.ts` | ContextSnapshot, MemoryRecord 类型 |

---

## 十二、验证方案

1. **夹具验证**：骨架代码跑 pytest → 约 10 通过、13 失败
2. **修复验证**：手动全修后全部通过
3. **Proxy 验证**：LLM API proxy interceptor 正确捕获 token 数
4. **Harness 单测**：CallRecorder、detectWastedCalls、analyzer 覆盖
5. **模拟对比**：RawMockAdapter 验证四模式 results schema
6. **真实 Baseline**：`pnpm run:baseline` → `results/baseline-{ts}.json`
7. **完整对比**：`pnpm run:all` → 四模式全跑，score-completion.ts 打分，分差 ≤ 5 分后比较 token
