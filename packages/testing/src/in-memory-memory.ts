import {
  resolveDefaultMemoryChannel,
  validateWriteConfirmedInput,
  validateWriteExperienceInput,
  type ConsolidateTaskInput,
  type MemoryChannel,
  type MemoryEngine,
  type MemoryNamespaceAnchor,
  type MemoryNamespaceSlice,
  type MemoryProvider,
  type MemoryRecordDraftV1_1,
  type MemoryRecordPatchV1_1,
  type MemoryRecordV1_1,
  type MemorySearchQuery,
  type MemorySearchResult,
  type PromoteMemoryInput,
  type PromotionResult,
  type ProviderSearchHit,
  type ProviderSearchInput,
  type WriteConfirmedInput,
  type WriteExperienceInput,
} from "@ctx/core";

interface InMemoryMemoryState {
  records: Map<string, MemoryRecordV1_1>;
  nextId: number;
}

export function createInMemoryMemorySubsystem(): {
  provider: MemoryProvider;
  engine: MemoryEngine;
  state: InMemoryMemoryState;
} {
  const state: InMemoryMemoryState = {
    records: new Map<string, MemoryRecordV1_1>(),
    nextId: 1,
  };

  const provider: MemoryProvider = {
    async get(id) {
      return state.records.get(id) ?? null;
    },
    async search(input) {
      return searchRecords(state, input);
    },
    async put(record) {
      const stored = materializeRecord(state, record);
      state.records.set(stored.id, stored);
      return stored;
    },
    async update(id, patch) {
      const current = state.records.get(id);
      if (!current) {
        throw memoryError("MEMORY_NOT_FOUND", `Memory not found: ${id}`);
      }
      const updated: MemoryRecordV1_1 = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      state.records.set(id, updated);
      return updated;
    },
    async archive(id, opts) {
      await provider.update(id, {
        status: "archived",
        replacedBy: opts?.replacedBy,
        archivedAt: new Date().toISOString(),
      });
    },
    async invalidate(id, opts) {
      await provider.update(id, {
        status: "invalidated",
        invalidatedBy: opts?.invalidatedBy,
      });
    },
    async delete(id) {
      state.records.delete(id);
    },
  };

  const engine: MemoryEngine = {
    async search(query) {
      const namespaces = expandNamespaces(query.anchor);
      const hits = await provider.search({
        workspaceId: query.anchor.workspaceId,
        namespaces,
        queryText: query.queryText,
        layer: query.layer,
        channel: query.channel,
        kind: query.kind,
        status: ["active", "candidate"],
        limit: query.maxResults ?? 10,
      });

      return {
        hits: hits.map((hit) => ({
          record: hit.record,
          finalScore: computeFinalScore(hit),
        })),
        namespacesSearched: namespaces,
      } satisfies MemorySearchResult;
    },

    async writeExperience(input) {
      validateWriteExperienceInput(input);
      return provider.put(input.record);
    },

    async writeConfirmed(input) {
      validateWriteConfirmedInput(input);
      return provider.put(input.record);
    },

    async consolidateTask(input) {
      const candidates = [...state.records.values()]
        .filter((record) => record.workspaceId === input.workspaceId)
        .filter((record) => record.taskId === input.taskId)
        .filter((record) => record.layer === "experience")
        .filter((record) => record.status === "candidate");

      const results: PromotionResult[] = [];
      for (const candidate of candidates) {
        results.push(await promoteCandidate({ provider, state, candidate }));
      }
      return results;
    },

    async promote(input) {
      const record = await provider.get(input.memoryId);
      if (!record) {
        throw memoryError("MEMORY_NOT_FOUND", `Memory not found: ${input.memoryId}`);
      }
      return promoteCandidate({ provider, state, candidate: record, targetChannel: input.targetChannel });
    },
  };

  return { provider, engine, state };
}

async function promoteCandidate(input: {
  provider: MemoryProvider;
  state: InMemoryMemoryState;
  candidate: MemoryRecordV1_1;
  targetChannel?: MemoryChannel;
}): Promise<PromotionResult> {
  const { provider, state, candidate } = input;
  const channel = input.targetChannel ?? candidate.channel ?? resolveDefaultMemoryChannel(candidate.kind);

  if (channel === "profile" && candidate.confirmedBy !== "user") {
    return {
      memoryId: candidate.id,
      action: "ADD_CANDIDATE",
      reason: "profile promotion requires user-confirmed memory",
    };
  }

  const targetScope = channel === "profile" && candidate.userId ? "user" : "workspace";
  const targetOwnerRef =
    targetScope === "user" && candidate.userId
      ? ({ type: "user", id: candidate.userId } as const)
      : ({ type: "workspace", id: candidate.workspaceId } as const);

  const existing = findExistingLongTermMatch(state, candidate, channel, targetScope, targetOwnerRef.id);
  if (existing) {
    const updated = await provider.update(existing.id, {
      title: candidate.title,
      content: candidate.content,
      summary: candidate.summary,
      confidence: Math.max(existing.confidence, candidate.confidence),
      importance: Math.max(existing.importance, candidate.importance),
      version: existing.version + 1,
      promotedFrom: candidate.id,
    });
    await provider.archive(candidate.id, { replacedBy: updated.id, reason: "promoted as update" });
    return {
      memoryId: candidate.id,
      action: "PROMOTE_UPDATE",
      targetId: existing.id,
      resultRecordId: updated.id,
      reason: "matched existing long_term memory",
    };
  }

  const promoted = await provider.put({
    workspaceId: candidate.workspaceId,
    userId: targetScope === "user" ? candidate.userId : undefined,
    ownerRef: targetOwnerRef,
    scope: targetScope,
    layer: "long_term",
    channel,
    kind: candidate.kind,
    status: "active",
    title: candidate.title,
    content: candidate.content,
    summary: candidate.summary,
    importance: candidate.importance,
    confidence: candidate.confidence,
    keywords: candidate.keywords,
    sourceRefs: candidate.sourceRefs,
    confirmedBy: candidate.confirmedBy,
  });
  await provider.update(promoted.id, { promotedFrom: candidate.id });
  await provider.archive(candidate.id, { replacedBy: promoted.id, reason: "promoted as new long_term memory" });

  return {
    memoryId: candidate.id,
    action: "PROMOTE_NEW",
    resultRecordId: promoted.id,
    reason: "promoted candidate to long_term memory",
  };
}

