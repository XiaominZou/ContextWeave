const idCounters = new Map<string, number>();

export function nextId(prefix: string): string {
  const current = idCounters.get(prefix) ?? 0;
  const next = current + 1;
  idCounters.set(prefix, next);
  return `${prefix}_${next}`;
}
