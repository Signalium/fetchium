/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, it, expect } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext, type CachedQuery } from '../QueryClient.js';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { t } from '../typeDefs.js';
import { fetchQuery } from '../query.js';
import { QueryDefinition } from '../query.js';
import { createMockFetch, sleep, testWithClient } from './utils.js';

// With a sync store, the activating read sees cached data and the fetch starts on a microtask.

/** loadQuery resolves on a later microtask, like an async store. */
class AsyncLoadingQueryStore extends SyncQueryStore {
  override loadQuery(queryDef: QueryDefinition<any, any, any>, queryKey: number): CachedQuery | undefined {
    return Promise.resolve(super.loadQuery(queryDef, queryKey)) as unknown as CachedQuery | undefined;
  }
}

async function flushMicrotasks(count = 20): Promise<void> {
  for (let i = 0; i < count; i++) {
    await Promise.resolve();
  }
}

function makeClient(store: SyncQueryStore, mockFetch: ReturnType<typeof createMockFetch>): QueryClient {
  return new QueryClient({
    store,
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
  });
}

async function seedCache(kv: MemoryPersistentStore, QueryClass: new () => RESTQuery, response: unknown) {
  const mockFetch = createMockFetch();
  mockFetch.get('/item', response);
  const client = makeClient(new SyncQueryStore(kv), mockFetch);
  await testWithClient(client, async () => {
    await fetchQuery(QueryClass as any);
  });
  client.destroy();
}

/** Activates `read` in a watched context, as React render does, and returns its first result. */
function activate<T>(client: QueryClient, read: () => T): { first: T; dispose: () => void } {
  let first: T | undefined;
  let captured = false;
  const w = withContexts([[QueryClientContext, client]], () =>
    watcher(() => {
      const value = read();
      if (!captured) {
        first = value;
        captured = true;
      }
    }),
  );
  const dispose = w.addListener(() => {});
  w.value;
  return { first: first as T, dispose };
}

describe('Activation with a synchronous store', () => {
  it('exposes fresh cached data in the activating read, without fetching', async () => {
    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      config = { staleTime: 60_000 };
    }

    const kv = new MemoryPersistentStore();
    await seedCache(kv, GetItem, { value: 'cached' });

    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' });
    const client = makeClient(new SyncQueryStore(kv), mockFetch);

    const { first, dispose } = activate(client, () => {
      const relay = fetchQuery(GetItem);
      return { isReady: relay.isReady, isPending: relay.isPending, value: relay.value?.value };
    });

    expect(first).toEqual({ isReady: true, isPending: false, value: 'cached' });

    await sleep(20);
    expect(mockFetch.calls).toHaveLength(0);

    dispose();
    client.destroy();
  });

  it('exposes stale cached data in the activating read, then refetches on a microtask', async () => {
    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      config = { staleTime: 0 };
    }

    const kv = new MemoryPersistentStore();
    await seedCache(kv, GetItem, { value: 'cached' });

    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' }, { delay: 20 });
    const client = makeClient(new SyncQueryStore(kv), mockFetch);

    let relayRef: ReturnType<typeof fetchQuery<GetItem>> | undefined;
    const { first, dispose } = activate(client, () => {
      const relay = (relayRef = fetchQuery(GetItem));
      return { isReady: relay.isReady, isPending: relay.isPending, value: relay.value?.value };
    });

    expect(first).toEqual({ isReady: true, isPending: false, value: 'cached' });

    // Never inside the activating read.
    expect(mockFetch.calls).toHaveLength(0);

    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);
    expect(relayRef!.isPending).toBe(true);
    expect(relayRef!.value!.value).toBe('cached');

    await relayRef;
    await sleep(0);
    expect(relayRef!.value!.value).toBe('fresh');

    dispose();
    client.destroy();
  });

  it('starts the first fetch on a microtask when nothing is cached', async () => {
    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
    }

    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' });
    const client = makeClient(new SyncQueryStore(new MemoryPersistentStore()), mockFetch);

    const { first, dispose } = activate(client, () => {
      const relay = fetchQuery(GetItem);
      return { isReady: relay.isReady, isPending: relay.isPending };
    });

    expect(first).toEqual({ isReady: false, isPending: true });
    expect(mockFetch.calls).toHaveLength(0);

    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);

    dispose();
    client.destroy();
  });
});

