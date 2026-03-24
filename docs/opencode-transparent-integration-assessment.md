# OpenCode Transparent Integration Assessment

## 1. Goal

This document evaluates whether OpenCode can be integrated as a transparent runtime under the Context Platform.

The target is not:

- spawning `opencode run` as a black-box CLI
- exposing platform features as optional tools
- relying on model-initiated MCP/tool calls to obtain core context

The target is:

- OpenCode keeps its native execution experience
- the Context Platform transparently owns session, task, memory, and context lifecycle
- OpenCode becomes an execution plane, while the platform becomes the context plane

This document complements:

- [Transparent Runtime Integration](/e:/vibecoding/sdk/V1/docs/transparent-runtime-integration.md)
- [Architecture](/e:/vibecoding/sdk/V1/docs/architecture.md)
- [Current Code Architecture](/e:/vibecoding/sdk/V1/docs/current-code-architecture.md)

## 2. Evidence Gathered

The current assessment is based on the local OpenCode installation and SDK/API surface.

Observed facts:

- OpenCode has a local SDK client and server helper.
- The SDK exposes `session.create`, `session.messages`, `session.prompt`, `session.promptAsync`, `session.todo`, `session.revert`, and `event` APIs.
- The prompt API accepts a `system` field and `parts`, which is a real before-model-call input surface.
- OpenCode stores native state in a local SQLite database at `C:\Users\zxm\.local\share\opencode\opencode.db`.
- The native database contains canonical OpenCode tables for `session`, `message`, `part`, `todo`, `project`, `workspace`, and `permission`.
- `message.data` and `part.data` are JSON blobs, not just plain text rows.
- Todo state is stored in a native `todo` table keyed by session.
- OpenCode also keeps prompt-related local state in `C:\Users\zxm\.local\state\opencode\prompt-history.jsonl`.

These facts are enough to conclude that OpenCode already has both:

- a promising API-level prompt control surface
- a strong native persistence model of its own

## 3. Evaluation Against Transparent Integration Criteria

### 3.1 Before-model-call interception

Status: `available`

Evidence:

- OpenCode SDK exposes `session.prompt(...)`
- request body supports `system`
- request body supports `parts`
- request scoping supports `directory`

Interpretation:

This is a genuine pre-model-call control point.
A platform host can assemble context first, then call OpenCode with the platform-owned `system` and user message parts.

This is the strongest positive signal in the whole assessment.

### 3.2 After-model-call / event interception

Status: `available`

Evidence:

- OpenCode SDK exposes event subscription APIs
- the CLI already emits structured JSON events
- native message parts include step start, text, reasoning, tool, and step finish records

Interpretation:

The platform can receive enough output to normalize runs, write summaries, extract memory, mirror task changes, and build graph indexes.

This surface looks good enough for a transparent runtime host.

### 3.3 State persistence replacement

Status: `not naturally replaceable`

Evidence:

OpenCode persists these native entities itself:

- `session`
- `message`
- `part`
- `todo`
- `project`
- `workspace`
- `permission`

Interpretation:

OpenCode is not a stateless inference engine.
It already acts like a full agent application with its own state model.

That means transparent integration is not just a prompt problem.
If the platform wants true ownership, it must decide what to do about these native state stores.

### 3.4 Native task ownership

Status: `conflicting`

Evidence:

- OpenCode stores todo state in its own `todo` table
- task state appears to be session-scoped and native to the runtime

Interpretation:

If the platform wants canonical task ownership, there are only two honest options:

1. OpenCode native todo remains a mirrored secondary state
2. OpenCode native todo layer is patched or replaced

There is no evidence that OpenCode currently offers a first-class external task-store plugin point.

## 4. Decision: Server-Host vs Fork/Patch

### 4.1 Server-host approach

Definition:

- Start OpenCode server or SDK client under a platform-controlled host
- The platform assembles context before every prompt call
- The platform consumes events after every run/message
- The platform keeps canonical Session/Task/Run/Memory on its own side
- OpenCode native session/message/todo remain present, but become runtime-local secondary state

