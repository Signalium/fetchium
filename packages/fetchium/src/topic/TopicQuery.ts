import { Query } from '../query.js';
import { TopicQueryAdapter } from './TopicQueryAdapter.js';
import type { QueryAdapterClass } from '../QueryAdapter.js';
import type { QueryConfigOptions } from '../query-types.js';

// ================================
// TopicQuery — declarative topic-based query definition
// ================================

export abstract class TopicQuery extends Query {
  // The type is widened to `QueryAdapterClass<TopicQueryAdapter>` so subclasses
  // can override with concrete adapters whose constructors require arguments
  // (e.g. `new (url, token) => WebSocketTopicAdapter`). The value defaults to
  // the abstract base, which `QueryClient.getAdapter()` resolves via
  // subclass-aware lookup against any registered concrete subclass.
  static override adapter: QueryAdapterClass<TopicQueryAdapter> = TopicQueryAdapter;

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
