# @ctx/adapter-opencode

OpenCode runtime adapter.

## Responsibilities

- renders OpenCode-specific invocation payloads
- normalizes OpenCode raw events into canonical platform events
- wires MCP bridge configuration for memory and platform task tools
- overlays a temporary OpenCode plugin config when platform-owned context must be injected transparently

## Typical Use

Register it with `@ctx/client` at platform bootstrap:

```ts
import { createContextPlatform } from "@ctx/client";
import { OpenCodeAdapter } from "@ctx/adapter-opencode";

const platform = createContextPlatform({ store, memory });
platform.runtime.adapters.register(new OpenCodeAdapter(options));
```

When you run with `context: "inject"` or `context: "replace"`, `OpenCodeAdapter` now creates a per-run temporary OpenCode config overlay and loads a platform plugin that injects the platform snapshot through OpenCode's `experimental.chat.system.transform` hook. This keeps platform context out of the visible user prompt path.

## Notes

This package is runtime-specific. Business code should still interact only with `@ctx/client`.

## Adapter Variants

- `OpenCodeAdapter`: CLI adapter using `opencode run --format json`, now with transparent plugin-overlay context injection for non-native context modes
- `OpenCodeHostAdapter`: transparent-host prototype that starts `opencode serve` and calls the server API with platform-owned context
