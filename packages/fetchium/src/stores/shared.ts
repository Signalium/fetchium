// Query Instance keys
export const VALUE_PREFIX = 'sq:doc:value:';
export const valueKeyFor = (id: number) => `${VALUE_PREFIX}${id}`;
export const refCountKeyFor = (id: number) => `sq:doc:refCount:${id}`;
export const refIdsKeyFor = (id: number) => `sq:doc:refIds:${id}`;
export const updatedAtKeyFor = (id: number) => `sq:doc:updatedAt:${id}`;
// Query Type keys
export const queueKeyFor = (queryDefId: string) => `sq:doc:queue:${queryDefId}`;
// Query Type metadata keys (used for stale cache cleanup)
export const lastUsedKeyFor = (queryDefId: string) => `sq:doc:lastUsed:${queryDefId}`;
export const cacheTimeKeyFor = (queryDefId: string) => `sq:doc:cacheTime:${queryDefId}`;

export const LAST_USED_PREFIX = 'sq:doc:lastUsed:';

// Default values
export const DEFAULT_MAX_COUNT = 50;
export const DEFAULT_CACHE_TIME = 60 * 24; // 24 hours in minutes
export const DEFAULT_GC_TIME = 5; // 5 minutes - in-memory eviction default

/** Merges at the JSON level and derives refs from the `__entityRef` markers. */
export function mergeStoredRecord(
  stored: string,
  partial: unknown,
): { value: Record<string, unknown>; refIds: Set<number> | undefined } | undefined {
  let record: unknown;
  try {
    record = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const value = {
    ...(record as Record<string, unknown>),
    ...(JSON.parse(JSON.stringify(partial)) as object),
  };
  const refIds = new Set<number>();
  collectEntityRefs(value, refIds);
  return { value, refIds: refIds.size > 0 ? refIds : undefined };
}

function collectEntityRefs(value: unknown, into: Set<number>): void {
  if (typeof value !== 'object' || value === null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) collectEntityRefs(value[i], into);
    return;
  }
  const ref = (value as { __entityRef?: unknown }).__entityRef;
  if (typeof ref === 'number') {
    into.add(ref);
    return;
  }
  for (const key in value) collectEntityRefs((value as Record<string, unknown>)[key], into);
}
