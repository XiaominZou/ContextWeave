# @ctx/adapter-kit

Adapter contracts and shared bridge helpers.

## Responsibilities

- defines `AgentAdapter` and adapter payload / capability types
- provides memory and task tool-bridge helpers
- exposes adapter contract-test helpers under `@ctx/adapter-kit/testing`

## Use This Package When

- building a new runtime adapter
- wiring MCP / tool-bridge surfaces
- validating adapter behavior against the shared contract suite

## Main Exports

- `AgentAdapter`
- `AdapterCapabilities`
- `AdapterPayload`
- `buildPlatformMemoryToolSchemas()`
- `buildPlatformTaskToolSchemas()`
- `buildPlatformMemoryMcpServers()`
- `buildPlatformTaskMcpServers()`
