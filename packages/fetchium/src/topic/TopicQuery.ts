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
        const adapter = (this as Record<string, any>)._topicAdapter as TopicQueryAdapter | undefined;
        const topic = this.getTopic ? this.getTopic() : this.topic;
        if (adapter && topic !== undefined) {
          adapter.subscribe(topic);
        }
        return () => {
          if (adapter && topic !== undefined) {
            adapter.unsubscribe(topic);
          }
        };
      },
    };
  }
}
