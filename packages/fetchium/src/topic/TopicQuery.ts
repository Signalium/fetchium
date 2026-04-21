import { Query } from '../query.js';
import type { TopicQueryAdapter } from './TopicQueryAdapter.js';
import type { QueryAdapterClass } from '../QueryAdapter.js';
import type { QueryConfigOptions } from '../query-types.js';

// ================================
// TopicQuery — declarative topic-based query definition
// ================================

export abstract class TopicQuery extends Query {
  static override adapter: QueryAdapterClass<TopicQueryAdapter>;

  abstract topic: string;

  getIdentityKey(): string {
    return `topic:${this.topic}`;
  }

  getConfig(): QueryConfigOptions {
    return {
      staleTime: 0,
      subscribe: () => {
        return () => {
          const adapter = (this as Record<string, any>)._topicAdapter as TopicQueryAdapter | undefined;
          adapter?.unsubscribe(this.topic);
        };
      },
    };
  }
}
