# @ctx/adapter-openclaw

OpenClaw adapter package for the Context Platform SDK.

This package provides two integration surfaces:

- `OpenClawAdapter`: the platform-side `AgentAdapter` implementation for SDK-style execution.
- `createOpenClawContextEngineBridge`: a bridge that adapts platform-managed context assembly to OpenClaw's `ContextEngine` plugin slot.

The intended transparent integration path is:

1. Register a plugin in OpenClaw with `api.registerContextEngine(...)`
2. Point that engine at your platform context service
3. Keep canonical `Session / Task / Run / Memory` ownership in the platform
4. Let OpenClaw stay the execution and tool loop runtime
