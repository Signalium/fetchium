/** Wrapping proxies for nested values in entities and live collections, keyed by raw value. */
export const NESTED_WRAPPERS = new WeakMap<object, object>();

/** Call when a merge changes a nested value in place, so the next read hands out a new wrapper. */
export function dropNestedWrapper(value: object): void {
  NESTED_WRAPPERS.delete(value);
}