function findExistingLongTermMatch(
  state: InMemoryMemoryState,
  candidate: MemoryRecordV1_1,
  channel: MemoryChannel,
  scope: MemoryRecordV1_1["scope"],
  ownerId: string,
): MemoryRecordV1_1 | undefined {
  return [...state.records.values()].find((record) => {
    return (
      record.layer === "long_term" &&
      record.status === "active" &&
      record.channel === channel &&
      record.scope === scope &&
      ownerIdForRecord(record) === ownerId &&
      normalizeText(record.title) === normalizeText(candidate.title) &&
      normalizeText(record.content) === normalizeText(candidate.content)
    );
  });
}

function materializeRecord(state: InMemoryMemoryState, record: MemoryRecordDraftV1_1): MemoryRecordV1_1 {
  const now = new Date().toISOString();
  return {
    ...record,
    id: `mem_${state.nextId++}`,
    status: record.status ?? "active",
    importance: record.importance ?? 0.5,
    confidence: record.confidence ?? 0.5,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function searchRecords(state: InMemoryMemoryState, input: ProviderSearchInput): ProviderSearchHit[] {
  const tokens = tokenize(input.queryText ?? "");
  return [...state.records.values()]
    .filter((record) => record.workspaceId === input.workspaceId)
    .filter((record) => matchesNamespaces(record, input.namespaces))
    .filter((record) => (input.layer ? record.layer === input.layer : true))
    .filter((record) => (input.channel ? record.channel === input.channel : true))
    .filter((record) => (input.kind?.length ? input.kind.includes(record.kind) : true))
    .filter((record) => (input.status?.length ? input.status.includes(record.status) : true))
    .map((record) => ({
      record,
      vectorScore: textScore(record, tokens),
    }))
    .filter((hit) => (tokens.length > 0 ? (hit.vectorScore ?? 0) > 0 : true))
    .sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0))
    .slice(0, input.limit);
}

function expandNamespaces(anchor: MemoryNamespaceAnchor): MemoryNamespaceSlice[] {
  const namespaces: MemoryNamespaceSlice[] = [];
  if (anchor.runId) {
    namespaces.push({ scope: "run", ownerId: anchor.runId });
  }
  if (anchor.taskId) {
    namespaces.push({ scope: "task", ownerId: anchor.taskId });
  }
  if (anchor.sessionId) {
    namespaces.push({ scope: "session", ownerId: anchor.sessionId });
  }
  if (anchor.userId) {
    namespaces.push({ scope: "user", ownerId: anchor.userId });
  }
  namespaces.push({ scope: "workspace", ownerId: anchor.workspaceId });
  return namespaces;
}

function matchesNamespaces(record: MemoryRecordV1_1, namespaces: MemoryNamespaceSlice[]): boolean {
  const ownerId = ownerIdForRecord(record);
  return namespaces.some((namespace) => namespace.scope === record.scope && namespace.ownerId === ownerId);
}

function ownerIdForRecord(record: MemoryRecordV1_1): string {
  switch (record.scope) {
    case "run":
      return record.runId ?? record.ownerRef.id;
    case "task":
      return record.taskId ?? record.ownerRef.id;
    case "session":
      return record.sessionId ?? record.ownerRef.id;
    case "user":
      return record.userId ?? record.ownerRef.id;
    case "workspace":
      return record.workspaceId;
    case "global":
      return "global";
  }
}

function computeFinalScore(hit: ProviderSearchHit): number {
  const relevance = hit.vectorScore ?? 0;
  return relevance * 0.45 + hit.record.importance * 0.25 + hit.record.confidence * 0.15 + 0.15;
}

function textScore(record: MemoryRecordV1_1, tokens: string[]): number {
  if (tokens.length === 0) {
    return 1;
  }

  const haystack = normalizeText([
    record.title,
    record.summary,
    record.content,
    ...(record.keywords ?? []),
  ].filter(Boolean).join(" "));

  let matches = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) {
      matches += 1;
    }
  }
  return matches / tokens.length;
}

function tokenize(text: string): string[] {
  return normalizeText(text)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function memoryError(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

