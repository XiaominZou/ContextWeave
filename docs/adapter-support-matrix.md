# Adapter Support Matrix

This document tracks how the current platform capability model maps onto each runtime adapter. It documents the current bootstrap adapter state, not the final transparent-takeover target architecture.

It should be read together with:

- [Architecture](/e:/vibecoding/sdk/V1/docs/architecture.md)
- [Current Code Architecture](/e:/vibecoding/sdk/V1/docs/current-code-architecture.md)
- [SDK Design](/e:/vibecoding/sdk/V1/docs/context-platform-sdk-design.md)
- [Transparent Runtime Integration](/e:/vibecoding/sdk/V1/docs/transparent-runtime-integration.md)

## OpenCode

Current adapter sources:

- [opencode-adapter.ts](/e:/vibecoding/sdk/V1/packages/adapter-opencode/src/opencode-adapter.ts)
- [opencode-transparent-plugin.ts](/e:/vibecoding/sdk/V1/packages/adapter-opencode/src/opencode-transparent-plugin.ts)
- [opencode-host-adapter.ts](/e:/vibecoding/sdk/V1/packages/adapter-opencode/src/opencode-host-adapter.ts)

### Capability Matrix

| Capability | Platform mode | OpenCode status | Notes |
| --- | --- | --- | --- |
| Context | `native` | supported | Platform does not inject context. |
| Context | `inject` | prototype supported | `OpenCodeAdapter` now uses a per-run config overlay plus plugin hook to inject platform context through `experimental.chat.system.transform`. Fake integration passes; real CLI validation is currently blocked by a Bun/OpenCode plugin crash on this machine. |
| Context | `replace` | prototype supported | Uses the same plugin-overlay path, but replaces the system list with the platform block. This is implemented at adapter level, but still needs stable real-CLI validation. |
| Memory | `off` | supported | Observe-only baseline. |
| Memory | `tool-bridge` | supplemental only | Tool bridges are not the target architecture for transparent takeover. |
| Memory | `platform` | partial via context plane | Platform retrieval can feed the injected snapshot, but OpenCode is not yet platform-owned end-to-end for native memory/state. |
| Tasks | `observe-native` | supported | Native task behavior is only observed. |
| Tasks | `mirror-native` | supported | Platform runtime mirrors native todo-style tool results into canonical task metadata. |
| Tasks | `platform-tools` | supplemental only | Platform task tools exist in the platform, but they do not constitute transparent OpenCode takeover. |
| Artifacts | `observe` | supported | Artifact-like results can still be observed through normalized events. |
| Artifacts | `capture-store` | not supported | Adapter declares `artifacts: observe-only`, so active capture-store behavior is not available on this adapter. |
| Checkpoint | `checkpoint()` | not supported | No adapter-side checkpoint hook yet. |
| Resume | `runs.resume()` | not supported | No adapter-side resume hook yet. |

### Practical Validation Focus

OpenCode is currently the best place to validate:

- canonical run lifecycle through a real CLI process
- raw-event normalization
- transparent plugin-overlay context injection against fake CLI fixtures
- the host-adapter prototype path against fake server fixtures

OpenCode is not currently the right adapter to claim full success on:

- transparent session/task/memory ownership end-to-end
- stable real-CLI plugin execution on this Windows machine
- `artifacts=capture-store`
- `checkpoint / resume`

### Current Validation Entry Points

- Contract and process integration tests:
  - [contract.test.ts](/e:/vibecoding/sdk/V1/packages/adapter-opencode/src/__tests__/contract.test.ts)
  - [process.integration.test.ts](/e:/vibecoding/sdk/V1/packages/adapter-opencode/src/__tests__/process.integration.test.ts)
  - [host.integration.test.ts](/e:/vibecoding/sdk/V1/packages/adapter-opencode/src/__tests__/host.integration.test.ts)
- Real smoke path:
  - [real-smoke.test.ts](/e:/vibecoding/sdk/V1/packages/adapter-opencode/src/__tests__/real-smoke.test.ts)

Run the baseline real smoke test with:

```powershell
$env:CTX_ENABLE_REAL_OPENCODE_SMOKE='1'
cmd /c npx vitest run packages\adapter-opencode\src\__tests__\real-smoke.test.ts
```

Run the transparent plugin capability smoke with:

```powershell
$env:CTX_ENABLE_REAL_OPENCODE_CAPABILITY_SMOKE='1'
$env:CTX_DEBUG_OPENCODE='1'
cmd /c npx vitest run packages\adapter-opencode\src\__tests__\real-smoke.test.ts -t "injects platform context into a real opencode run"
```

## Other Adapters

The platform capability model is already defined in a runtime-agnostic way, but only OpenCode currently has a production-shaped adapter package in this repository.

Future matrix rows should be added for:

- `adapter-claude-code`
- `adapter-openclaw`
