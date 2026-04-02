# PinchBench OpenClaw A/B

This repository now includes a dedicated runner for comparing OpenClaw:

- without the Context Platform
- with the Context Platform OpenClaw plugin enabled

The goal is to measure the three things we care about on the same PinchBench task suite:

- task score
- token usage
- speed

## Why a Dedicated Runner Exists

PinchBench is designed around the default OpenClaw home directory layout.
Our local OpenClaw integration usually uses repo-local state and a platform daemon.
If we run PinchBench against our current setup naively, two problems appear:

1. PinchBench looks for transcripts under `~/.openclaw/agents`
2. our existing project-scoped plugin install flow writes a fixed `workspaceDir`, which is a poor fit for PinchBench because each task run swaps the working directory

The runner avoids both issues by:

- creating isolated per-scenario OpenClaw project state directories
- pointing `OPENCLAW_STATE_DIR` at a repo-local style `.openclaw-project`
- enabling the platform plugin only for the `with-platform` scenario
- leaving `workspaceDir` out of plugin config so the plugin uses the task run's current working directory
- using a local patched PinchBench runner that respects `OPENCLAW_STATE_DIR` and implements `sessions[].new_session`

## Local Runner

For debugging the patched runner directly:

```powershell
npm run benchmark:openclaw:pinchbench:local -- --pinchbench-dir C:\path\to\pinchbench\skill --model openrouter/anthropic/claude-sonnet-4 --output-dir E:\tmp\pinchbench-local
```

This runner keeps PinchBench's task loading and grading model, but fixes two local integration issues:

- OpenClaw transcript and agent lookup now follows `OPENCLAW_STATE_DIR`
- task frontmatter `sessions[].new_session: true` now starts a fresh OpenClaw session instead of reusing the previous one

## Command

Run both scenarios:

```powershell
npm run benchmark:openclaw:pinchbench -- --pinchbench-dir C:\path\to\pinchbench\skill --model openrouter/anthropic/claude-sonnet-4
```

Run a narrow smoke check:

```powershell
npm run benchmark:openclaw:pinchbench -- --pinchbench-dir C:\path\to\pinchbench\skill --model openrouter/anthropic/claude-sonnet-4 --smoke
```

Run only one scenario:

```powershell
npm run benchmark:openclaw:pinchbench -- --pinchbench-dir C:\path\to\pinchbench\skill --model openrouter/anthropic/claude-sonnet-4 --scenario with-platform
```

Useful options:

- `--suite all`
- `--suite automated-only`
- `--suite task_08_memory,task_22_second_brain`
- `--runs 3`
- `--judge openrouter/anthropic/claude-opus-4.5`
- `--timeout-multiplier 1.5`
- `--context-mode inject`
- `--context-mode replace`
- `--keep-runtime-state`

## Output

Each run writes to:

```text
results/openclaw-pinchbench-ab-<timestamp>/
```

Artifacts include:

- `comparison.json`: machine-readable summary
- `comparison.md`: overall A/B table plus per-task breakdown when both scenarios ran
- `with-platform/results/*.json`: raw PinchBench result
- `without-platform/results/*.json`: raw PinchBench result
- `with-platform/platform-daemon.out.log`: platform daemon logs

The summary focuses on:

- `overallScorePercent`
- `totalMeanScore`
- `totalInputTokens`
- `totalOutputTokens`
- `totalTokens`
- `totalRequests`
- `totalExecutionTimeSeconds`
- `averageTaskRunTimeSeconds`
- `scorePer1kTokens`

## Recommended Evaluation Shape

For platform signal, start with:

- `task_08_memory`
- `task_22_second_brain`

Then expand to:

- `automated-only`
- `all`

For more stable comparisons, use at least `--runs 3`.
