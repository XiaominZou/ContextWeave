import type { CapabilityPolicy, MemorySearchHit, Run, Session } from "@ctx/core";

import type { MemoryAPI } from "../contracts";

const DEFAULT_SESSION_PRELOAD_LIMIT = 3;

export interface SessionPreloadCacheEntry {
  userId: string;
  hits: MemorySearchHit[];
  cachedAt: string;
}

export type SessionPreloadCache = Map<string, SessionPreloadCacheEntry>;

export async function maybeGetSessionPreloadedMemory(input: {
  session: Session;
  run: Run;
  policy: CapabilityPolicy;
  memoryApi: MemoryAPI;
  cache: SessionPreloadCache;
}): Promise<MemorySearchHit[]> {
  if (input.policy.context === "native" || input.policy.memory !== "platform") {
    return [];
  }

  const userId = extractStableUserId(input.session, input.run);
  if (!userId) {
    return [];
  }

  const cacheKey = input.session.id;
  const cached = input.cache.get(cacheKey);
  if (cached && cached.userId === userId) {
    return cached.hits;
  }

  const result = await input.memoryApi.search({
    anchor: {
      workspaceId: input.run.workspaceId,
      sessionId: input.run.sessionId,
      userId,
    },
    queryText: buildSessionPreloadQueryText(input.session),
    layer: "long_term",
    channel: "profile",
    maxResults: DEFAULT_SESSION_PRELOAD_LIMIT,
  });

  input.cache.set(cacheKey, {
    userId,
    hits: result.hits,
    cachedAt: new Date().toISOString(),
  });

  return result.hits;
}

export function invalidateSessionPreload(cache: SessionPreloadCache, sessionId: string): void {
  cache.delete(sessionId);
}

function extractStableUserId(session: Session, run: Run): string | undefined {
  const sessionUserId = typeof session.metadata?.["userId"] === "string" ? String(session.metadata["userId"]) : undefined;
  if (sessionUserId) {
    return sessionUserId;
  }

  const runUserId = typeof run.metadata?.["userId"] === "string" ? String(run.metadata["userId"]) : undefined;
  return runUserId;
}

function buildSessionPreloadQueryText(session: Session): string {
  const parts = [
    session.title,
    typeof session.metadata?.["profileQuery"] === "string" ? String(session.metadata["profileQuery"]) : undefined,
    "stable user profile memory",
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return parts.join("\n");
}
