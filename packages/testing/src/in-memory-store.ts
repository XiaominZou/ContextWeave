import type { AgentEventEnvelope, Artifact, Checkpoint, MemoryRecord, Run, Session, Task } from "@ctx/core";

export class InMemoryStore {
  readonly sessions = new Map<string, Session>();
  readonly tasks = new Map<string, Task>();
  readonly runs = new Map<string, Run>();
  readonly events = new Map<string, AgentEventEnvelope[]>();
  readonly artifacts = new Map<string, Artifact>();
  readonly checkpoints = new Map<string, Checkpoint>();
  readonly memory = new Map<string, MemoryRecord>();

  saveSession(session: Session): Session {
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  saveTask(task: Task): Task {
    this.tasks.set(task.id, task);
    return task;
  }

  getTask(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  listTasks(): Task[] {
    return [...this.tasks.values()];
  }

  saveRun(run: Run): Run {
    this.runs.set(run.id, run);
    return run;
  }

  getRun(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  listRunsByTask(taskId: string): Run[] {
    return [...this.runs.values()].filter((run) => run.taskId === taskId);
  }

  appendEvent(event: AgentEventEnvelope): void {
    const current = this.events.get(event.runId) ?? [];
    current.push(event);
    this.events.set(event.runId, current);
  }

  listEvents(runId: string): AgentEventEnvelope[] {
    return this.events.get(runId) ?? [];
  }

  saveArtifact(artifact: Artifact): Artifact {
    this.artifacts.set(artifact.id, artifact);
    return artifact;
  }

  getArtifact(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  listArtifacts(): Artifact[] {
    return [...this.artifacts.values()];
  }

  deleteArtifact(id: string): void {
    this.artifacts.delete(id);
  }

  saveCheckpoint(checkpoint: Checkpoint): Checkpoint {
    this.checkpoints.set(checkpoint.id, checkpoint);
    return checkpoint;
  }

  getCheckpoint(id: string): Checkpoint | undefined {
    return this.checkpoints.get(id);
  }

  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints.values()];
  }
}

