import type { Notifier } from 'signalium';

/**
 * The wrapping proxy handed out for a nested object, record or array inside
 * an entity, keyed by the wrapped value. Nested values are merged in place,
 * so a wrapper keeps its identity when its contents change; reads through it
 * consume `changes`, and the merge notifies it. `EntityInstance` creates the
 * wrappers, `applyEntities` notifies them.
 */
export interface NestedWrapper {
  readonly proxy: object;
  /** Created by the first read; nothing to notify before that. */
  changes: Notifier | undefined;
}

export const NESTED_WRAPPERS = new WeakMap<object, NestedWrapper>();

/** Tell readers of a nested value that a merge changed it in place. */
export function notifyNestedValue(value: object): void {
  NESTED_WRAPPERS.get(value)?.changes?.notify();
}
