import { Query } from '../query.js';
import { TopicQueryAdapter } from './TopicQueryAdapter.js';
import type { QueryAdapterClass } from '../QueryAdapter.js';
import type { QueryConfigOptions } from '../query-types.js';

// ================================
// TopicQuery — declarative topic-based query definition
// ================================

export abstract class TopicQuery extends Query {
  // Explicit type lets subclasses override with adapters that take constructor args.
  static override adapter: QueryAdapterClass<TopicQueryAdapter> = TopicQueryAdapter;

  topic?: string;

  // User-overridable getter — the adapter reads this from the execution context.
  getTopic?(): string;

  getIdentityKey(): string {
    return `topic:${this.topic ?? ''}`;
  }

  getConfig(): QueryConfigOptions {
    return {
      staleTime: 0,
      subscribe: () => {
        const ctx = this as Record<string, any>;
        const adapter = ctx._topicAdapter as TopicQueryAdapter | undefined;
        const topic = this.getTopic ? this.getTopic() : this.topic;
        const notePush = ctx._notePush as (() => void) | undefined;
        let removeListener: (() => void) | undefined;
        if (adapter && topic !== undefined) {
          if (notePush !== undefined) removeListener = adapter._addPushListener(topic, notePush);
          adapter.subscribe(topic);
        }
        return () => {
          removeListener?.();
          if (adapter && topic !== undefined) {
            adapter.unsubscribe(topic);
          }
        };
      },
    };
  }
}
