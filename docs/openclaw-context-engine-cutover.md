# OpenClaw Context-Engine Cutover

## Goal

Make the OpenClaw integration transparent by default.

After this cutover:

- OpenClaw uses the platform through the native `context-engine` plugin surface
- the platform owns pre-turn context assembly and post-turn canonicalization
- the old SDK adapter path is removed from this repository

## Why We Removed The SDK Path

The SDK adapter validated an early run lifecycle, but it left the platform outside OpenClaw's native context plane. That shape made it too easy to treat platform context as just another prompt block instead of the runtime's default context control plane.

The `context-engine` plugin path is a better fit because it lets the platform:

- bind workspace and native session identity before prompt assembly
- assemble context immediately before model execution
- ingest messages during runtime turn flow
- run post-turn side effects after native execution

## Supported OpenClaw Shape

The supported path is now:

```text
OpenClaw runtime
  -> OpenClaw context-engine plugin
     -> platform daemon
        -> @ctx/client runtime
           -> canonical Session / Task / Run / Memory
```

Key files:

- [openclaw-context-engine.ts](/e:/vibecoding/sdk/V1/packages/adapter-openclaw/src/openclaw-context-engine.ts)
- [index.mjs](/e:/vibecoding/sdk/V1/plugins/openclaw/index.mjs)
- [openclaw-platform-daemon.mjs](/e:/vibecoding/sdk/V1/scripts/openclaw-platform-daemon.mjs)
- [install-openclaw-plugin.mjs](/e:/vibecoding/sdk/V1/scripts/install-openclaw-plugin.mjs)

## Lifecycle Contract

The plugin and daemon are expected to use this lifecycle:

1. `bootstrap`
2. `ingest`
3. `assemble`
4. `compact`
5. `afterTurn`

Ownership split:

- OpenClaw keeps native model execution and tool loop behavior
- the platform owns canonical state, memory retrieval, context rendering, and post-turn persistence

## Migration Notes

This cutover removes:

- `OpenClawAdapter`
- OpenClaw SDK adapter contract tests
- documentation that treated OpenClaw as the main SDK-style adapter

This cutover keeps:

- the `@ctx/adapter-openclaw` package name
- the context-engine bridge helpers
- the plugin installer and daemon scripts

## Validation

The minimum ongoing validation is:

- unit tests for the context-engine bridge helpers
- manual plugin + daemon E2E against a real OpenClaw installation

Contract tests for an SDK adapter are no longer part of the OpenClaw path.
