// Every key of cached data starts with this
export const DOC_PREFIX = 'sq:doc:';
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
// Per typename: the top-level fields its entity classes have declared
export const fieldNamesKeyFor = (typename: string) => `sq:meta:fields:${typename}`;
// Since when the field names cover every record (0: since the store held no cached data)
export const FIELD_NAMES_SINCE_KEY = 'sq:meta:fieldsSince';

// Default values
export const DEFAULT_MAX_COUNT = 50;
export const DEFAULT_CACHE_TIME = 60 * 24; // 24 hours in minutes
export const DEFAULT_GC_TIME = 5; // 5 minutes - in-memory eviction default

/**
 * Merges the fields of a partial record over a stored one, at the JSON level
 * (proxies have already been serialized to `{ __entityRef }` markers), and
 * derives the merged record's references from the markers it contains.
 */
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
  // A record that is not an object is not one to merge into; the caller
  // writes the fields as the record, which heals it.
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const value = {
    ...(record as Record<string, unknown>),
    ...(JSON.parse(JSON.stringify(partial)) as object),
  };
  const refIds = new Set<number>();
  collectEntityRefs(value, refIds);
  return { value, refIds: refIds.size > 0 ? refIds : undefined };
}

/**
 * What a stored record holds beyond the fields a partial write carries: those
 * fields as a JSON fragment (`"a":1,"b":{…}`, or `''` when there are none),
 * and the references inside them. A write of `partial` then appends the
 * fragment to the partial's own JSON, which is the merged record, without
 * reading or parsing the stored one again. Undefined when the stored record
 * is not a JSON object.
 */
export function storedRecordRest(
  stored: string,
  partial: Record<string, unknown>,
): { json: string; refIds: number[] } | undefined {
  let record: unknown;
  try {
    record = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return undefined;
  const rest: Record<string, unknown> = {};
  let any = false;
  for (const key in record as Record<string, unknown>) {
    // A field the partial holds as undefined is not written by it (JSON drops
    // it), so the stored value stays.
    if (partial[key] !== undefined) continue;
    rest[key] = (record as Record<string, unknown>)[key];
    any = true;
  }
  if (!any) return { json: '', refIds: [] };
  const refIds = new Set<number>();
  collectEntityRefs(rest, refIds);
  return { json: JSON.stringify(rest).slice(1, -1), refIds: [...refIds] };
}

/**
 * The fields of a parsed stored record that `data` does not hold as its own
 * keys: their names, the fields as a JSON object body (`"a":1,"b":{…}`), and
 * the references inside them. `undefined` when there are none.
 */
export function recordRestOutside(
  record: Record<string, unknown>,
  data: Record<string, unknown>,
): { keys: string[]; json: string; refIds: number[] } | undefined {
  let values: Record<string, unknown> | undefined;
  let keys: string[] | undefined;
  for (const key in record) {
    const value = record[key];
    if (value !== undefined && !Object.hasOwn(data, key)) {
      (values ??= {})[key] = value;
      (keys ??= []).push(key);
    }
  }
  if (values === undefined) return undefined;
  const refIds = new Set<number>();
  collectEntityRefs(values, refIds);
  return { keys: keys!, json: JSON.stringify(values).slice(1, -1), refIds: [...refIds] };
}

/** The `{ __entityRef }` markers in a record's JSON, as `collectEntityRefs` finds them in the parsed record. */
export function entityRefsInJson(json: string, into: Set<number>): void {
  if (json.indexOf('"__entityRef":') === -1) return;
  const re = /"__entityRef":(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(json)) !== null) into.add(Number(match[1]));
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
