import { describe, it, expect, afterEach, vi } from 'vitest';
import { signal, watcher, withContexts } from 'signalium';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { valueKeyFor, updatedAtKeyFor } from '../stores/shared.js';
import { t } from '../typeDefs.js';
import { RESTQuery } from '../rest/index.js';
import { Entity } from '../proxy.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery, peekQuery, queryKeyForClass, Query } from '../query.js';
import { QueryClient, QueryClientContext, type QueryClientConfig, type QueryStore } from '../QueryClient.js';
import { GcManager } from '../GcManager.js';
import { createMockFetch, sleep } from './utils.js';

class GetItem extends RESTQuery {
  params = { id: t.string };
  path = `/peek-item/${this.params.id}`;
  result = { name: t.string };
}

class GetItemGc0 extends RESTQuery {
  params = { id: t.string };
  path = `/peek-gc0/${this.params.id}`;
  result = { name: t.string };
  config = { gcTime: 0 };
}

class GetFreshItem extends RESTQuery {
  params = { id: t.string };
  path = `/peek-fresh/${this.params.id}`;
  result = { name: t.string };
  config = { staleTime: 60_000 };
}

/** A sync store whose nth cache read resolves after `delays[n]` ms (the last entry repeats). */
function asyncReads(store: SyncQueryStore, delays: number[] = [10]): QueryStore {
  let reads = 0;
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'loadQuery') {
        // Reads now and resolves later, so a slow read returns the data as it was.
        return (...args: Parameters<SyncQueryStore['loadQuery']>) => {
          const cached = target.loadQuery(...args);
          return sleep(delays[Math.min(reads++, delays.length - 1)]).then(() => cached);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as QueryStore;
}

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.destroy();
});

/** A client on `kv` with a real GcManager (Node would otherwise get the no-op one). */
function makeClient(
  kv: MemoryPersistentStore,
  mockFetch: ReturnType<typeof createMockFetch>,
  config: Partial<QueryClientConfig> & { store?: QueryStore } = {},
): QueryClient {
  const client = new QueryClient({
    store: new SyncQueryStore(kv),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    ...config,
  });
  client.gcManager = new GcManager((client as any).handleEviction.bind(client), 0.001);
  clients.push(client);
  return client;
}

function activate(client: QueryClient, read: () => unknown): () => void {
  const w = withContexts([[QueryClientContext, client]], () => watcher(read));
  const dispose = w.addListener(() => {});
  void w.value;
  return dispose;
}

function inContext<R>(client: QueryClient, fn: () => R): R {
  return withContexts([[QueryClientContext, client]], fn);
}

/** Fetches through a throwaway client so `kv` holds the query's persisted cache. */
async function persist(
  kv: MemoryPersistentStore,
  mockFetch: ReturnType<typeof createMockFetch>,
  QueryClass: new () => Query,
  params: Record<string, unknown> | undefined,
): Promise<void> {
  const writer = makeClient(kv, mockFetch);
  const relay = inContext(writer, () => fetchQuery(QueryClass as any, params as any));
  const dispose = activate(writer, () => relay.value);
  await relay;
  dispose();
  writer.destroy();
}