describe('Activation with an asynchronous store', () => {
  it('keeps the activating read pending, then hydrates from cache', async () => {
    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      config = { staleTime: 60_000 };
    }

    const kv = new MemoryPersistentStore();
    await seedCache(kv, GetItem, { value: 'cached' });

    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' });
    const client = makeClient(new AsyncLoadingQueryStore(kv), mockFetch);

    let relayRef: ReturnType<typeof fetchQuery<GetItem>> | undefined;
    const { first, dispose } = activate(client, () => {
      relayRef = fetchQuery(GetItem);
      return { isReady: relayRef.isReady, isPending: relayRef.isPending };
    });

    expect(first).toEqual({ isReady: false, isPending: true });

    await flushMicrotasks();
    expect(relayRef!.isReady).toBe(true);
    expect(relayRef!.value!.value).toBe('cached');

    await sleep(20);
    expect(mockFetch.calls).toHaveLength(0);

    dispose();
    client.destroy();
  });

  it('fetches after the cache miss resolves, without a timer hop', async () => {
    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
    }

    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' });
    const client = makeClient(new AsyncLoadingQueryStore(new MemoryPersistentStore()), mockFetch);

    let relayRef: ReturnType<typeof fetchQuery<GetItem>> | undefined;
    const { dispose } = activate(client, () => {
      relayRef = fetchQuery(GetItem);
      return relayRef.isPending;
    });

    expect(mockFetch.calls).toHaveLength(0);
    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);

    await relayRef;
    expect(relayRef!.value!.value).toBe('fresh');

    dispose();
    client.destroy();
  });
});

describe('Invalidation before the first fetch', () => {
  class GetForever extends RESTQuery {
    path = '/item';
    result = { value: t.string };
    config = { staleTime: Infinity };
  }

  it('fetches an uncached query invalidated before activation', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' });
    const client = makeClient(new SyncQueryStore(new MemoryPersistentStore()), mockFetch);

    const relay = withContexts([[QueryClientContext, client]], () => fetchQuery(GetForever));
    client.invalidateQueries([GetForever]);
    const { dispose } = activate(client, () => fetchQuery(GetForever).isPending);

    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);
    await relay;
    expect(relay.value!.value).toBe('fresh');

    dispose();
    client.destroy();
  });

  for (const [name, Store] of [
    ['sync', SyncQueryStore],
    ['async', AsyncLoadingQueryStore],
  ] as const) {
    it(`fetches an uncached query invalidated before the first fetch starts (${name} store)`, async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/item', { value: 'fresh' });
      const client = makeClient(new Store(new MemoryPersistentStore()), mockFetch);

      let relay: ReturnType<typeof fetchQuery<GetForever>> | undefined;
      const { dispose } = activate(client, () => (relay = fetchQuery(GetForever)).isPending);
      client.invalidateQueries([GetForever]);

      await flushMicrotasks();
      expect(mockFetch.calls).toHaveLength(1);
      await relay;
      expect(relay!.value!.value).toBe('fresh');

      dispose();
      client.destroy();
    });
  }

  it('fetches once when a stale cached query is invalidated right after synchronous hydration', async () => {
    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      config = { staleTime: 0 };
    }

    const kv = new MemoryPersistentStore();
    await seedCache(kv, GetItem, { value: 'cached' });

    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' }, { delay: 20 });
    const client = makeClient(new SyncQueryStore(kv), mockFetch);

    let relay: ReturnType<typeof fetchQuery<GetItem>> | undefined;
    const { dispose } = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    client.invalidateQueries([GetItem]);

    await flushMicrotasks();
    expect(relay!.isPending).toBe(true);
    await relay;
    await sleep(30);
    expect(mockFetch.calls).toHaveLength(1);
    expect(mockFetch.calls[0].options.signal!.aborted).toBe(false);
    expect(relay!.value!.value).toBe('fresh');

    dispose();
    client.destroy();
  });

  it('refetches a cached query invalidated before its cache loads', async () => {
    const kv = new MemoryPersistentStore();
    await seedCache(kv, GetForever, { value: 'cached' });

    const mockFetch = createMockFetch();
    mockFetch.get('/item', { value: 'fresh' });
    const client = makeClient(new AsyncLoadingQueryStore(kv), mockFetch);

    let relay: ReturnType<typeof fetchQuery<GetForever>> | undefined;
    const { dispose } = activate(client, () => (relay = fetchQuery(GetForever)).isPending);
    client.invalidateQueries([GetForever]);

    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);
    await sleep(0);
    expect(relay!.value!.value).toBe('fresh');

    dispose();
    client.destroy();
  });
});
