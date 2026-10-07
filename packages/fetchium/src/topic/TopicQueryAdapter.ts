import { QueryAdapter } from '../QueryAdapter.js';
import { getAbortReason } from '../retry.js';
import type { Query } from '../query.js';
import type { MutationEvent } from '../types.js';

// ================================
// TopicQueryAdapter — abstract adapter for topic-based subscriptions
// ================================

interface TopicCtx extends Query {
  topic?: string;
  getTopic?(): string;
  _topicAdapter?: TopicQueryAdapter;
}

interface TopicState {
  status: 'pending' | 'fulfilled' | 'rejected';
  promise?: Promise<unknown>;
  resolve?: (data: unknown) => void;
  reject?: (error: unknown) => void;
  data?: unknown;
  error?: unknown;
}

/** `promise`, or a rejection once `signal` aborts. A topic fetch would otherwise hang after deactivation. */
function untilAborted(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  // React Native's AbortController sets no `reason`, so getAbortReason() falls back.
  if (signal.aborted) return Promise.reject(getAbortReason(signal));
  return new Promise((resolve, reject) => {
    const onAbort = (): void => reject(getAbortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export abstract class TopicQueryAdapter extends QueryAdapter {
  private _topics = new Map<string, TopicState>();
  /** Per topic, the subscribed queries' callbacks for a delivered event. */
  private _pushListeners = new Map<string, Set<() => void>>();

  /**
   * Called when a query activates for a given topic.
   * Implementations should start delivering data for this topic,
   * calling `fulfillTopic()` when initial data is available and
   * `sendMutationEvent()` for ongoing updates.
   */
  abstract subscribe(topic: string): void;

  /**
   * Called when the query deactivates. Implementations should
   * tear down any resources for this topic.
   */
  abstract unsubscribe(topic: string): void;

  /**
   * Resolve the pending promise for a topic with initial data.
   * Can be called before `send()` — the data will be picked up
   * when the query activates.
   */
  protected fulfillTopic(topic: string, data: unknown): void {
    const state = this._topics.get(topic);

    if (state === undefined) {
      this._topics.set(topic, { status: 'fulfilled', data });
      return;
    }

    if (state.status === 'pending') {
      state.status = 'fulfilled';
      state.data = data;
      state.resolve!(data);
    }
  }

  /**
   * Reject the pending promise for a topic.
   * Can be called before `send()` — the error will be propagated
   * when the query activates.
   */
  protected rejectTopic(topic: string, error: unknown): void {
    const state = this._topics.get(topic);

    if (state === undefined) {
      this._topics.set(topic, { status: 'rejected', error });
      return;
    }

    if (state.status === 'pending') {
      state.status = 'rejected';
      state.error = error;
      state.reject!(error);
    }
  }

  /**
   * Clears internal state for a topic. Called automatically by
   * `unsubscribe` — subclasses generally don't need to call this.
   */
  protected clearTopic(topic: string): void {
    this._topics.delete(topic);
  }

  protected clearAll(): void {
    this._topics.clear();
  }

  override async send(ctx: Query, signal: AbortSignal): Promise<unknown> {
    const topicCtx = ctx as TopicCtx;
    const topic = topicCtx.getTopic ? topicCtx.getTopic() : topicCtx.topic;

    if (topic === undefined) {
      throw new Error('TopicQuery requires a topic. Define `topic` as a field or override `getTopic()`.');
    }

    const existing = this._topics.get(topic);

    if (existing) {
      switch (existing.status) {
        case 'fulfilled':
          return existing.data;
        case 'rejected':
          throw existing.error;
        case 'pending':
          return untilAborted(existing.promise!, signal);
      }
    }

    // No state yet, create a deferred. Subscribe is handled by
    // `TopicQuery.getConfig.subscribe`, which runs before this path.
    let resolve!: (data: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this._topics.set(topic, { status: 'pending', promise, resolve, reject });

    return untilAborted(promise, signal);
  }

  /**
   * Convenience wrapper — pushes a mutation event through the QueryClient
   * so that entities and live collections are updated reactively.
   *
   * Pass the `topic` the event arrived on to mark that topic's queries as
   * current, so their `reactivationGraceMs` measures from this event.
   */
  protected sendMutationEvent(event: MutationEvent, topic?: string): void {
    if (topic !== undefined) {
      const listeners = this._pushListeners.get(topic);
      if (listeners !== undefined) for (const listener of listeners) listener();
    }
    this.queryClient!.applyMutationEvent(event);
  }

  /**
   * Registers a subscribed query's callback for events delivered on `topic`.
   * Returns a function that removes it.
   *
   * @internal
   */
  _addPushListener(topic: string, listener: () => void): () => void {
    let listeners = this._pushListeners.get(topic);
    if (listeners === undefined) {
      listeners = new Set();
      this._pushListeners.set(topic, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && this._pushListeners.get(topic) === listeners) this._pushListeners.delete(topic);
    };
  }
}
