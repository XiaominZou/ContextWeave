# @ctx/client

Business-facing SDK and platform runtime.

## Responsibilities

- creates the context platform runtime through `createContextPlatform()`
- exposes `sessions`, `tasks`, `runs`, `events`, and `experimental` APIs
- owns canonical run lifecycle, capability routing, context assembly, and persistence coordination

## Quick Example

```ts
import { createContextPlatform } from "@ctx/client";

const platform = createContextPlatform({ store, memory });
platform.runtime.adapters.register(adapter);

const client = platform.client();
const session = await client.sessions.create({ workspaceId: "ws_1", title: "demo" });
const task = await client.tasks.create({ workspaceId: "ws_1", sessionId: session.id, title: "Ship feature" });
const handle = await client.runs.start({
  workspaceId: "ws_1",
  sessionId: session.id,
  taskId: task.id,
  adapter: "mock",
});
```

## Public Derived Metadata

This package also exports stable readers and metadata keys for derived runtime data:

- `RUN_SUMMARY_METADATA_KEY`
- `TASK_SUMMARY_METADATA_KEY`
- `SESSION_SUMMARY_METADATA_KEY`
- `TASK_NATIVE_MIRROR_METADATA_KEY`
- `readRunSummary()`
- `readTaskSummary()`
- `readSessionSummary()`
- `readNativeTaskMirror()`

Prefer these exports over reading from `src/internal/*` paths.
