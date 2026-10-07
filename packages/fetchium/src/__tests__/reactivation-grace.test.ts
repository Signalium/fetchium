import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signal, withContexts } from 'signalium';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { t } from '../typeDefs.js';
import { QueryClient, QueryClientContext, type QueryClientConfig } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { NetworkManager } from '../NetworkManager.js';
import { poll } from '../subscriptions/polling.js';
import type { ActivitySource } from '../query-types.js';
import type { MutationEvent } from '../types.js';
import type { Query } from '../query.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import { Entity } from '../proxy.js';
import { createMockFetch, createTestWatcher } from './utils.js';

class GetA extends RESTQuery {
  path = '/a';
  result = { n: t.number };
}

class GetB extends RESTQuery {
  path = '/b';
  result = { n: t.number };
}

class GetC extends RESTQuery {
  path = '/c';
  result = { n: t.number };
}

describe('reactivation grace and stagger', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let starts: Array<{ path: string; at: number }>;
  let clients: QueryClient[];
  let unsubs: Array<() => void>;
  let counter: number;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = createMockFetch();
    starts = [];
    clients = [];
    unsubs = [];
    counter = 0;
    for (const path of ['/a', '/b', '/c']) {
      mockFetch.get(path, () => ({ n: ++counter }));
    }
  });

  afterEach(async () => {
    for (const unsub of unsubs) unsub();
    for (const client of clients) client.destroy();
    // Drain signalium's flush on the fake clock, or it blocks later flushes under real timers.
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
  });

  function makeClient(config: Partial<QueryClientConfig> = {}): QueryClient {
    const client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [
        new RESTQueryAdapter({
          baseUrl: 'http://localhost',
          fetch: ((url: string, options?: RequestInit) => {
            starts.push({ path: new URL(url).pathname, at: Date.now() });
            return mockFetch(url, options);
          }) as typeof fetch,
        }),
      ],
      ...config,
    });
    clients.push(client);
    return client;
  }

  function watch(client: QueryClient, ...queries: Array<new () => RESTQuery>): () => void {
    const { unsub } = withContexts([[QueryClientContext, client]], () =>
      createTestWatcher(() => queries.map(Q => fetchQuery(Q as any).value)),
    );
    unsubs.push(unsub);
    return unsub;
  }

  async function loadThenDeactivate(client: QueryClient, ...queries: Array<new () => RESTQuery>): Promise<void> {
    const unsub = watch(client, ...queries);
    await vi.advanceTimersByTimeAsync(50);
    unsub();
    await vi.advanceTimersByTimeAsync(10);
  }

  function offsets(): number[] {
    return starts.map(s => s.at - starts[0].at);
  }

  // Timer 0 counts as 1 ms on the fake clock.
  function expectOffsets(expected: number[]): void {
    const actual = offsets();
    expect(actual).toHaveLength(expected.length);
    actual.forEach((offset, i) => expect(Math.abs(offset - expected[i])).toBeLessThanOrEqual(1));
  }

  function fetchCount(path: string): number {
    return starts.filter(s => s.path === path).length;
  }

  describe('reactivationGraceMs', () => {
    it('refetches every stale query on reactivation by default', async () => {
      const client = makeClient();
      await loadThenDeactivate(client, GetA);
      expect(fetchCount('/a')).toBe(1);

      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('skips the refetch while the data is younger than the grace', async () => {
      const client = makeClient({ reactivationGraceMs: 15_000 });
      await loadThenDeactivate(client, GetA);
      expect(fetchCount('/a')).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000);
      const unsub = watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);
      expect(client.queryInstances.size).toBe(1);
      unsub();
      await vi.advanceTimersByTimeAsync(10);

      await vi.advanceTimersByTimeAsync(10_000);
      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('keeps serving the cached value during the grace', async () => {
      const client = makeClient({ reactivationGraceMs: 15_000 });
      await loadThenDeactivate(client, GetA);

      const values: unknown[] = [];
      const { unsub } = withContexts([[QueryClientContext, client]], () =>
        createTestWatcher(() => {
          const relay = fetchQuery(GetA);
          values.push({ pending: relay.isPending, n: relay.value?.n });
        }),
      );
      unsubs.push(unsub);
      await vi.advanceTimersByTimeAsync(50);
      expect(values.at(-1)).toEqual({ pending: false, n: 1 });
    });

    it('lets a query override the client grace', async () => {
      class GetNoGrace extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { reactivationGraceMs: 0 };
      }
      class GetLongGrace extends RESTQuery {
        path = '/b';
        result = { n: t.number };
        config = { reactivationGraceMs: 60_000 };
      }

      const client = makeClient({ reactivationGraceMs: 15_000 });
      await loadThenDeactivate(client, GetNoGrace, GetLongGrace);
      await vi.advanceTimersByTimeAsync(20_000);

      watch(client, GetNoGrace, GetLongGrace);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
      expect(fetchCount('/b')).toBe(1);
    });

    it('does not apply while the query is within its staleTime anyway', async () => {
      class GetFresh extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { staleTime: 60_000 };
      }
      const client = makeClient({ reactivationGraceMs: 1_000 });
      await loadThenDeactivate(client, GetFresh);
      await vi.advanceTimersByTimeAsync(5_000);

      watch(client, GetFresh);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);
    });

    it('still refetches a query invalidated while inactive', async () => {
      const client = makeClient({ reactivationGraceMs: 15_000 });
      await loadThenDeactivate(client, GetA);

      client.invalidateQueries([GetA]);
      await vi.advanceTimersByTimeAsync(10);
      expect(fetchCount('/a')).toBe(1);

      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('still refetches immediately on invalidation and refetch() while active', async () => {
      const client = makeClient({ reactivationGraceMs: 15_000 });
      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);

      client.invalidateQueries([GetA]);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);

      await withContexts([[QueryClientContext, client]], async () => {
        const relay = fetchQuery(GetA);
        await (relay.value as any).__refetch();
      });
      expect(fetchCount('/a')).toBe(3);
    });

    it('refetches when the last fetch failed, even inside the grace', async () => {
      mockFetch.reset();
      mockFetch.get('/a', { n: 1 });
      mockFetch.get('/a', { n: 2 }, { error: new Error('network down') });
      mockFetch.get('/a', { n: 3 });

      const client = makeClient({ reactivationGraceMs: 15_000 });
      const unsub = watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);

      // updatedAt still dates from the first, successful fetch.
      await withContexts([[QueryClientContext, client]], async () => {
        const relay = fetchQuery(GetA);
        await (relay.value as any).__refetch().catch(() => {});
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
      unsub();
      await vi.advanceTimersByTimeAsync(10);

      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(3);
    });

    it('refetches when the last fetch failed, even if an older replaced fetch succeeded later', async () => {
      class GetNoRetry extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { retry: false };
      }
      mockFetch.reset();
      mockFetch.get('/a', { n: 1 });
      mockFetch.get('/a', { n: 2 }, { delay: 1_000 });
      mockFetch.get('/a', { n: 3 }, { error: new Error('network down') });
      mockFetch.get('/a', { n: 4 });

      const client = makeClient({ reactivationGraceMs: 15_000 });
      let relay: any;
      const watchRelay = () => {
        const { unsub } = withContexts([[QueryClientContext, client]], () =>
          createTestWatcher(() => (relay = fetchQuery(GetNoRetry)).value),
        );
        unsubs.push(unsub);
        return unsub;
      };

      let unsub = watchRelay();
      await vi.advanceTimersByTimeAsync(50);

      // The mock lets this finish even after it is aborted.
      void relay.value.__refetch().catch(() => {});
      await vi.advanceTimersByTimeAsync(10);

      unsub();
      await vi.advanceTimersByTimeAsync(10);
      unsub = watchRelay();
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(3);
      expect(relay.isRejected).toBe(true);

      await vi.advanceTimersByTimeAsync(1_500);

      unsub();
      await vi.advanceTimersByTimeAsync(10);
      watchRelay();
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(4);
      expect(relay.isRejected).toBe(false);
    });

    it('measures from the last push when a subscription delivered data', async () => {
      let push: (() => void) | undefined;
      class GetStreamed extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = {
          subscribe: (onEvent: (event: MutationEvent) => void) => {
            push = () => onEvent({ type: 'update', typename: 'Unrelated', data: { id: '1' } });
            return () => {
              push = undefined;
            };
          },
        };
      }

      const client = makeClient({ reactivationGraceMs: 15_000 });
      const unsub = watch(client, GetStreamed);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);

      // Data is a minute old, but the stream pushed a moment ago.
      await vi.advanceTimersByTimeAsync(60_000);
      push!();
      await vi.advanceTimersByTimeAsync(1_000);
      unsub();
      await vi.advanceTimersByTimeAsync(5_000);

      const unsub2 = watch(client, GetStreamed);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);

      await vi.advanceTimersByTimeAsync(20_000);
      unsub2();
      await vi.advanceTimersByTimeAsync(10);
      watch(client, GetStreamed);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('does not count a subscription that never delivered as keeping the data current', async () => {
      class GetQuiet extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { subscribe: () => () => {} };
      }

      const client = makeClient({ reactivationGraceMs: 15_000 });
      const unsub = watch(client, GetQuiet);
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(60_000);
      unsub();
      await vi.advanceTimersByTimeAsync(5_000);

      watch(client, GetQuiet);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('does not let a poll() that has not ticked chain the grace across short visits', async () => {
      class GetPolled extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { subscribe: poll({ interval: 60_000 }) };
      }

      const client = makeClient({ reactivationGraceMs: 10_000 });
      let unsub = watch(client, GetPolled);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);

      // Each visit restarts the poll interval, so it never ticks.
      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(50_000);
        unsub();
        await vi.advanceTimersByTimeAsync(5_000);
        unsub = watch(client, GetPolled);
        await vi.advanceTimersByTimeAsync(10);
      }

      const lastFetch = starts.filter(s => s.path === '/a').at(-1)!.at;
      expect(Date.now() - lastFetch).toBeLessThan(60_000);
      expect(fetchCount('/a')).toBe(21);
    });

    it('credits a poll() only through its fetches, not while it was stopped in the background', async () => {
      let active = true;
      const listeners = new Set<() => void>();
      const activity: ActivitySource = {
        isActive: () => active,
        subscribe: listener => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
      const setActive = (value: boolean): void => {
        active = value;
        for (const listener of listeners) listener();
      };
      class GetPolled extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { subscribe: poll({ interval: 10_000 }) };
      }

      const client = makeClient({ reactivationGraceMs: 15_000, activity });
      const unsub = watch(client, GetPolled);
      await vi.advanceTimersByTimeAsync(35_000);
      expect(fetchCount('/a')).toBe(4);

      setActive(false);
      await vi.advanceTimersByTimeAsync(60_000);
      unsub();
      await vi.advanceTimersByTimeAsync(10);
      setActive(true);

      // Deactivated 10 ms ago, but the last tick was 65 s ago.
      watch(client, GetPolled);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(5);
    });

    it('measures from the last event a topic adapter sent with the topic', async () => {
      class PushingTopicAdapter extends TopicQueryAdapter {
        sends = 0;
        subscribe(topic: string): void {
          setTimeout(() => this.fulfillTopic(topic, { n: 1 }), 10);
        }
        unsubscribe(topic: string): void {
          this.clearTopic(topic);
        }
        override send(ctx: Query, signal: AbortSignal): Promise<unknown> {
          this.sends++;
          return super.send(ctx, signal);
        }
        push(topic: string | undefined): void {
          this.sendMutationEvent({ type: 'update', typename: 'Unrelated', data: { id: '1' } }, topic);
        }
      }
      class GetTopic extends TopicQuery {
        static override adapter = PushingTopicAdapter;
        topic = 'prices';
        result = { n: t.number };
      }

      const adapter = new PushingTopicAdapter();
      const client = makeClient({ reactivationGraceMs: 15_000, adapters: [adapter] });
      const visit = async (pushTopic: string | undefined): Promise<void> => {
        const unsub = watch(client, GetTopic as any);
        await vi.advanceTimersByTimeAsync(60_000);
        adapter.push(pushTopic);
        await vi.advanceTimersByTimeAsync(1_000);
        unsub();
        await vi.advanceTimersByTimeAsync(5_000);
      };

      await visit('prices');
      expect(adapter.sends).toBe(1);

      await visit(undefined);
      expect(adapter.sends).toBe(1);

      // The last event didn't name the topic, so the last push was 67 s ago.
      watch(client, GetTopic as any);
      await vi.advanceTimersByTimeAsync(50);
      expect(adapter.sends).toBe(2);
    });

    it('measures from the fetch for a query without a subscription', async () => {
      const client = makeClient({ reactivationGraceMs: 15_000 });
      const unsub = watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);

      await vi.advanceTimersByTimeAsync(60_000);
      unsub();
      await vi.advanceTimersByTimeAsync(5_000);

      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('still refetches a subscribed query invalidated while inactive', async () => {
      class GetStreamed extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { subscribe: () => () => {} };
      }

      const client = makeClient({ reactivationGraceMs: 15_000 });
      await loadThenDeactivate(client, GetStreamed);
      client.invalidateQueries([GetStreamed]);

      watch(client, GetStreamed);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('does not apply to a network reconnect', async () => {
      const networkManager = new NetworkManager(true);
      const client = makeClient({ reactivationGraceMs: 15_000, networkManager });
      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);

      networkManager.setNetworkStatus(false);
      await vi.advanceTimersByTimeAsync(50);
      networkManager.setNetworkStatus(true);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('does not apply after a network reconnect while the query was inactive', async () => {
      const networkManager = new NetworkManager(true);
      const client = makeClient({ reactivationGraceMs: 15_000, networkManager });
      await loadThenDeactivate(client, GetA);
      expect(fetchCount('/a')).toBe(1);

      networkManager.setNetworkStatus(false);
      await vi.advanceTimersByTimeAsync(50);
      networkManager.setNetworkStatus(true);
      await vi.advanceTimersByTimeAsync(50);

      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
    });

    it('does not apply when a Signal param changed while the query was inactive', async () => {
      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = { name: t.string };
      }
      mockFetch.get('/users/1', { name: 'User 1' });
      mockFetch.get('/users/2', { name: 'User 2' });
      const client = makeClient({ reactivationGraceMs: 15_000 });
      const id = signal('1');

      let name: string | undefined;
      const visit = () => {
        const { unsub } = withContexts([[QueryClientContext, client]], () =>
          createTestWatcher(() => (name = fetchQuery(GetUser, { id }).value?.name)),
        );
        unsubs.push(unsub);
        return unsub;
      };

      const unsub = visit();
      await vi.advanceTimersByTimeAsync(50);
      expect(name).toBe('User 1');
      unsub();
      await vi.advanceTimersByTimeAsync(10);

      id.value = '2';
      visit();
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/users/2')).toBe(1);
      expect(name).toBe('User 2');
    });
  });

  describe('reactivationStaggerMs', () => {
    it('starts reactivation refetches together by default', async () => {
      const client = makeClient();
      await loadThenDeactivate(client, GetA, GetB, GetC);
      starts.length = 0;

      watch(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(400);
      expect(offsets()).toEqual([0, 0, 0]);
    });

    it('spreads refetches that reactivate in the same task across the window, in order', async () => {
      const client = makeClient({ reactivationStaggerMs: 300 });
      await loadThenDeactivate(client, GetA, GetB, GetC);
      starts.length = 0;

      const t0 = Date.now();
      watch(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(400);
      expect(starts.map(s => s.path)).toEqual(['/a', '/b', '/c']);
      expectOffsets([0, 100, 200]);
      expect(starts[0].at - t0).toBeLessThanOrEqual(2);
    });

    it('starts a lone reactivation refetch without delay', async () => {
      const client = makeClient({ reactivationStaggerMs: 300 });
      await loadThenDeactivate(client, GetA);
      starts.length = 0;

      const t0 = Date.now();
      watch(client, GetA);
      await vi.advanceTimersByTimeAsync(400);
      expect(starts).toHaveLength(1);
      expect(starts[0].at - t0).toBeLessThanOrEqual(2);
    });

    it('drops a queued refetch whose query deactivated before the flush', async () => {
      const client = makeClient({ reactivationStaggerMs: 300 });
      await loadThenDeactivate(client, GetA, GetB);
      starts.length = 0;

      watch(client, GetA);
      const unsubB = watch(client, GetB);
      unsubB();
      await vi.advanceTimersByTimeAsync(400);
      expect(starts.map(s => s.path)).toEqual(['/a']);
    });

    it('cancels the delayed refetch when the query deactivates', async () => {
      const client = makeClient({ reactivationStaggerMs: 300 });
      await loadThenDeactivate(client, GetA, GetB);
      starts.length = 0;

      const unsub = watch(client, GetA, GetB);
      await vi.advanceTimersByTimeAsync(20);
      expect(starts.map(s => s.path)).toEqual(['/a']);
      unsub();
      await vi.advanceTimersByTimeAsync(400);
      expect(starts.map(s => s.path)).toEqual(['/a']);
    });

    it('combines with the grace: only queries past it are staggered', async () => {
      const client = makeClient({ reactivationStaggerMs: 300, reactivationGraceMs: 15_000 });
      await loadThenDeactivate(client, GetA, GetB);
      await vi.advanceTimersByTimeAsync(20_000);
      await loadThenDeactivate(client, GetC);
      starts.length = 0;

      watch(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(400);
      expect(starts.map(s => s.path)).toEqual(['/a', '/b']);
      expectOffsets([0, 150]);
    });

    it('starts queries of an adapter that coalesces requests together, and spreads the rest', async () => {
      class CoalescingAdapter extends RESTQueryAdapter {
        override readonly coalescesRequests = true;
      }
      class GetCoalescedA extends RESTQuery {
        static override adapter = CoalescingAdapter;
        path = '/a';
        result = { n: t.number };
      }
      class GetCoalescedB extends RESTQuery {
        static override adapter = CoalescingAdapter;
        path = '/b';
        result = { n: t.number };
      }

      const fetchFn = ((url: string, options?: RequestInit) => {
        starts.push({ path: new URL(url).pathname, at: Date.now() });
        return mockFetch(url, options);
      }) as typeof fetch;
      const client = makeClient({
        adapters: [
          new RESTQueryAdapter({ baseUrl: 'http://localhost', fetch: fetchFn }),
          new CoalescingAdapter({ baseUrl: 'http://localhost', fetch: fetchFn }),
        ],
        reactivationStaggerMs: 300,
      });
      await loadThenDeactivate(client, GetCoalescedA, GetC, GetCoalescedB);
      starts.length = 0;

      watch(client, GetCoalescedA, GetC, GetCoalescedB);
      await vi.advanceTimersByTimeAsync(400);
      // A lone spread query starts with the flush too.
      expect(starts.map(s => s.path).sort()).toEqual(['/a', '/b', '/c']);
      expectOffsets([0, 0, 0]);
    });

    it('spreads only the queries of adapters that do not coalesce', async () => {
      class CoalescingAdapter extends RESTQueryAdapter {
        override readonly coalescesRequests = true;
      }
      class GetCoalesced extends RESTQuery {
        static override adapter = CoalescingAdapter;
        path = '/a';
        result = { n: t.number };
      }

      const fetchFn = ((url: string, options?: RequestInit) => {
        starts.push({ path: new URL(url).pathname, at: Date.now() });
        return mockFetch(url, options);
      }) as typeof fetch;
      const client = makeClient({
        adapters: [
          new RESTQueryAdapter({ baseUrl: 'http://localhost', fetch: fetchFn }),
          new CoalescingAdapter({ baseUrl: 'http://localhost', fetch: fetchFn }),
        ],
        reactivationStaggerMs: 300,
      });
      await loadThenDeactivate(client, GetB, GetCoalesced, GetC);
      starts.length = 0;

      watch(client, GetB, GetCoalesced, GetC);
      await vi.advanceTimersByTimeAsync(400);
      expect(starts.map(s => s.path)).toEqual(['/a', '/b', '/c']);
      expectOffsets([0, 0, 150]);
    });

    it('skips a staggered refetch when refetch() started one during the window', async () => {
      mockFetch.reset();
      for (const path of ['/a', '/b', '/c']) {
        mockFetch.get(path, () => ({ n: ++counter }), { delay: 200 });
      }
      const client = makeClient({ reactivationStaggerMs: 3_000 });
      await loadThenDeactivate(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(300);
      starts.length = 0;

      watch(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(100);
      // /c's slot is 2 s out.
      await withContexts([[QueryClientContext, client]], async () => {
        void (fetchQuery(GetC).value as any).__refetch();
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/c')).toBe(1);

      await vi.advanceTimersByTimeAsync(2_500);
      expect(fetchCount('/c')).toBe(1);
      expect(fetchCount('/a')).toBe(1);
      expect(fetchCount('/b')).toBe(1);
    });

    it('skips a staggered refetch when __fetchNext() loaded a page during the window', async () => {
      class Item extends Entity {
        __typename = t.typename('Item');
        id = t.id;
      }
      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.liveArray(Item), nextCursor: t.optional(t.string) };
        fetchNext = { searchParams: { cursor: this.result.nextCursor } };
      }
      mockFetch.get('/items', { items: [{ __typename: 'Item', id: '1' }], nextCursor: 'c1' });
      mockFetch.get('/items', { items: [{ __typename: 'Item', id: '2' }] });
      mockFetch.get('/items', { items: [{ __typename: 'Item', id: '1' }], nextCursor: 'c1' });

      const client = makeClient({ reactivationStaggerMs: 3_000 });
      await loadThenDeactivate(client, GetA, GetB, GetItems);
      starts.length = 0;

      let value: any;
      const { unsub } = withContexts([[QueryClientContext, client]], () =>
        createTestWatcher(() => [fetchQuery(GetA).value, fetchQuery(GetB).value, (value = fetchQuery(GetItems).value)]),
      );
      unsubs.push(unsub);
      // /items' slot is 2 s out.
      await vi.advanceTimersByTimeAsync(100);
      await value.__fetchNext();
      expect(value.items.map((i: any) => i.id)).toEqual(['1', '2']);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchCount('/items')).toBe(1);
      expect(value.items.map((i: any) => i.id)).toEqual(['1', '2']);
    });

    it('does not abort a fetch still in flight when its stagger slot comes up', async () => {
      mockFetch.reset();
      mockFetch.get('/a', () => ({ n: ++counter }));
      mockFetch.get('/b', () => ({ n: ++counter }));
      mockFetch.get('/c', () => ({ n: ++counter }));
      mockFetch.get('/c', () => ({ n: ++counter }), { delay: 5_000 });
      const client = makeClient({ reactivationStaggerMs: 3_000 });
      await loadThenDeactivate(client, GetA, GetB, GetC);
      starts.length = 0;

      watch(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(100);
      let settled: 'resolved' | 'rejected' | undefined;
      await withContexts([[QueryClientContext, client]], async () => {
        (fetchQuery(GetC).value as any).__refetch().then(
          () => (settled = 'resolved'),
          () => (settled = 'rejected'),
        );
      });

      await vi.advanceTimersByTimeAsync(2_500);
      expect(fetchCount('/c')).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe('resolved');
      expect(fetchCount('/c')).toBe(1);
    });

    it('does not delay an invalidation made before the stagger queue flushes', async () => {
      const client = makeClient({ reactivationStaggerMs: 3_000 });
      await loadThenDeactivate(client, GetA, GetB);
      starts.length = 0;

      let invalidated = false;
      const { unsub } = withContexts([[QueryClientContext, client]], () =>
        createTestWatcher(() => {
          // A microtask lands after reactivation queues both refetches, before the queue flushes.
          if (!invalidated) queueMicrotask(() => client.invalidateQueries([GetB]));
          invalidated = true;
          return [fetchQuery(GetA).value, fetchQuery(GetB).value];
        }),
      );
      unsubs.push(unsub);
      await vi.advanceTimersByTimeAsync(50);
      expect(starts.map(s => s.path).sort()).toEqual(['/a', '/b']);

      await vi.advanceTimersByTimeAsync(3_000);
      expect(fetchCount('/b')).toBe(1);
    });

    it('does not delay an initial fetch', async () => {
      const client = makeClient({ reactivationStaggerMs: 300 });
      watch(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(50);
      expect(offsets()).toEqual([0, 0, 0]);
    });
  });
});
