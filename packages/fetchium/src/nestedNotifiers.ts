/**
 * Wrapping proxies for nested objects, records and arrays inside entities and
 * live collection values, keyed by the wrapped value. `EntityInstance` creates
 * them and `applyEntities` drops them on in-place merges.
 */
export const NESTED_WRAPPERS = new WeakMap<object, object>();

/**
 * Call when a merge changes a nested value in place. The raw value keeps its
 * identity, but a child holding only the wrapper (e.g. as a prop) needs a new
 * value to re-render, so the next read hands out a new wrapper.
 */
export function dropNestedWrapper(value: object): void {
  NESTED_WRAPPERS.delete(value);
}