Advantages:

- No immediate fork required
- Real before-model-call control exists already
- Faster path to a meaningful transparent context-plane prototype
- Easier to validate with current repository assets

Disadvantages:

- OpenCode still owns its own native state internally
- Session/message/todo duplication is unavoidable at first
- Canonical ownership is platform-side, but not source-replaced inside OpenCode
- Some state drift risks remain unless sync policy is very explicit

Assessment:

This is the best first implementation path.

### 4.2 Fork/Patch approach

Definition:

- Modify OpenCode itself so native prompt assembly, task state, and perhaps session persistence call into the platform instead of local state

Advantages:

- Closest to true transparent takeover
- Eliminates duplicated state in the long term
- Lets OpenCode genuinely use the platform rather than merely being hosted by it

Disadvantages:

- High maintenance burden
- Requires intimate knowledge of OpenCode internals
- Ties delivery speed to upstream code archaeology and divergence control

Assessment:

This is probably the long-term end-state if product requirements demand strict ownership consistency.
It is not the best first milestone.

## 5. Recommended Path

### Recommendation

Choose `server-host` first.
Do not start with a fork.

Reason:

- OpenCode already exposes the exact before-model-call control surface needed for platform-owned context assembly.
- The platform can already own canonical Session/Task/Run/Memory outside OpenCode.
- This lets us prove the product value of transparent context ownership before taking on source-fork maintenance.

### What server-host means concretely

The platform should stop thinking of OpenCode as a CLI adapter first.
Instead, it should treat OpenCode as a hostable agent engine.

Target shape:

```text
User/App
  -> Platform-hosted OpenCode runtime session
     -> platform resolves task/session/run state
     -> platform builds context snapshot
     -> platform calls OpenCode session.prompt(system, parts)
     -> OpenCode executes model/tool loop
     -> platform receives events and writes canonical side effects
```

## 6. What Must Be True In Phase 1

Phase 1 does not need to replace OpenCode's native SQLite state.
It only needs to satisfy these requirements:

- the platform is the canonical owner of Session/Task/Run for business semantics
- the platform decides the final context before every prompt call
- the platform owns memory retrieval, pruning, summaries, and consolidation
- the platform receives full enough native output to keep its canonical state updated
- OpenCode native session/todo/history are treated as runtime-local mirrors, not canonical truth

This is good enough to call the result a transparent context-plane integration, even if it is not yet a full native-state replacement.

## 7. What Must Wait For Phase 2

These items likely require a deeper patch or a very careful sync layer:

- replacing OpenCode native todo as the real source of truth
- replacing OpenCode native session/message persistence completely
- replacing revert/snapshot semantics with platform-native checkpoint semantics
- full elimination of duplicated runtime-local state

## 8. Concrete Next Steps

### 8.1 Build a new adapter class for OpenCode host mode

Not a CLI black-box adapter.
Instead:

- start or attach to OpenCode server
- create a platform-owned run session mapping
- call `session.prompt()` with platform-owned `system` content and user parts
- subscribe to events
- normalize and persist events in the platform

### 8.2 Keep canonical task ownership platform-side

Initially:

- platform Task remains canonical
- OpenCode todo remains native mirror only
- sync policy should be explicit and one-way where possible

### 8.3 Separate product truth from runtime-local truth

Define clearly:

- platform truth: Session / Task / Run / Memory / Summary / Checkpoint
- OpenCode local truth: local runtime conversation state needed to keep OpenCode functioning

### 8.4 Delay MCP and plugin thinking

MCP is not needed for this main path.
Any explicit tools can be added later only if they improve agent ergonomics.
They are not the basis of integration.

## 9. Final Recommendation

For OpenCode, the correct transparent-integration strategy is:

1. Phase 1: `server-host transparent adapter`
2. Phase 2: evaluate selective `fork/patch` only where duplicated native state becomes a real product problem

Short version:

- not MCP
- not black-box CLI prompt injection
- not immediate fork
- yes to a platform-hosted OpenCode server/API integration
