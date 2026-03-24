# Current Code Architecture

## 1. Overall Architecture

```text
+------------------+
|   Business App   |
+------------------+
          |
          v
+------------------+
|   @ctx/client    |
|------------------|
| - SessionAPI     |
| - TaskAPI        |
| - RunAPI         |
| - EventAPI       |
+------------------+
          |
          v
+------------------------------+
|       Platform Runtime       |
|------------------------------|
| - Policy Resolution          |
| - Adapter Registry           |
| - Platform Store             |
| - Async Event Buffer         |
| - Run Stream Processor       |
+------------------------------+
      |             |             \
      |             |              \
      v             v               v
+-----------+  +-----------+  +------------------+
| Adapters  |  |   Store   |  | Event Pipeline   |
|-----------|  |-----------|  |------------------|
| OpenCode  |  | Sessions  |  | normalizeEvent   |
| Adapter   |  | Tasks     |  | validateEnvelope |
+-----------+  | Runs      |  | appendEvent      |
      |         | Events    |  | updateRunState   |
      v         +-----------+  +------------------+
+------------------+                    |
|   OpenCode CLI   |                    v
+------------------+          +-------------------+
          |                   | RunHandle.stream  |
          +------------------>+-------------------+
```

## 2. Capability Boundary

```text
+-------------------+--------------------------------------------------------------+
| Capability        | Current status                                               |
+-------------------+--------------------------------------------------------------+
| context           | native / inject / replace work                               |
+-------------------+--------------------------------------------------------------+
| memory            | off / platform / tool-bridge work                            |
|                   | platform => session preload + pre-run retrieval + extraction |
|                   | tool-bridge => pure on-demand bridge, no auto retrieval      |
+-------------------+--------------------------------------------------------------+
| tasks             | observe-native / mirror-native / platform-tools work          |
|                   | mirror-native => native todo state mirrored into canonical Task |
+-------------------+--------------------------------------------------------------+
| artifacts         | observe / capture-store work                                 |
|                   | capture-store => records artifacts from tool results         |
+-------------------+--------------------------------------------------------------+
```

## 3. What Is Already Encapsulated

```text
+---------------------------+--------------------------------------------------+
| Area                      | Current encapsulation                            |
+---------------------------+--------------------------------------------------+
| Canonical model           | Session / Task / Run / Event / MemoryRecordV1_1  |
+---------------------------+--------------------------------------------------+
| Runtime                   | RunAPI.start / RunHandle                         |
|                           | interrupt / auto terminal state                  |
|                           | event persistence / capability resolution        |
+---------------------------+--------------------------------------------------+
| Context + memory          | buildContextSnapshot()                           |
|                           | session-level preload cache                      |
|                           | memory=platform retrieval + extraction           |
|                           | task completion consolidation                    |
|                           | session archive consolidation                    |
|                           | automatic settled-session consolidation          |
|                           | rule-based RunSummary + TaskSummary              |
|                           | rule-based SessionSummary                        |
|                           | ToolCallRef indexing                             |
|                           | minimal run/task/session graph indexes           |
|                           | graph-aware candidate pruning                    |
|                           | collector-based context sources                  |
|                           | artifact capture-store + artifact context blocks |
+---------------------------+--------------------------------------------------+
| Adapter boundary          | renderContext / createRun                        |
|                           | normalizeEvent / capability decl                 |
|                           | `OpenCodeAdapter` remains the black-box CLI path |
|                           | `OpenCodeHostAdapter` is the new transparent-host prototype |
|                           | tool-bridge exists but is not the target transparent path |
+---------------------------+--------------------------------------------------+
| Not implemented yet       | no real OpenCode host adapter smoke against the live server yet |
+---------------------------+--------------------------------------------------+
```

## 4. OpenCode Integration Sequence

```text
Business App
  |
  | runs.start()
  v
+------------------+
| Client Runtime   |
+------------------+
  | validate session/task
  | save queued run
  | resolve policy
  | preload session profile memory if available
  | build snapshot
  | get adapter
  v
+------------------+
| OpenCode Adapter |
+------------------+
  | renderContext()
  | createRun()
  v
+------------------+
| OpenCode CLI     |
+------------------+
  | stdout JSON lines
  v
+------------------+
| Stream Processor |
+------------------+
  | normalizeEvent()
  | assertValidEnvelope()
  | appendEvent()
  | update run state
  v
+------------------+
| RunHandle.stream |
+------------------+
  |
  v
Business App
```

## 5. OpenCode Event Mapping

```text
+------------------------------+----------------------+
| OpenCode raw event           | Platform event       |
+------------------------------+----------------------+
| step_start / step-start      | run.started          |
| text                         | message.delta        |
| tool_use / tool_call         | tool.call            |
| tool_result                  | tool.result          |
| step_finish / message_stop   | run.completed        |
| error                        | run.failed           |
+------------------------------+----------------------+
```

## 6. Current Real Runtime Path

```text
session preload + task + taskSummary + dependencyTaskSummaries + priorRunSummaries + sessionSummary + artifactBlocks + memoryHits
                              |
                              v
                     buildContextSnapshot()
                              |
                              v
                     OpenCodeAdapter.renderContext()
                              |
                              v
                       opencode run --format json
                              |
                              v
                          stdout JSON lines
                              |
                              v
                        attachJsonLineReader()
                              |
                              v
                         normalizeEvent()
                              |
                              v
                       canonical event store
                    /              |              \
                   v               v               v
           RunHandle stream    run state      async derived context
                                              + extraction / summaries / graph-aware pruning
```

## 7. Current Gaps

The current repository has strong platform foundations, but CLI-agent transparent takeover is not done yet. See [Transparent Runtime Integration](/e:/vibecoding/sdk/V1/docs/transparent-runtime-integration.md).


```text
+----------------------+------------------------------------------------------+
| Implemented          | canonical run pipeline                               |
|                      | context injection / replacement                      |
|                      | session-level preload cache                          |
|                      | memory=platform retrieval + extraction               |
|                      | memory=tool-bridge executor + MCP bridge             |
|                      | task-level memory consolidation                      |
|                      | session archive consolidation                        |
|                      | automatic settled-session consolidation              |
|                      | rule-based RunSummary + TaskSummary                  |
|                      | rule-based SessionSummary                            |
|                      | ToolCallRef indexing for error/artifact paths        |
|                      | minimal run/task/session graph indexes               |
|                      | graph-aware context pruning                          |
|                      | collector-based context snapshot assembly            |
|                      | artifact capture-store + experimental ArtifactAPI    |
|                      | platform task tools + task bridge                     |
|                      | canonical checkpoint / resume                         |
|                      | real OpenCode adapter + smoke test                   |
+----------------------+------------------------------------------------------+
| Not implemented yet  | richer native task tree mirroring for CLI hooks         |
+----------------------+------------------------------------------------------+
```






## 8. Adapter Support

- [Adapter Support Matrix](/e:/vibecoding/sdk/V1/docs/adapter-support-matrix.md)
- [OpenCode Transparent Integration Assessment](/e:/vibecoding/sdk/V1/docs/opencode-transparent-integration-assessment.md)
- Current production-shaped adapter coverage is documented there; OpenCode is the most complete real adapter path in this repository today.
