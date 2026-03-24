## Why

当前 Context Platform 的核心价值主张是：
1. 在不影响任务完成度的前提下减少 input token
2. 通过 memory 减少重复探索和无效工具调用

现有想法方向是对的，但 benchmark 设计里混入了并行 task graph、理论上界模式等额外变量，容易让最终结论变成“整个平台更强”，而不是更清晰地回答“上下文接管本身是否省 token”。

因此这里把 benchmark 收紧成一个更轻量、可复用、可解释的版本。

## What Changes

- 新增一个以 MiniKanban 为基准任务的 benchmark 框架
- 主 benchmark 只比较三种模式：
  - Mode A: Baseline
  - Mode B: Platform+Context
  - Mode C-real: Platform+Context+Memory
- C-sim 保留为可选辅助模式，只用于内部调试或展示理论上界，不作为主结果
- 所有模式统一使用同一组 10 轮用户指令、同一串行执行流程、同一 fixture
- 新增更严格但仍然简单的公平性校验：
  - hidden tests 通过数差异不得超过 1
  - 总 completion score 差异不得超过 5
- 新增重复运行要求，默认每个模式至少运行 5 次并报告中位数

## Capabilities

### New Capabilities

- `benchmark-harness`: 记录 LLM 调用、token、工具调用和结果
- `benchmark-fixture`: MiniKanban FastAPI + pytest 基准项目
- `benchmark-runner`: A / B / C-real 三种主模式执行器，C-sim 为可选辅助执行器
- `benchmark-metrics`: token 聚合、公平性校验、重复运行汇总和结果报告

## Impact

### 新增代码

- `packages/benchmark/`
  - `fixtures/minikanban/`
  - `src/harness/`
  - `src/runner/`
  - `src/results/`

### 依赖关系

- 依赖 `packages/core/src/events.ts` 中的 `run.usage`
- 依赖 `packages/testing/src/raw-mock-adapter.ts` 做早期验证
- Mode B / C-real 依赖 `context=inject` 和 `memory=platform`

### 外部依赖

- Python 3.11+
- pytest
