# Benchmark Plan: Context Platform Token Savings

## 1. Goal

主问题只有一个：

`在完成度基本不变的情况下，平台接管 context / memory 后，agent 总 token 是否明显下降？`

这个 benchmark 刻意保持轻量，不一次性评估平台所有能力。

## 2. Design Principles

1. 同一任务
   所有模式都使用同一个 MiniKanban fixture。

2. 同一指令
   所有模式都执行同一组 10 轮用户指令。

3. 同一执行形态
   所有模式都串行执行，不在主 benchmark 中引入并行子任务。

4. 同等完成度后再比较 token
   只有质量接近时，token 对比才有效。

5. 少量重复运行
   每个模式默认运行 5 次，报告中位数和简单分布。

## 3. Fixture

技术栈：
- Python 3.11
- FastAPI
- Pydantic
- pytest

任务分四阶段：
- Phase 1: 基础 CRUD
- Phase 2: 业务约束
- Phase 3: 新增筛选和统计能力
- Phase 4: README、错误码和收尾修复

这个任务的目标不是难，而是足够长，能稳定产生上下文膨胀和重复探索机会。

## 4. Modes

### Required

- Mode A: Baseline
  - `context=native`
  - `memory=off`

- Mode B: Platform+Context
  - `context=inject`
  - `memory=off`

- Mode C-real: Platform+Context+Memory
  - `context=inject`
  - `memory=platform`
  - memory extraction 成本计入总 token

### Optional

- Mode C-sim
  - 仅作内部调试或理论上界参考
  - 不作为主报告结论

## 5. Fixed 10 Rounds

1. 阅读 `SPEC.md` 和代码，输出缺口分析与计划，不写代码
2. 实现基础 CRUD，只改必要文件
3. 跑测试，修前 5 个失败项
4. 加入业务约束：done 不可改标题、最多 5 个标签、标签不可重复
5. 实现级联删除并补测试
6. 支持按标签过滤任务列表
7. 新增看板统计接口
8. 统一错误码并补 README
9. 重跑测试并修剩余问题，不做重构
10. 输出最终交付总结

## 6. Metrics

主指标：
- total input tokens
- total output tokens
- R6-R10 average input tokens
- completion score

辅助指标：
- total LLM calls
- wasted tool call ratio
- memoryExtractionTokens

报告时默认展示每个模式 5 次运行的：
- median
- p25
- p75

## 7. Fairness Gate

只有同时满足以下条件，才允许比较 token：

1. hidden tests 通过数差异不超过 1
2. completion score 差异不超过 5

completion score 仍然保留以下维度：
- public tests
- hidden tests
- code quality
- README / delivery quality
- process constraints
- runnable code

## 8. Wasted Calls

`wasted call` 只作为辅助解释指标，不作为主结论。

一个更保守的定义是：
- 同一类工具
- 相同输入签名
- 已存在相关 memory
- 且该次调用没有带来新信息

如果只是验证当前状态，不应自动算作浪费。

## 9. Token Metering

P0 方案：
- 使用 LLM API proxy interceptor 记录真实 usage

备选方案：
- 在 adapter 侧解析 usage 并 emit `run.usage`

主 benchmark 在 token 计量未打通前，不产出正式对比结论。

## 10. Output

主报告只强调两组对比：

1. A vs B
   说明 context pruning 的净收益

2. B vs C-real
   说明 memory 在真实提取成本下的增益

C-sim 如果出现，只放在附录或内部调试结果里。
