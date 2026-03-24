## Context

### 背景

我们需要一个能直接回答下面问题的 benchmark：

`在完成度基本不变的前提下，Context Platform 能否显著降低 agent 的 token 消耗？`

因此设计重点应是控制变量，而不是一次性展示平台的全部能力。

### 当前约束

- `run.usage` 事件已定义，但真实 token 上报仍需补齐
- `context=inject` 和 `memory=platform` 目前尚未完全开放
- benchmark 需要先支持早期模拟验证，再支持真实运行

## Goals / Non-Goals

### Goals

1. 设计一个会自然产生上下文膨胀的 8-12 轮任务
2. 让主 benchmark 只回答 context 和 memory 带来的 token 变化
3. 建立可复核的 token 计量和 completion 校验
4. 让结果可重复，避免单次 run 偶然性

### Non-Goals

1. 不在主 benchmark 中展示 task graph 并行收益
2. 不把 C-sim 作为主结论来源
3. 不在本 change 中实现 embedding 检索等后续能力

## Decisions

### D1: 单一主任务，保留轻量实现

选择 MiniKanban FastAPI Service 作为唯一主 fixture。

理由：
- 足够长，能产生上下文膨胀
- 有真实多轮开发和修复过程
- pytest 可提供客观完成度
- 目前先做一个高质量任务，比同时做多套 fixture 更轻

### D2: 主 benchmark 只保留三种必跑模式

- Mode A: Baseline = `context=native`, `memory=off`
- Mode B: Platform+Context = `context=inject`, `memory=off`
- Mode C-real: Platform+Context+Memory = `context=inject`, `memory=platform`

说明：
- A vs B 是主对照，回答 context pruning 是否省 token
- B vs C-real 是次对照，回答 memory 在真实成本下是否继续省 token
- C-sim 只保留为可选辅助模式，不进入主对外结论

### D3: 主 benchmark 统一串行执行

所有模式都按同一组 10 轮指令串行执行。

说明：
- 不在主 benchmark 中让平台组并行、baseline 串行
- 否则结论会混入 task graph 调度收益
- 如果后续要展示 task graph 价值，应单独做附加 benchmark

### D4: 完成度校验采用双门槛

只有同时满足以下条件才允许比较 token：

1. hidden tests 通过数差异不超过 1
2. completion score 总分差异不超过 5

理由：
- 保留整体质量约束
- 同时把“精度不受影响”更直接地绑定到隐藏测试

### D5: 结果默认按重复运行汇总

每个模式默认至少跑 5 次，报告：
- median total input tokens
- median total output tokens
- median R6-R10 average input tokens
- median completion score
- p25 / p75 作为波动范围

理由：
- 单次 run 容易受模型随机性影响
- 5 次已经是较轻量但足够明显的下限

### D6: Token 计量优先使用 LLM API proxy interceptor

优先使用 proxy 拦截真实 API 响应中的 usage 字段。

理由：
- 比 adapter 日志更通用
- 计量边界更清晰

### D7: Wasted calls 作为辅助指标

`wasted call` 保留，但只作为辅助分析，不作为主结论。

原因：
- “有 memory 仍再次读取”不总等于浪费
- 该指标适合帮助解释行为，不适合作为核心 ROI 证据

## Risks / Trade-offs

### R1: 只有一个 fixture，外推性有限

缓解：
- 明确这是 V1 benchmark
- 对外表述为“代表性长程编码任务”，而非“通用结论已完全证明”

### R2: Mode B/C 功能尚未完全开放

缓解：
- 先用 RawMockAdapter 验证 harness 和 analyzer
- 待能力开放后再跑真实结果

### R3: 重复运行增加成本

缓解：
- 默认 5 次，不做过重统计设计
- 本地调试可先跑 1 次 smoke

## Open Questions

1. V1 是否需要再补一个不同形态的 fixture，还是先用单 fixture 跑通完整链路
