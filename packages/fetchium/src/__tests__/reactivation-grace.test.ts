import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withContexts } from 'signalium';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { t } from '../typeDefs.js';
import { QueryClient, QueryClientContext, type QueryClientConfig } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { NetworkManager } from '../NetworkManager.js';
import { createMockFetch, createTestWatcher } from './utils.js';

/**
 * Reactivation grace and stagger: a query whose relay resumes (its watchers
 * return, or a paused scope resumes) skips the refetch while its data is
 * younger than `reactivationGraceMs`, and reactivation refetches that start
 * together are spread across `reactivationStaggerMs`.
 */

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
    // Drain signalium's pending flush on the fake clock; a flush left scheduled
    // there would block every later flush once real timers are restored.
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

  /** Activates a watcher over the given queries' values; returns its unsubscribe. */
  function watch(client: QueryClient, ...queries: Array<new () => RESTQuery>): () => void {
    const { unsub } = withContexts([[QueryClientContext, client]], () =>
      createTestWatcher(() => queries.map(Q => fetchQuery(Q as any).value)),
    );
    unsubs.push(unsub);
    return unsub;
  }

  /** Activates, loads, then deactivates (as a pause would). */
  async function loadThenDeactivate(client: QueryClient, ...queries: Array<new () => RESTQuery>): Promise<void> {
    const unsub = watch(client, ...queries);
    await vi.advanceTimersByTimeAsync(50);
    unsub();
    await vi.advanceTimersByTimeAsync(10);
  }

  /** Fetch start times relative to the first one. */
  function offsets(): number[] {
    return starts.map(s => s.at - starts[0].at);
  }

  /** Timer 0 counts as 1 ms on the fake clock, so allow a millisecond either way. */
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

      // Past the grace (and the default staleTime of 0): refetches.
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

      // A refetch fails; updatedAt still dates from the first, successful fetch.
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

    it('measures from deactivation when a subscription kept the data current', async () => {
      // A subscription that never fires: stands in for a stream that delivered
      // entity updates while the query was active.
      class GetStreamed extends RESTQuery {
        path = '/a';
        result = { n: t.number };
        config = { subscribe: () => () => {} };
      }

      const client = makeClient({ reactivationGraceMs: 15_000 });
      const unsub = watch(client, GetStreamed);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);

      // Data is a minute old, but the subscription ran until a moment ago.
      await vi.advanceTimersByTimeAsync(60_000);
      unsub();
      await vi.advanceTimersByTimeAsync(5_000);

      const unsub2 = watch(client, GetStreamed);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(1);
      unsub2();
      await vi.advanceTimersByTimeAsync(10);

      // Deactivated longer than the grace: refetches.
      await vi.advanceTimersByTimeAsync(20_000);
      watch(client, GetStreamed);
      await vi.advanceTimersByTimeAsync(50);
      expect(fetchCount('/a')).toBe(2);
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
      // The first one waits only for the flush task.
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
      // One spread query: it starts with the flush too.
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
      // The coalesced query starts with the flush; the other two take the two slots.
      expect(starts.map(s => s.path)).toEqual(['/a', '/b', '/c']);
      expectOffsets([0, 0, 150]);
    });

    it('does not delay an initial fetch', async () => {
      const client = makeClient({ reactivationStaggerMs: 300 });
      watch(client, GetA, GetB, GetC);
      await vi.advanceTimersByTimeAsync(50);
      expect(offsets()).toEqual([0, 0, 0]);
    });
  });
});
