import { describe, it, expect, afterEach } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import type { QueryAdapterClass } from '../QueryAdapter.js';
import { fetchQuery } from '../query.js';
import { t } from '../typeDefs.js';
import { sleep } from './utils.js';

// Snapshots from separate tasks flush separately. Batching those is the adapter's job.

class SnapshotAdapter extends TopicQueryAdapter {
  subscribe(_topic: string): void {}

  unsubscribe(topic: string): void {
    this.clearTopic(topic);
  }

  deliver(topic: string, data: unknown): void {
    this.fulfillTopic(topic, data);
  }
}

abstract class SnapshotTopicQuery extends TopicQuery {
  static override adapter: QueryAdapterClass<TopicQueryAdapter> = SnapshotAdapter;
}

const TOPICS = ['t:1', 't:2', 't:3', 't:4', 't:5'];

const QUERIES = TOPICS.map(
  topic =>
    class extends SnapshotTopicQuery {
      topic = topic;
      result = { n: t.number };
    },
);

describe('batched topic snapshot delivery', () => {
  let client: QueryClient;
  let unsub: (() => void) | undefined;

  afterEach(() => {
    unsub?.();
    client?.destroy();
  });

  async function setup(): Promise<{ adapter: SnapshotAdapter; runs: () => number; values: () => unknown[] }> {
    const adapter = new SnapshotAdapter();
    client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [adapter],
    });

    // A flush runs every dirty watcher's listener, so count flushes by task.
    let flushes = 0;
    let flushScheduled = false;
    const latest: unknown[] = QUERIES.map(() => undefined);
    const unsubs = QUERIES.map((Q, i) => {
      const w = withContexts([[QueryClientContext, client]], () => watcher(() => fetchQuery(Q).value?.n));
      return w.addListener(() => {
        latest[i] = w.value;
        if (!flushScheduled) {
          flushScheduled = true;
          flushes++;
          setTimeout(() => (flushScheduled = false), 0);
        }
      });
    });
    unsub = () => unsubs.forEach(u => u());
    await sleep(20);
    return { adapter, runs: () => flushes, values: () => latest };
  }

  it('settles every query from one delivery task in one flush', async () => {
    const { adapter, runs, values } = await setup();
    expect(values()).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const before = runs();

    TOPICS.forEach((topic, i) => adapter.deliver(topic, { n: i + 1 }));
    await sleep(20);

    expect(values()).toEqual([1, 2, 3, 4, 5]);
    expect(runs() - before).toBe(1);
  });

  it('flushes once per task when deliveries are spread across tasks', async () => {
    const { adapter, runs, values } = await setup();
    const before = runs();

    for (const [i, topic] of TOPICS.entries()) {
      adapter.deliver(topic, { n: i + 1 });
      await sleep(5);
    }
    await sleep(20);

    expect(values()).toEqual([1, 2, 3, 4, 5]);
    expect(runs() - before).toBe(TOPICS.length);
  });
});
