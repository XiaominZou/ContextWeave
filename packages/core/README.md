# @ctx/core

Canonical contracts for the context platform.

## Responsibilities

- canonical domain types such as `Session`, `Task`, `Run`, `Artifact`, and `Checkpoint`
- capability-policy types and validation
- canonical event-envelope schema
- memory provider / engine contracts and validation helpers

## Typical Use

Most application code should consume `@ctx/client`, not `@ctx/core` directly.
Use this package when you are:

- implementing adapters
- implementing stores or memory engines
- writing low-level tests against canonical contracts

## Main Exports

- `defaultCapabilityPolicy`
- `resolveCapabilityPolicy()`
- `validateCapabilityPolicy()`
- canonical types such as `Run`, `Task`, `Session`, `AgentEventEnvelope`
- memory contracts such as `MemoryProvider`, `MemoryEngine`, `MemoryRecordV1_1`
