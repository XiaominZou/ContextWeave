## ADDED Requirements

### Requirement: LLM Call Recording
The harness SHALL record every LLM API call with complete metadata.

#### Scenario: Record successful LLM call
- **WHEN** an LLM API call completes
- **THEN** the harness creates an LlmCallRecord with callId, round, mode, purpose, inputTokens, outputTokens, timestamp

#### Scenario: Record context breakdown for platform modes
- **WHEN** running in Platform+Context or Platform+Context+Memory mode
- **THEN** the harness records contextBreakdown with taskBlockTokens, memoryTokens, historyTokens, artifactRefTokens, memoryExtractionTokens

#### Scenario: Record memory extraction tokens for C-real
- **WHEN** running in Mode C-real and memory extraction completes
- **THEN** memoryExtractionTokens is recorded separately in contextBreakdown

### Requirement: Tool Use Recording
The harness SHALL record every tool call and result.

#### Scenario: Record tool call
- **WHEN** agent invokes a tool
- **THEN** the harness creates a ToolUseRecord with callId, round, toolName, inputSignature, isError, availableMemoryIds

#### Scenario: Detect duplicate tool calls
- **WHEN** the same tool is called with identical inputSignature
- **THEN** the harness marks the second call as a potential duplicate

### Requirement: Event Stream Tap
The harness SHALL tap into the agent event stream without affecting execution.

#### Scenario: Tap events from RunHandle
- **WHEN** RunHandle.streamEvents() yields events
- **THEN** the harness captures each AgentEventEnvelope for analysis

### Requirement: Wasted Call Detection
The harness SHALL detect tool calls that could have been avoided with proper memory.

#### Scenario: Detect wasted file read when memory available
- **WHEN** agent calls read_file with the same inputSignature in the same round
- **AND** availableMemoryIds is non-empty for that tool call
- **THEN** the harness flags the second call as wasted

#### Scenario: Detect wasted tool call with relevant memory
- **WHEN** agent calls a tool with inputSignature that matches a previous call
- **AND** availableMemoryIds contains a memory record relevant to this tool call
- **THEN** the harness flags the call as wasted
