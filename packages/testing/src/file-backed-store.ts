import fs from "node:fs";
import path from "node:path";

import type { AgentEventEnvelope, Artifact, Checkpoint, Run, Session, Task } from "@ctx/core";
import { InMemoryStore } from "./in-memory-store";

interface PersistedStoreState {
  sessions: Session[];
  tasks: Task[];
  runs: Run[];
  events: AgentEventEnvelope[];
  artifacts: Artifact[];
  checkpoints: Checkpoint[];
}

const EMPTY_STATE: PersistedStoreState = {
  sessions: [],
  tasks: [],
  runs: [],
  events: [],
  artifacts: [],
  checkpoints: [],
};

export class FileBackedStore extends InMemoryStore {
  private readonly filePath: string;

  constructor(filePath: string) {
    super();
    this.filePath = filePath;
    this.load();
  }

  override saveSession(session: Session): Session {
    const saved = super.saveSession(session);
    this.persist();
    return saved;
  }

  override saveTask(task: Task): Task {
    const saved = super.saveTask(task);
    this.persist();
    return saved;
  }

  override saveRun(run: Run): Run {
    const saved = super.saveRun(run);
    this.persist();
    return saved;
  }

  override appendEvent(event: AgentEventEnvelope): void {
    super.appendEvent(event);
    this.persist();
  }

  override saveArtifact(artifact: Artifact): Artifact {
    const saved = super.saveArtifact(artifact);
    this.persist();
    return saved;
  }

  override deleteArtifact(id: string): void {
    super.deleteArtifact(id);
    this.persist();
  }

  override saveCheckpoint(checkpoint: Checkpoint): Checkpoint {
    const saved = super.saveCheckpoint(checkpoint);
    this.persist();
    return saved;
  }

  private load(): void {
    const state = readJsonFile<PersistedStoreState>(this.filePath, EMPTY_STATE);
    for (const session of state.sessions) {
      super.saveSession(session);
    }
    for (const task of state.tasks) {
      super.saveTask(task);
    }
    for (const run of state.runs) {
      super.saveRun(run);
    }
    for (const event of state.events) {
      super.appendEvent(event);
    }
    for (const artifact of state.artifacts) {
      super.saveArtifact(artifact);
    }
    for (const checkpoint of state.checkpoints) {
      super.saveCheckpoint(checkpoint);
    }
  }

  private persist(): void {
    ensureParentDir(this.filePath);
    const state: PersistedStoreState = {
      sessions: this.listSessions(),
      tasks: this.listTasks(),
      runs: [...this.runs.values()],
      events: [...this.events.values()].flat(),
      artifacts: this.listArtifacts(),
      checkpoints: this.listCheckpoints(),
    };
    fs.writeFileSync(this.filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "").trim();
    if (!raw) {
      return fallback;
    }
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
