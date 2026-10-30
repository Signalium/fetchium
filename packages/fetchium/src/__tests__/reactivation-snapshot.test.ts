import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, withContexts } from 'signalium';
import { QueryClient, QueryClientContext, type QueryClientConfig } from '../QueryClient.js';
import { fetchQuery, type Query } from '../query.js';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { NetworkManager } from '../NetworkManager.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { t } from '../typeDefs.js';
import { createMockFetch, createTestWatcher } from './utils.js';

class SnapshotAdapter extends RESTQueryAdapter {
  snapshot = vi.fn<(ctx: Query) => { data: unknown } | undefined>(() => undefined);

  override getCurrentSnapshot(ctx: Query): { data: unknown } | undefined {
    return this.snapshot(ctx);
  }
}

class GetA extends RESTQuery {
  static override adapter = SnapshotAdapter;
  path = '/a';
  result = { n: t.number };
}

class GetB extends GetA {
  path = '/b';
}

class GetDebounced extends GetA {
  config = { debounce: 100 };
}

class GetUser extends GetA {
  params = { id: t.id };
  path = `/users/${this.params.id}`;
}

describe('adapter snapshots on consumer reactivation', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let adapter: SnapshotAdapter;
  let clients: QueryClient[];
  let unsubs: Array<() => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    clients = [];
    unsubs = [];
    mockFetch = createMockFetch();
    for (const path of ['/a', '/b', '/users/1', '/users/2']) {
      mockFetch.get(path, { n: 1 });
    }
    adapter = new SnapshotAdapter({ baseUrl: 'http://localhost', fetch: mockFetch as typeof fetch });
    adapter.snapshot.mockReturnValue({ data: { n: 42 } });
  });

  afterEach(async () => {
    for (const unsub of unsubs) unsub();
    for (const client of clients) client.destroy();
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();
  });

  function makeClient(config: Partial<QueryClientConfig> = {}): QueryClient {
    const client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [adapter],
      ...config,
    });
    clients.push(client);
    return client;
  }

  function watch(client: QueryClient, ...queries: Array<new () => GetA>) {
    const result = withContexts([[QueryClientContext, client]], () =>
      createTestWatcher(() => queries.map(Q => fetchQuery(Q).value?.n)),
    );
    unsubs.push(result.unsub);
    return result;
  }

  async function loadThenDeactivate(client: QueryClient, ...queries: Array<new () => GetA>): Promise<void> {
    const { unsub } = watch(client, ...queries);
    await vi.advanceTimersByTimeAsync(50);
    unsub();
    await vi.advanceTimersByTimeAsync(10);
    expect(mockFetch.calls).toHaveLength(queries.length);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  }

  it('reuses and caches the snapshot', async () => {
    class GetCached extends GetA {
      config = { staleTime: 1_000 };
    }
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const client = makeClient({ store });
    await loadThenDeactivate(client, GetCached);
    await vi.advanceTimersByTimeAsync(2_000);
    const save = vi.spyOn(client, 'saveQueryData');
    const snapshotData = Object.freeze({ n: 42 });
    adapter.snapshot.mockReturnValue({ data: snapshotData });

    const resumedAt = Date.now();
    const { values, unsub } = watch(client, GetCached);
    await vi.advanceTimersByTimeAsync(50);
    expect(values.at(-1)).toEqual([42]);
    expect(mockFetch.calls).toHaveLength(1);
    expect(adapter.snapshot).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][3]).toBeGreaterThanOrEqual(resumedAt);
    expect(snapshotData).toEqual({ n: 42 });

    unsub();
    client.destroy();
    const restored = makeClient({ store });
    const cached = watch(restored, GetCached);
    await vi.advanceTimersByTimeAsync(50);
    expect(cached.values.at(-1)).toEqual([42]);
    expect(mockFetch.calls).toHaveLength(1);
    expect(adapter.snapshot).toHaveBeenCalledOnce();
  });

  it.each(['no snapshot', 'retrieval throws', 'invalid data'] as const)('falls back to fetching: %s', async mode => {
    const client = makeClient();
    await loadThenDeactivate(client, GetA);
    if (mode === 'no snapshot') adapter.snapshot.mockReturnValue(undefined);
    if (mode === 'retrieval throws')
      adapter.snapshot.mockImplementation(() => {
        throw new Error('snapshot unavailable');
      });
    if (mode === 'invalid data') adapter.snapshot.mockReturnValue({ data: { n: 'not a number' } });
    mockFetch.get('/a', { n: 2 });

    const { values } = watch(client, GetA);
    await vi.advanceTimersByTimeAsync(50);
    expect(values.at(-1)).toEqual([2]);
    expect(mockFetch.calls).toHaveLength(2);
    expect(adapter.snapshot).toHaveBeenCalledOnce();
  });

  it('fetches when the adapter has no snapshot hook', async () => {
    class GetPlain extends RESTQuery {
      path = '/a';
      result = { n: t.number };
    }
    const client = makeClient({
      adapters: [new RESTQueryAdapter({ baseUrl: 'http://localhost', fetch: mockFetch as typeof fetch })],
    });
    await loadThenDeactivate(client, GetPlain);
    watch(client, GetPlain);
    await vi.advanceTimersByTimeAsync(50);
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('fetches on explicit refresh', async () => {
    const client = makeClient();
    watch(client, GetA);
    await vi.advanceTimersByTimeAsync(50);
    withContexts([[QueryClientContext, client]], () => {
      void fetchQuery(GetA).value?.__refetch();
    });
    await vi.advanceTimersByTimeAsync(50);
    expect(mockFetch.calls).toHaveLength(2);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  });

  it('fetches after invalidation while inactive', async () => {
    const client = makeClient();
    await loadThenDeactivate(client, GetA);
    client.invalidateQueries([GetA]);
    const { values } = watch(client, GetA);
    await vi.advanceTimersByTimeAsync(50);
    expect(values.at(-1)).toEqual([1]);
    expect(mockFetch.calls).toHaveLength(2);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  });

  it.each([0, 300])('invalidation overrides a queued resume (%i ms stagger)', async reactivationStaggerMs => {
    const client = makeClient({ reactivationStaggerMs });
    await loadThenDeactivate(client, GetA, GetB);
    watch(client, GetA, GetB);
    client.invalidateQueries([GetB]);
    await vi.advanceTimersByTimeAsync(500);
    expect(mockFetch.calls.filter(call => call.url.endsWith('/b'))).toHaveLength(2);
    expect(adapter.snapshot.mock.calls.every(([ctx]) => (ctx as RESTQuery).path !== '/b')).toBe(true);
  });

  it.each(['before', 'after'] as const)('fetches when invalidated %s debounce scheduling', async timing => {
    const client = makeClient();
    await loadThenDeactivate(client, GetDebounced);
    watch(client, GetDebounced);
    if (timing === 'after') await vi.advanceTimersByTimeAsync(20);
    client.invalidateQueries([GetDebounced]);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch.calls).toHaveLength(2);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  });

  it('reads the snapshot after the debounce delay', async () => {
    const client = makeClient();
    await loadThenDeactivate(client, GetDebounced);
    adapter.snapshot.mockReturnValue(undefined);
    const { values } = watch(client, GetDebounced);
    await vi.advanceTimersByTimeAsync(20);
    expect(adapter.snapshot).not.toHaveBeenCalled();
    adapter.snapshot.mockReturnValue({ data: { n: 99 } });
    await vi.advanceTimersByTimeAsync(150);
    expect(values.at(-1)).toEqual([99]);
    expect(mockFetch.calls).toHaveLength(1);
    expect(adapter.snapshot).toHaveBeenCalledOnce();
  });

  it('reads the snapshot when its stagger slot runs', async () => {
    const client = makeClient({ reactivationStaggerMs: 300 });
    await loadThenDeactivate(client, GetA, GetB);
    const { values } = watch(client, GetA, GetB);
    await vi.advanceTimersByTimeAsync(20);
    expect(adapter.snapshot).toHaveBeenCalledOnce();
    adapter.snapshot.mockReturnValue(undefined);
    mockFetch.get('/b', { n: 2 });
    await vi.advanceTimersByTimeAsync(400);
    expect(values.at(-1)).toEqual([42, 2]);
    expect(mockFetch.calls).toHaveLength(3);
    expect(adapter.snapshot).toHaveBeenCalledTimes(2);
  });

  it('skips a queued resume after an explicit refresh', async () => {
    const client = makeClient({ reactivationStaggerMs: 300 });
    await loadThenDeactivate(client, GetA, GetB);
    const { values } = watch(client, GetA, GetB);
    await vi.advanceTimersByTimeAsync(20);
    withContexts([[QueryClientContext, client]], () => {
      void fetchQuery(GetB).value?.__refetch();
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(values.at(-1)).toEqual([42, 1]);
    expect(mockFetch.calls).toHaveLength(3);
    expect(adapter.snapshot).toHaveBeenCalledOnce();
  });

  it('cancels snapshot reuse on deactivation', async () => {
    const client = makeClient();
    await loadThenDeactivate(client, GetDebounced);
    const { unsub } = watch(client, GetDebounced);
    await vi.advanceTimersByTimeAsync(20);
    unsub();
    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch.calls).toHaveLength(1);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  });

  it.each(['active', 'inactive', 'resume queued'] as const)('fetches after reconnect (%s)', async timing => {
    const networkManager = new NetworkManager(true);
    const client = makeClient({ networkManager });
    const QueryClass = timing === 'resume queued' ? GetDebounced : GetA;
    const initial = watch(client, QueryClass);
    await vi.advanceTimersByTimeAsync(50);
    if (timing !== 'active') {
      initial.unsub();
      await vi.advanceTimersByTimeAsync(10);
    }
    if (timing === 'resume queued') {
      watch(client, QueryClass);
      await vi.advanceTimersByTimeAsync(20);
    }
    networkManager.setNetworkStatus(false);
    await vi.advanceTimersByTimeAsync(20);
    networkManager.setNetworkStatus(true);
    await vi.advanceTimersByTimeAsync(20);
    if (timing === 'inactive') watch(client, QueryClass);
    await vi.advanceTimersByTimeAsync(200);
    expect(mockFetch.calls).toHaveLength(2);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  });

  it.each(['inactive', 'resume queued'] as const)('fetches when parameters change (%s)', async timing => {
    const client = makeClient({ reactivationStaggerMs: timing === 'resume queued' ? 300 : 0 });
    const id = signal('1');
    const visit = () => {
      const result = withContexts([[QueryClientContext, client]], () =>
        createTestWatcher(() => [fetchQuery(GetA).value?.n, fetchQuery(GetUser, { id }).value?.n]),
      );
      unsubs.push(result.unsub);
      return result;
    };
    const initial = visit();
    await vi.advanceTimersByTimeAsync(50);
    initial.unsub();
    await vi.advanceTimersByTimeAsync(10);
    if (timing === 'inactive') id.value = '2';
    visit();
    if (timing === 'resume queued') {
      await vi.advanceTimersByTimeAsync(20);
      id.value = '2';
    }
    await vi.advanceTimersByTimeAsync(400);
    expect(mockFetch.calls.filter(call => call.url.endsWith('/users/2'))).toHaveLength(1);
    expect(adapter.snapshot.mock.calls.every(([ctx]) => (ctx as RESTQuery).path === '/a')).toBe(true);
  });

  it.each(['debounce', 'stagger'] as const)(
    'fetches on remount if the reconnect refresh was canceled (%s)',
    async mode => {
      const client = makeClient({
        networkManager: new NetworkManager(true),
        reactivationStaggerMs: mode === 'stagger' ? 300 : 0,
      });
      const queries = mode === 'stagger' ? [GetA, GetB] : [GetDebounced];
      const path = mode === 'stagger' ? '/b' : '/a';
      const initial = watch(client, ...queries);
      await vi.advanceTimersByTimeAsync(50);

      client.networkManager.setNetworkStatus(false);
      await vi.advanceTimersByTimeAsync(20);
      client.networkManager.setNetworkStatus(true);
      await vi.advanceTimersByTimeAsync(20);
      expect(mockFetch.calls.filter(call => call.url.endsWith(path))).toHaveLength(1);
      initial.unsub();
      await vi.advanceTimersByTimeAsync(10);

      const resumed = watch(client, ...queries);
      await vi.advanceTimersByTimeAsync(400);
      expect(mockFetch.calls.filter(call => call.url.endsWith(path))).toHaveLength(2);
      expect(adapter.snapshot.mock.calls.every(([ctx]) => (ctx as RESTQuery).path !== path)).toBe(true);

      resumed.unsub();
      await vi.advanceTimersByTimeAsync(10);
      watch(client, ...queries);
      await vi.advanceTimersByTimeAsync(400);
      expect(mockFetch.calls.filter(call => call.url.endsWith(path))).toHaveLength(2);
      expect(adapter.snapshot.mock.calls.some(([ctx]) => (ctx as RESTQuery).path === path)).toBe(true);
    },
  );

  it('fetches after a failed load', async () => {
    const client = makeClient();
    const initial = watch(client, GetA);
    await vi.advanceTimersByTimeAsync(50);
    mockFetch.get('/a', {}, { error: new Error('load failed') });
    withContexts([[QueryClientContext, client]], () => {
      void fetchQuery(GetA)
        .value?.__refetch()
        .catch(() => {});
    });
    await vi.advanceTimersByTimeAsync(50);
    initial.unsub();
    await vi.advanceTimersByTimeAsync(10);
    mockFetch.get('/a', { n: 3 });
    const { values } = watch(client, GetA);
    await vi.advanceTimersByTimeAsync(50);
    expect(values.at(-1)).toEqual([3]);
    expect(mockFetch.calls).toHaveLength(3);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  });

  it.each([0, 300])('fetches after an aborted load (%i ms stagger)', async reactivationStaggerMs => {
    const client = makeClient({ reactivationStaggerMs });
    const initial = watch(client, GetA);
    await vi.advanceTimersByTimeAsync(50);
    mockFetch.get('/a', { n: 2 }, { delay: 1_000 });
    withContexts([[QueryClientContext, client]], () => {
      void fetchQuery(GetA)
        .value?.__refetch()
        .catch(() => {});
    });
    await vi.advanceTimersByTimeAsync(20);
    initial.unsub();
    await vi.advanceTimersByTimeAsync(10);
    mockFetch.get('/a', { n: 3 });
    const { values } = watch(client, GetA);
    await vi.advanceTimersByTimeAsync(500);
    expect(values.at(-1)).toEqual([3]);
    expect(mockFetch.calls).toHaveLength(3);
    expect(adapter.snapshot).not.toHaveBeenCalled();
  });
});
