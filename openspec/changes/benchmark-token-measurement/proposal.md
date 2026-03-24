## Why

当前 Context Platform 声称能够通过双层 session-task 图和记忆机制减少 agent 的 token 消耗，但缺乏量化数据支撑。需要设计一个公平、可重复的 benchmark 来验证：
1. Context 过滤机制能减少多少 input token（通过消除历史对话和 tool call 结果的累积）
2. Memory 机制能减少多少试错成本（通过注入已有结论避免重复探索）

这是验证平台核心价值的关键步骤，也是向用户证明 ROI 的基础。

## What Changes

- **新增** benchmark 测试框架，用于测量 agent 原生 vs 接入平台后的 token 消耗差异
- **新增** MiniKanban 测试项目作为 benchmark 任务（FastAPI + pytest）
- **新增** 四种执行模式：Baseline / Platform+Context / Platform+Context+Memory-sim / Platform+Context+Memory-real
- **新增** 计量体系：LLM 调用级 token 记录 + 工具调用级浪费检测
- **新增** 完成度评分系统：确保公平比较的前提条件

## Capabilities

### New Capabilities

- `benchmark-harness`: Benchmark 执行框架，包括 CallRecorder、ToolUseRecord、EventStreamTap、DedupDetector
- `benchmark-fixture`: MiniKanban 测试项目骨架（Python FastAPI + pytest），包含公开测试和隐藏测试
- `benchmark-runner`: 四种模式的执行器（Mode A/B/C-sim/C-real）和 10 轮固定用户指令，C-sim 使用确定性提取（理论上限），C-real 使用 LLM 提取（真实场景）
- `benchmark-metrics`: Token 计量、浪费检测、完成度评分的分析器和报告器

### Modified Capabilities

无（这是全新功能，不修改现有 spec）

## Impact

### 新增代码
- `packages/benchmark/` - 全新包
  - `fixtures/minikanban/` - Python 测试项目
  - `src/harness/` - 计量框架
  - `src/runner/` - 执行器
  - `src/results/` - 结果分析

### 依赖关系
- 依赖 `packages/core/src/events.ts` 的 `run.usage` 事件（需确认 adapter 层已实现上报）
- 依赖 `packages/testing/src/raw-mock-adapter.ts` 用于早期模拟验证
- Mode B/C 依赖 `context=inject` 和 `memory=platform` 功能启用

### 外部依赖
- Python 3.11+ 环境（用于运行 MiniKanban 项目）
- pytest（用于完成度评分）
