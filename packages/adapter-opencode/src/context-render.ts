import type { ContextBlock, ContextSnapshot } from "@ctx/core";

const SUMMARY_ONLY_MAX_CHARS = 240;

export function renderSnapshotToPromptText(snapshot: ContextSnapshot | null): string {
  if (!snapshot) {
    return "";
  }

  return snapshot.blocks.map((block) => renderBlockForPrompt(block)).join("\n");
}

function renderBlockForPrompt(block: ContextBlock): string {
  const retentionAction = typeof block.metadata?.["retentionAction"] === "string"
    ? String(block.metadata["retentionAction"])
    : "expand";

  if (retentionAction !== "summary-only") {
    return block.content;
  }

  const header = block.title ? `[${block.kind}] ${block.title}` : `[${block.kind}] ${block.sourceRef}`;
  const summary = compactWhitespace(block.content);
  if (!summary) {
    return header;
  }

  return [header, truncate(summary, SUMMARY_ONLY_MAX_CHARS)].join("\n");
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
