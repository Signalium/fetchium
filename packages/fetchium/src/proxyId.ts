import type { EntitySnapshotSource } from './EntityInstance.js';

/** Each entity proxy's snapshot source, which carries its entity key, so a proxy costs one entry here. */
export const PROXY_ID = new WeakMap<object, EntitySnapshotSource>();

export function getProxyId(object: Record<string, unknown>): number | undefined {
  return PROXY_ID.get(object)?.key;
}
