# Context Platform SDK

A context management platform that sinks `session`, `task`, `memory`, `artifact`, and `checkpoint` capabilities below the agent runtime.

It is designed to sit between business code and agent runtimes such as Claude Code, OpenCode, and OpenClaw, while keeping the platform as the canonical owner of `Session`, `Task`, and `Run`.

## What Works Today

- Canonical `Session / Task / Run / Event / Artifact / Checkpoint / MemoryRecordV1_1`
- `context: native | inject | replace`
- `memory: off | platform | tool-bridge`
- `tasks: observe-native | mirror-native | platform-tools`
- `artifacts: observe | capture-store`
- Run summaries, task summaries, session summaries, and minimal graph-aware pruning
- Session preload, post-run extraction, task/session consolidation
- Tool-bridge MCP path for memory and platform task tools
- Canonical checkpoint / resume round-trip
- OpenCode adapter contract coverage and smoke path

## Repository Layout

- `packages/core`: canonical types, policy validation, event schemas, memory contracts
- `packages/client`: business-facing SDK and platform runtime
- `packages/adapter-kit`: adapter contracts, tool bridges, contract helpers
- `packages/adapter-opencode`: OpenCode adapter
- `packages/testing`: in-memory store, in-memory memory subsystem, mock adapter
- `docs`: architecture and detailed design documents

## Quick Start

Install dependencies:

```bash
npm install
```

Run typecheck:

```bash
npm run typecheck
```

Run the full test suite:

```bash
npm test -- --run packages/core/src/__tests__ packages/client/src/__tests__ packages/adapter-kit/src packages/adapter-opencode/src/__tests__
```

Run the end-to-end demo:

```bash
npm run demo
```

## Demo Flow

The demo in [context-platform-demo.test.ts](/e:/vibecoding/sdk/V1/packages/client/src/__tests__/context-platform-demo.test.ts) exercises a realistic path:

- creates a session and a task
- starts a run with `context=inject`, `memory=platform`, `tasks=mirror-native`, and `artifacts=capture-store`
- captures a native todo update, an artifact-producing tool result, and a completed run
- checkpoints and resumes a second run
- completes the task and archives the session
- asserts that summaries, artifacts, memory, and checkpoints all exist in canonical storage

## Capability Matrix

| Capability | Modes | Current baseline |
| --- | --- | --- |
| Context | `native`, `inject`, `replace` | active |
| Memory | `off`, `platform`, `tool-bridge` | active |
| Tasks | `observe-native`, `mirror-native`, `platform-tools` | active |
| Artifacts | `observe`, `capture-store` | active |
| Checkpoint | `checkpoint()`, `resume()` | active |

## Recommended Reading

- [Architecture](/e:/vibecoding/sdk/V1/docs/architecture.md)
- [Current Code Architecture](/e:/vibecoding/sdk/V1/docs/current-code-architecture.md)
- [SDK Design](/e:/vibecoding/sdk/V1/docs/context-platform-sdk-design.md)
- [Adapter Support Matrix](/e:/vibecoding/sdk/V1/docs/adapter-support-matrix.md)
- [Session Graph and Context Pruning](/e:/vibecoding/sdk/V1/docs/session-graph-and-context-pruning.md)
- [Memory Namespace and Record Model](/e:/vibecoding/sdk/V1/docs/memory-namespace-and-record-model.md)

## Current Focus

The core platform loop is in place. The next layer is productization and deeper runtime integration:

- richer CLI hook integration for native task mirroring
- stronger persisted graph/query infrastructure
- richer artifact blob capture and external storage
