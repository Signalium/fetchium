/**
 * Brands entity proxies with their numeric key. EntityInstance writes the record, with its snapshot
 * source, so each proxy costs one entry here instead of one per registry.
 */
export const PROXY_ID = new WeakMap<object, { readonly key: number }>();

export function getProxyId(object: Record<string, unknown>): number | undefined {
  return PROXY_ID.get(object)?.key;
}
