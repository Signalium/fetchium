/**
 * The wrapping proxy handed out for a nested object, record or array inside
 * an entity (or a live collection's value), keyed by the wrapped value.
 * `EntityInstance` creates the wrappers; `applyEntities` drops an entity's
 * nested wrapper when a merge changes the value in place.
 */
export const NESTED_WRAPPERS = new WeakMap<object, object>();

/**
 * A merge changed a nested value in place. Its wrapper is dropped, so the
 * next read through the entity hands out a new one: the value is merged in
 * place to keep the raw data's identity, but whoever holds only the wrapper
 * (a child component given it as a prop) must see a new value to re-render.
 */
export function dropNestedWrapper(value: object): void {
  NESTED_WRAPPERS.delete(value);
}
