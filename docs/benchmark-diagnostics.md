# Benchmark Diagnostics

## Scope

This note records the main debugging steps and conclusions from the real OpenCode benchmark investigations in March 2026.

It focuses on the `r3` diagnostic path:

- real benchmark runner
- `baseline` vs `platform-context`
- first 3 rounds only
- single iteration runs used for fast diagnosis

## Main Findings

### 1. Context size was not the main driver

The first diagnostic run showed:

- `baseline` total input tokens: `11,440`
- `platform-context` total input tokens: `19,448`
- `baseline` total LLM calls: `10`
- `platform-context` total LLM calls: `25`

But the new snapshot diagnostics showed only a small prompt difference:

- snapshot token total across rounds: `247` vs `274` (`+27`)
- prompt text total across rounds: `981 chars` vs `1,091 chars` (`+110`)

This ruled out "prompt got much larger" as the main explanation.

### 2. Round 2 behavior was the real failure point

In the same diagnostic run:

- `baseline` round 2: `133` input tokens, `3` calls
- `platform-context` round 2: `8,549` input tokens, `19` calls

The injected snapshot for round 2 was nearly identical in size, so the most likely cause was:

- the `run-summary` content changed OpenCode's execution strategy
- the model took many more steps after seeing that summary

### 3. Early-round run-summary suppression fixed the regression

We introduced a formal policy hint:

- `CapabilityPolicy.contextHints.suppressRunSummaries`

The real benchmark runner now enables it for non-baseline modes in rounds `1-2`.

After that change, the `r3` diagnostic run produced:

- `baseline` total input tokens: `25,594`
- `platform-context` total input tokens: `11,264`

Per-round behavior became:

- `platform-context` round 1: `10,638` input tokens, `3` calls
- `platform-context` round 2: `359` input tokens, `4` calls
- `platform-context` round 3: `267` input tokens, `3` calls

The round diagnostics confirmed the intended snapshot change:

- `platform-context` round 2 snapshot: task block only
- `platform-context` round 3 snapshot: task + run summaries restored

This supports the conclusion that:

- early `run-summary` injection was the main behavioral trigger
- suppressing those summaries in early rounds is an effective mitigation

## Supporting Changes

The following changes were validated during this investigation:

- summary-only blocks now render as compact prompt entries instead of full content
- recursive summary nesting was removed from task/session summaries
- context snapshots now enforce a total token budget
- real benchmark output now includes per-round diagnostics:
  - `snapshotTokenEstimate`
  - `includedBlockCount`
  - `excludedBlockCount`
  - `promptTextLength`
  - `sourceTypeCounts`
  - `retentionCounts`

## Remaining Open Question

One baseline anomaly still needs follow-up:

- a baseline round showed `inputTokens: 1` on a call that should normally cost much more

This suggests a possible runtime-side caching effect, such as prompt caching or session reuse behavior that baseline benefits from more than injected modes.

This has not been proven yet and should be treated as a separate investigation.

## Recommended Next Steps

1. Repeat the `r3` diagnostic run with multiple iterations now that the early-round suppression policy is in place.
2. Investigate whether OpenCode prompt/session caching affects baseline and injected modes differently.
3. Keep using the new round diagnostics to distinguish:
   - prompt-size regressions
   - behavior-path regressions
