import { QueryAdapter } from '../QueryAdapter.js';
import type { Query } from '../query.js';
import type { MutationEvent } from '../types.js';

// ================================
// TopicQueryAdapter — abstract adapter for topic-based subscriptions
// ================================

interface TopicCtx extends Query {
  topic: string;
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

export abstract class TopicQueryAdapter extends QueryAdapter {
  private _topics = new Map<string, TopicState>();

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

  override async send(ctx: Query, _signal: AbortSignal): Promise<unknown> {
    const topicCtx = ctx as TopicCtx;
    topicCtx._topicAdapter = this;
    const topic = topicCtx.topic;

    const existing = this._topics.get(topic);

    if (existing) {
      switch (existing.status) {
        case 'fulfilled':
          return existing.data;
        case 'rejected':
          throw existing.error;
        case 'pending':
          return existing.promise;
      }
    }

    // No state yet — create a deferred and subscribe
    let resolve!: (data: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this._topics.set(topic, { status: 'pending', promise, resolve, reject });
    this.subscribe(topic);

    return promise;
  }

  /**
   * Convenience wrapper — pushes a mutation event through the QueryClient
   * so that entities and live collections are updated reactively.
   */
  protected sendMutationEvent(event: MutationEvent): void {
    this.queryClient!.applyMutationEvent(event);
  }
}
