# @ctx/testing

In-memory testing helpers for the context platform.

## Responsibilities

- in-memory `PlatformStore`
- in-memory memory provider / engine subsystem
- `RawMockAdapter` for deterministic run-stream tests
- `createTestPlatform()` convenience bootstrap

## Typical Use

```ts
import { createInMemoryMemorySubsystem, createTestPlatform, RawMockAdapter } from "@ctx/testing";

const memory = createInMemoryMemorySubsystem();
const { client } = createTestPlatform({
  adapters: [new RawMockAdapter({ rawEvents: [] })],
  memory,
});
```

Use this package for integration-style unit tests and demos. It is not intended as a production store or adapter.
