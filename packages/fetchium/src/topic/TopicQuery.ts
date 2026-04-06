import { Query } from '../query.js';
import type { TopicQueryController } from './TopicQueryController.js';
import type { QueryConfigOptions } from '../query-types.js';

// ================================
// TopicQuery — declarative topic-based query definition
// ================================

export abstract class TopicQuery extends Query {
  static override controller: typeof TopicQueryController;

  abstract topic: string;

  getIdentityKey(): string {
    return `topic:${this.topic}`;
  }

  getConfig(): QueryConfigOptions {
    return {
      staleTime: 0,
      subscribe: () => {
        return () => {
          const controller = (this as Record<string, any>)._topicController as
            | TopicQueryController
            | undefined;
          controller?.unsubscribe(this.topic);
        };
      },
    };
  }
}
