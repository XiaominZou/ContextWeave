import fs from "node:fs";
import path from "node:path";

import type { MemoryEngine, MemoryProvider, MemoryRecordV1_1 } from "@ctx/core";
import { createInMemoryMemorySubsystem } from "./in-memory-memory";

interface PersistedMemoryState {
  records: MemoryRecordV1_1[];
  nextId: number;
}

export function createFileBackedMemorySubsystem(filePath: string): {
  provider: MemoryProvider;
  engine: MemoryEngine;
  state: { records: Map<string, MemoryRecordV1_1>; nextId: number };
} {
  const base = createInMemoryMemorySubsystem();
  const persisted = readJsonFile<PersistedMemoryState>(filePath, { records: [], nextId: 1 });

  for (const record of persisted.records) {
    base.state.records.set(record.id, record);
  }
  base.state.nextId = persisted.nextId > 0 ? persisted.nextId : inferNextId(base.state.records);

  const persist = () => {
    ensureParentDir(filePath);
    const payload: PersistedMemoryState = {
      records: [...base.state.records.values()],
      nextId: base.state.nextId,
    };
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  };

  const provider: MemoryProvider = {
    async get(id) {
      return base.provider.get(id);
    },
    async search(input) {
      return base.provider.search(input);
    },
    async put(record) {
      const stored = await base.provider.put(record);
      persist();
      return stored;
    },
    async update(id, patch) {
      const updated = await base.provider.update(id, patch);
      persist();
      return updated;
    },
    async archive(id, opts) {
      await base.provider.archive(id, opts);
      persist();
    },
    async invalidate(id, opts) {
      await base.provider.invalidate(id, opts);
      persist();
    },
    async delete(id) {
      await base.provider.delete(id);
      persist();
    },
  };

  const engine: MemoryEngine = {
    async search(query) {
      return base.engine.search(query);
    },
    async writeExperience(input) {
      const stored = await base.engine.writeExperience(input);
      persist();
      return stored;
    },
    async writeConfirmed(input) {
      const stored = await base.engine.writeConfirmed(input);
      persist();
      return stored;
    },
    async consolidateTask(input) {
      const result = await base.engine.consolidateTask(input);
      persist();
      return result;
    },
    async promote(input) {
      const result = await base.engine.promote(input);
      persist();
      return result;
    },
  };

  return {
    provider,
    engine,
    state: base.state,
  };
}

function inferNextId(records: Map<string, MemoryRecordV1_1>): number {
  let maxId = 0;
  for (const record of records.values()) {
    const numeric = Number(record.id.replace(/^mem_/, ""));
    if (Number.isFinite(numeric)) {
      maxId = Math.max(maxId, numeric);
    }
  }
  return maxId + 1;
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
