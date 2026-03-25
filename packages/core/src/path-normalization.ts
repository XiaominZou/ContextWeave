export function normalizeContextFilePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").trim();
  if (!normalized) {
    return normalized;
  }

  const repoRelative = sliceAfterWorkspaceMarker(normalized);
  if (repoRelative) {
    return ensureLeadingSlash(repoRelative);
  }

  if (normalized.startsWith("/")) {
    return normalized;
  }

  return ensureLeadingSlash(normalized);
}

function sliceAfterWorkspaceMarker(value: string): string | undefined {
  const segments = value.split("/").filter((segment) => segment.length > 0);
  const markerIndex = segments.lastIndexOf("minikanban");
  if (markerIndex === -1 || markerIndex === segments.length - 1) {
    return undefined;
  }
  return segments.slice(markerIndex + 1).join("/");
}

function ensureLeadingSlash(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}
