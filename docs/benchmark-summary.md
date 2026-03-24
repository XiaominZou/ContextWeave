# Benchmark Summary

## Goal

这个 benchmark 只回答一个核心问题：

`在完成度基本不变的前提下，Context Platform 接管 context / memory 后，能否显著降低 agent 的 token 消耗？`

## What We Measure

主指标：
- total input tokens
- total output tokens
- R6-R10 average input tokens
- completion score

辅助指标：
- total LLM calls
- memoryExtractionTokens
- wasted tool call ratio

## Benchmark Task

使用一个固定的长程编码任务作为 fixture：
- MiniKanban FastAPI service
- Python 3.11 + FastAPI + pytest
- 覆盖 CRUD、业务约束、需求变更、README 和收尾修复

任务被拆成固定 10 轮用户指令，保证所有模式面对完全相同的外部输入。

## Execution Modes

主 benchmark 只跑三种模式：

1. Mode A: Baseline
   `context=native`, `memory=off`

2. Mode B: Platform+Context
   `context=inject`, `memory=off`

3. Mode C-real: Platform+Context+Memory
   `context=inject`, `memory=platform`
   memory extraction token 成本计入总成本

说明：
- `A vs B` 用来衡量 context pruning 的净收益
- `B vs C-real` 用来衡量 memory 在真实成本下的额外收益
- `C-sim` 仅作内部辅助，不作为主结论

## Control Rules

为了让结果更可信，主 benchmark 控制以下变量：
- 同一个 fixture
- 同一组 10 轮指令
- 同样的串行执行流程
- 同样的模型、工具和运行预算

主 benchmark 不引入并行 task graph，以避免把调度收益混入 context 管理收益。

## Fairness Gate

只有同时满足以下条件，才允许比较 token：

1. hidden tests 通过数差异不超过 1
2. completion score 差异不超过 5

这意味着结论默认建立在“质量基本等价”的前提上，而不是用更差结果换更低 token。

## Reproducibility

每个主模式默认至少运行 5 次，报告：
- median
- p25
- p75

这样可以降低单次 run 波动带来的偶然性。

## Token Metering

优先方案：
- 使用 LLM API proxy interceptor 记录真实 usage

备选方案：
- adapter 侧解析 usage 并 emit `run.usage`

在 token 计量未打通前，不产出正式 benchmark 结论。

## Expected Output

主报告只强调两组对比：

1. `Mode A vs Mode B`
   Context Platform 在不降低完成度的情况下，减少了多少 input token

2. `Mode B vs Mode C-real`
   Memory 在计入提取成本后，是否继续带来净收益

这版 benchmark 是一个轻量 V1：
- 先把因果链讲清楚
- 先证明 context / memory 的直接收益
- 后续再扩展更多 fixture 或单独评估 task graph 收益