describe('peekQuery', () => {
  it('resolves from an async persistent cache without fetching', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-item/1', { name: 'Cached' });
    await persist(kv, mockFetch, GetItem, { id: '1' });
    expect(mockFetch.calls).toHaveLength(1);

    const reader = makeClient(kv, mockFetch, { store: asyncReads(new SyncQueryStore(kv)) });
    const cached = inContext(reader, () => peekQuery(GetItem, { id: '1' }));
    const missing = inContext(reader, () => peekQuery(GetItem, { id: '2' }));
    activate(reader, () => cached.value);
    activate(reader, () => missing.value);

    // Pending while the cache read is in flight.
    expect(cached.isPending).toBe(true);
    expect((await cached).name).toBe('Cached');
    expect(cached.isResolved).toBe(true);

    await sleep(30);
    expect(missing.isPending).toBe(true);
    expect(missing.value).toBeUndefined();
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('stays pending, without fetching, when the persisted cache has expired', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-item/1', { name: 'Old' });
    await persist(kv, mockFetch, GetItem, { id: '1' });
    kv.setNumber(updatedAtKeyFor(queryKeyForClass(GetItem, { id: '1' })), 1);

    const reader = makeClient(kv, mockFetch);
    const relay = inContext(reader, () => peekQuery(GetItem, { id: '1' }));
    activate(reader, () => relay.value);
    await sleep(20);

    expect(relay.isPending).toBe(true);
    expect(relay.value).toBeUndefined();
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('discards a corrupt persisted cache and stays pending instead of throwing', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-item/1', { name: 'Item' });
    await persist(kv, mockFetch, GetItem, { id: '1' });
    const key = queryKeyForClass(GetItem, { id: '1' });
    kv.setString(valueKeyFor(key), '{not json');

    const warn = vi.fn();
    const reader = makeClient(kv, mockFetch, { log: { warn } });
    const relay = inContext(reader, () => peekQuery(GetItem, { id: '1' }));
    expect(() => activate(reader, () => relay.value)).not.toThrow();
    await sleep(20);

    expect(relay.isPending).toBe(true);
    expect(relay.isRejected).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cache may be corrupted'), expect.anything());
    expect(kv.getString(valueKeyFor(key))).toBeUndefined();
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('keeps the query from being collected while a disabled reader shows it', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-gc0/1', { name: 'Kept' });
    const client = makeClient(kv, mockFetch);
    const key = queryKeyForClass(GetItemGc0, { id: '1' });

    const fetched = inContext(client, () => fetchQuery(GetItemGc0, { id: '1' }));
    const disposeEnabled = activate(client, () => fetched.value);
    await fetched;

    const peeked = inContext(client, () => peekQuery(GetItemGc0, { id: '1' }));
    const disposePeek = activate(client, () => peeked.value);
    expect(peeked.value!.name).toBe('Kept');

    // gcTime 0 collects on the next task once nothing holds the query.
    disposeEnabled();
    await sleep(20);
    expect(client.queryInstances.has(key)).toBe(true);
    expect(peeked.value!.name).toBe('Kept');

    disposePeek();
    await sleep(20);
    expect(client.queryInstances.has(key)).toBe(false);
  });

  it('collects an instance only a disabled reader created once that reader leaves', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-gc0/1', { name: 'Cached' });
    await persist(kv, mockFetch, GetItemGc0, { id: '1' });
    const client = makeClient(kv, mockFetch);
    const key = queryKeyForClass(GetItemGc0, { id: '1' });

    const peeked = inContext(client, () => peekQuery(GetItemGc0, { id: '1' }));
    const dispose = activate(client, () => peeked.value);
    expect(peeked.value!.name).toBe('Cached');
    await sleep(20);
    expect(client.queryInstances.has(key)).toBe(true);

    dispose();
    await sleep(20);
    expect(client.queryInstances.has(key)).toBe(false);
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('does not refetch fresh cached data when a disabled query becomes enabled', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-fresh/1', { name: 'Fresh' });
    await persist(kv, mockFetch, GetFreshItem, { id: '1' });
    expect(mockFetch.calls).toHaveLength(1);

    const client = makeClient(kv, mockFetch);
    const peeked = inContext(client, () => peekQuery(GetFreshItem, { id: '1' }));
    const disposePeek = activate(client, () => peeked.value);
    expect(peeked.value!.name).toBe('Fresh');

    const fetched = inContext(client, () => fetchQuery(GetFreshItem, { id: '1' }));
    activate(client, () => fetched.value);
    disposePeek();
    await sleep(20);

    expect(fetched.value!.name).toBe('Fresh');
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('drops a cache read that finishes after the query was enabled and fetched', async () => {
    // An entity result whose fresh fetch returns a different entity than the
    // cache: a late cache apply would swap the root back to the stale one.
    // (A late apply onto the same live entity is a no-op: the cache never overwrites it.)
    class Current extends Entity {
      __typename = t.typename('PeekCurrent');
      id = t.id;
      name = t.string;
    }
    class GetCurrent extends RESTQuery {
      path = '/peek-current';
      result = t.entity(Current);
    }
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-current', { __typename: 'PeekCurrent', id: '1', name: 'Cached' });
    mockFetch.get('/peek-current', { __typename: 'PeekCurrent', id: '2', name: 'Fresh' });
    await persist(kv, mockFetch, GetCurrent, undefined);

    // The disabled reader's cache read is slow; the enabled reader's is not.
    const client = makeClient(kv, mockFetch, { store: asyncReads(new SyncQueryStore(kv), [50, 0]) });
    const peeked = inContext(client, () => peekQuery(GetCurrent, undefined));
    activate(client, () => peeked.value);
    const fetched = inContext(client, () => fetchQuery(GetCurrent));
    activate(client, () => fetched.value);

    await expect.poll(() => fetched.value?.name).toBe('Fresh');
    expect(peeked.value!.name).toBe('Fresh');
    await sleep(80);

    expect(peeked.value!.name).toBe('Fresh');
    expect(fetched.value!.name).toBe('Fresh');
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('follows Signal params, loading each key from the cache and pending on a miss', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = createMockFetch();
    mockFetch.get('/peek-item/1', { name: 'One' });
    mockFetch.get('/peek-item/2', { name: 'Two' });
    await persist(kv, mockFetch, GetItem, { id: '1' });
    await persist(kv, mockFetch, GetItem, { id: '2' });
    expect(mockFetch.calls).toHaveLength(2);

    const client = makeClient(kv, mockFetch);
    const id = signal('1');
    const peeked = inContext(client, () => peekQuery(GetItem, { id }));
    activate(client, () => peeked.value?.name);
    expect(peeked.value!.name).toBe('One');

    id.value = '2';
    await expect.poll(() => peeked.value?.name).toBe('Two');
    expect(peeked.isPending).toBe(false);

    id.value = '3';
    await expect.poll(() => peeked.isPending).toBe(true);

    await sleep(20);
    expect(mockFetch.calls).toHaveLength(2);
  });
});
