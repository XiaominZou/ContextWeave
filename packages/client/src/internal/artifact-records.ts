import type { Artifact, Run } from "@ctx/core";

export interface ArtifactCandidate {
  id: string;
  type?: string;
  uri?: string;
  mimeType?: string;
  title?: string;
  summary?: string;
  hash?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

export function extractArtifactIds(output: unknown): string[] {
  return extractArtifactCandidates(output).map((candidate) => candidate.id);
}

export function extractArtifactCandidates(output: unknown): ArtifactCandidate[] {
  if (!output || typeof output !== "object") {
    return [];
  }

  const direct = output as Record<string, unknown>;
  const candidates = new Map<string, ArtifactCandidate>();

  addCandidate(candidates, buildCandidateFromObject(direct));
  addCandidate(candidates, buildCandidateFromObject(readObject(direct["artifact"])));

  collectStringArray(direct["artifactIds"], (value) => addCandidate(candidates, { id: value }));
  collectStringArray(direct["artifactRefs"], (value) => addCandidate(candidates, { id: value }));
  collectObjectArray(direct["artifactRefs"], (value) => addCandidate(candidates, buildCandidateFromObject(value)));
  collectObjectArray(direct["artifacts"], (value) => addCandidate(candidates, buildCandidateFromObject(value)));

  return [...candidates.values()];
}

export function buildArtifactRecord(input: {
  run: Run;
  candidate: ArtifactCandidate;
  createdAt: string;
  toolCallId?: string;
  toolName?: string;
  sourceEventId: string;
  captureMode: "observe" | "capture-store";
}): Artifact {
  return {
    id: input.candidate.id,
    workspaceId: input.run.workspaceId,
    sessionId: input.run.sessionId,
    taskId: input.run.taskId,
    runId: input.run.id,
    type: input.candidate.type ?? "generic",
    uri: input.candidate.uri ?? `artifact://${input.candidate.id}`,
    mimeType: input.candidate.mimeType,
    title: input.candidate.title,
    summary: input.candidate.summary,
    hash: input.candidate.hash,
    size: input.candidate.size,
    createdAt: input.createdAt,
    metadata: {
      ...input.candidate.metadata,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      sourceEventId: input.sourceEventId,
      captureMode: input.captureMode,
    },
  };
}

function addCandidate(target: Map<string, ArtifactCandidate>, candidate: ArtifactCandidate | null | undefined): void {
  if (!candidate?.id) {
    return;
  }

  const existing = target.get(candidate.id);
  if (!existing) {
    target.set(candidate.id, candidate);
    return;
  }

  target.set(candidate.id, {
    id: candidate.id,
    type: existing.type ?? candidate.type,
    uri: existing.uri ?? candidate.uri,
    mimeType: existing.mimeType ?? candidate.mimeType,
    title: existing.title ?? candidate.title,
    summary: existing.summary ?? candidate.summary,
    hash: existing.hash ?? candidate.hash,
    size: existing.size ?? candidate.size,
    metadata: {
      ...(candidate.metadata ?? {}),
      ...(existing.metadata ?? {}),
    },
  });
}

function buildCandidateFromObject(value: Record<string, unknown> | undefined): ArtifactCandidate | null {
  if (!value) {
    return null;
  }

  const uri = firstString(value, ["uri", "url", "path"]);
  const id =
    firstString(value, ["id", "artifactId", "artifactRef"]) ??
    (uri ? `art_${stableHash(uri).slice(0, 12)}` : undefined);

  if (!id) {
    return null;
  }

  return {
    id,
    type: firstString(value, ["type", "kind"]) ?? inferType(uri),
    uri,
    mimeType: firstString(value, ["mimeType", "mime", "contentType"]),
    title: firstString(value, ["title", "name"]),
    summary: firstString(value, ["summary", "description"]),
    hash: firstString(value, ["hash"]),
    size: firstNumber(value, ["size", "bytes"]),
    metadata: readObject(value["metadata"]),
  };
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const nested = value[key];
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested.trim();
    }
  }
  return undefined;
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const nested = value[key];
    if (typeof nested === "number" && Number.isFinite(nested)) {
      return nested;
    }
  }
  return undefined;
}

function collectStringArray(value: unknown, onItem: (value: string) => void): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    if (typeof item === "string" && item.trim().length > 0) {
      onItem(item.trim());
    }
  }
}

function collectObjectArray(value: unknown, onItem: (value: Record<string, unknown>) => void): void {
  if (!Array.isArray(value)) {
    return;
  }
  for (const item of value) {
    const record = readObject(item);
    if (record) {
      onItem(record);
    }
  }
}

function inferType(uri?: string): string {
  if (!uri) {
    return "generic";
  }
  if (uri.endsWith(".md") || uri.endsWith(".txt")) {
    return "text";
  }
  if (uri.endsWith(".json")) {
    return "json";
  }
  if (uri.endsWith(".png") || uri.endsWith(".jpg") || uri.endsWith(".jpeg") || uri.endsWith(".gif")) {
    return "image";
  }
  return "file";
}

function readObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
