/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { reactive, signal, watcher, withContexts } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext, DEFAULT_PREFETCH_TTL } from '../QueryClient.js';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { t } from '../typeDefs.js';
import { fetchQuery, QueryDefinition } from '../query.js';
import { QueryInstance } from '../QueryResult.js';
import type { MutationEvent } from '../types.js';
import { GcManager, type GcKeyType } from '../GcManager.js';
import { NetworkManager } from '../NetworkManager.js';
import { createMockFetch, sleep } from './utils.js';

/**
 * client.retain() and client.prefetch(): app-level leases that keep queries
 * active without a reader, so a reader that mounts inside the lease joins the
 * running query instead of starting its own.
 */

async function flushMicrotasks(count = 30): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

class GetItem extends RESTQuery {
  path = '/item';
  result = { n: t.number };
  config = { staleTime: 0 };
}

class GetOther extends RESTQuery {
  path = '/other';
  result = { n: t.number };
  config = { staleTime: 0 };
}

class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { n: t.number };
}

class GetFreshUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { n: t.number };
  config = { staleTime: 60_000 };
}

let subscribed = 0;
let unsubscribed = 0;

class GetStreamed extends RESTQuery {
  path = '/streamed';
  result = { n: t.number };
  config = {
    subscribe: (_onEvent: (event: MutationEvent) => void) => {
      subscribed++;
      return () => {
        unsubscribed++;
      };
    },
  };
}

let clients: QueryClient[] = [];

afterEach(() => {
  for (const c of clients) c.destroy();
  clients = [];
  subscribed = 0;
  unsubscribed = 0;
});

class GetIdentity extends RESTQuery {
  path = '/identity';
  result = { id: t.number };
}

class GetHoldings extends RESTQuery {
  params = { owner: t.number };
  path = `/holdings/${this.params.owner}`;
  result = { n: t.number };
}

function setup(
  kv: MemoryPersistentStore = new MemoryPersistentStore(),
  options: { reactivationStaggerMs?: number } = {},
) {
  const mockFetch = createMockFetch();
  let n = 0;
  for (const path of ['/item', '/other', '/users/[id]', '/streamed', '/holdings/[owner]']) {
    mockFetch.get(path, () => ({ n: ++n }));
  }
  mockFetch.get('/identity', { id: 42 });
  const client = new QueryClient({
    ...options,
    store: new SyncQueryStore(kv),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
  });
  clients.push(client);
  return { client, mockFetch, kv };
}

/** Mounts a reader: watches `read` and runs it now, like a React render. */
function mountReader<T>(client: QueryClient, read: () => T): { w: { value: T }; unsub: () => void } {
  const w = withContexts([[QueryClientContext, client]], () => watcher(read));
  const unsub = w.addListener(() => {});
  w.value;
  return { w: w as { value: T }, unsub };
}

describe('client.prefetch()', () => {
  it('issues the request before returning', async () => {
    const { client, mockFetch } = setup();
    client.prefetch(GetItem);
    expect(mockFetch.calls).toHaveLength(1);
    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('issues the request ahead of a render already queued on the microtask queue', async () => {
    const { client, mockFetch } = setup();
    let callsAtRender = -1;
    // React queues its sync render for a press as a microtask before the handler's prefetch.
    queueMicrotask(() => {
      callsAtRender = mockFetch.calls.length;
    });
    client.prefetch(GetItem);
    await flushMicrotasks();
    expect(callsAtRender).toBe(1);
  });

  it('a reader activating a query leaves its fetch for the microtask, as before', async () => {
    const { client, mockFetch } = setup();
    const { unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    expect(mockFetch.calls).toHaveLength(0);
    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);
    unsub();
  });

  it('starts a query a reader activated earlier in the same task, once', async () => {
    const { client, mockFetch } = setup();
    const { w, unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    expect(mockFetch.calls).toHaveLength(0);
    client.prefetch(GetItem);
    expect(mockFetch.calls).toHaveLength(1);
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    expect(w.value).toMatchObject({ n: 1 });
    unsub();
  });

  it('a reader mounting in the same task joins the request, with no second one', async () => {
    const { client, mockFetch } = setup();
    mockFetch.reset();
    mockFetch.get('/item', { n: 5 }, { delay: 20 });
    client.prefetch(GetItem);
    expect(mockFetch.calls).toHaveLength(1);

    const { w, unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    expect(w.value).toBeUndefined();
    await sleep(40);
    expect(w.value).toMatchObject({ n: 5 });
    expect(mockFetch.calls).toHaveLength(1);
    expect(mockFetch.calls[0].options.signal?.aborted).toBe(false);
    unsub();
  });

  it('refetches a stale, inactive query before returning', async () => {
    const { client, mockFetch } = setup();
    const release = client.prefetch(GetItem);
    await sleep(10);
    release();
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);

    client.prefetch(GetItem);
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('leaves a stale reactivation to the stagger when reactivationStaggerMs is set', async () => {
    const { client, mockFetch } = setup(undefined, { reactivationStaggerMs: 100 });
    const release = client.prefetch(GetItem);
    expect(mockFetch.calls).toHaveLength(1);
    await sleep(10);
    release();
    await sleep(10);

    client.prefetch(GetItem);
    await flushMicrotasks();
    expect(mockFetch.calls).toHaveLength(1);
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('a reader mounting after the data arrives renders it on its first read, with no second request', async () => {
    const { client, mockFetch } = setup();
    client.prefetch(GetItem, undefined, { ttl: 1_000 });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);

    // staleTime 0, yet the query is still active, so mounting is not a reactivation.
    const { w, unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    expect(w.value).toMatchObject({ n: 1 });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    unsub();
  });

  it('a reader mounting while the fetch is in flight joins it', async () => {
    const { client, mockFetch } = setup();
    mockFetch.reset();
    mockFetch.get('/item', { n: 7 }, { delay: 30 });
    client.prefetch(GetItem, undefined, { ttl: 1_000 });
    await sleep(5);

    const { w, unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    expect(w.value).toBeUndefined();
    await sleep(50);
    expect(w.value).toMatchObject({ n: 7 });
    expect(mockFetch.calls).toHaveLength(1);
    unsub();
  });

  it('passes params, and keys on them', async () => {
    const { client, mockFetch } = setup();
    client.prefetch(GetUser, { id: 4 });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    expect(mockFetch.calls[0].url).toContain('/users/4');

    const { w, unsub } = mountReader(client, () => fetchQuery(GetUser, { id: 4 }).value);
    expect(w.value).toMatchObject({ n: 1 });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    unsub();
  });

  it('serves fresh cached data from a synchronous store without a request', async () => {
    const kv = new MemoryPersistentStore();
    const seed = setup(kv);
    seed.client.prefetch(GetFreshUser, { id: 1 });
    await sleep(10);
    expect(seed.mockFetch.calls).toHaveLength(1);
    seed.client.destroy();

    const { client, mockFetch } = setup(kv);
    client.prefetch(GetFreshUser, { id: 1 });
    // Hydrated by the activation inside prefetch(), before it returned.
    expect(client.getQuery(QueryDefinition.for(GetFreshUser), { id: 1 }).value).toMatchObject({ n: 1 });
    expect(mockFetch.calls).toHaveLength(0);
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(0);
  });

  it('expires after ttl: the query deactivates, and a later mount is a reactivation', async () => {
    const { client, mockFetch } = setup();
    client.prefetch(GetItem, undefined, { ttl: 20 });
    await sleep(60);
    expect(mockFetch.calls).toHaveLength(1);

    // staleTime 0 and no grace: reactivating refetches.
    const { w, unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    expect(w.value).toMatchObject({ n: 1 });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(2);
    unsub();
  });

  it('a ttl that runs out mid-fetch releases the lease, aborting the fetch with no reader', async () => {
    const { client, mockFetch } = setup();
    mockFetch.reset();
    mockFetch.get('/streamed', { n: 9 }, { delay: 40 });
    client.prefetch(GetStreamed, undefined, { ttl: 10 });
    await sleep(25);
    // The ttl is an upper bound: past it, before the response, the lease is gone.
    expect(unsubscribed).toBe(1);
    expect(mockFetch.calls[0].options.signal?.aborted).toBe(true);
    await sleep(40);
  });

  it('a ttl that runs out mid-fetch leaves a reader that joined the fetch running', async () => {
    const { client, mockFetch } = setup();
    mockFetch.reset();
    mockFetch.get('/streamed', { n: 9 }, { delay: 40 });
    client.prefetch(GetStreamed, undefined, { ttl: 10 });
    await sleep(5);
    const { w, unsub } = mountReader(client, () => fetchQuery(GetStreamed).value);
    await sleep(60);
    expect(mockFetch.calls).toHaveLength(1);
    expect(mockFetch.calls[0].options.signal?.aborted).toBe(false);
    expect(w.value).toMatchObject({ n: 9 });
    unsub();
  });

  it('a ttl caps a lease whose fetch never settles', async () => {
    vi.useFakeTimers();
    try {
      const networkManager = new NetworkManager(false);
      const client = new QueryClient({
        store: new SyncQueryStore(new MemoryPersistentStore()),
        adapters: [new RESTQueryAdapter({ fetch: createMockFetch() as any, baseUrl: 'http://localhost' })],
        networkManager,
      });
      clients.push(client);
      // Offline: the relay stays pending.
      client.prefetch(GetStreamed, undefined, { ttl: 1_000 });
      await vi.advanceTimersByTimeAsync(10);
      expect(client.getQuery(QueryDefinition.for(GetStreamed), undefined).isPending).toBe(true);
      await vi.advanceTimersByTimeAsync(2_000);
      expect((client as unknown as { leases: Set<unknown> }).leases.size).toBe(0);
      client.destroy();
      clients = [];
      await vi.advanceTimersByTimeAsync(1_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroy() clears the ttl timer', async () => {
    vi.useFakeTimers();
    try {
      const { client } = setup();
      client.prefetch(GetItem, undefined, { ttl: 60_000 });
      await vi.advanceTimersByTimeAsync(20);
      client.destroy();
      clients = [];
      await vi.advanceTimersByTimeAsync(50);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('defaults ttl to DEFAULT_PREFETCH_TTL', () => {
    expect(DEFAULT_PREFETCH_TTL).toBe(10_000);
  });

  it('release() while a reader is mounted leaves the reader running', async () => {
    const { client, mockFetch } = setup();
    mockFetch.reset();
    mockFetch.get('/item', { n: 3 }, { delay: 30 });
    const release = client.prefetch(GetItem);
    await sleep(5);
    const { w, unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    release();
    release();
    await sleep(50);
    expect(mockFetch.calls).toHaveLength(1);
    expect(mockFetch.calls[0].options.signal?.aborted).toBe(false);
    expect(w.value).toMatchObject({ n: 3 });
    unsub();
  });

  it('release() with no reader aborts an in-flight fetch', async () => {
    const { client, mockFetch } = setup();
    mockFetch.reset();
    mockFetch.get('/item', { n: 3 }, { delay: 30 });
    const release = client.prefetch(GetItem);
    await sleep(5);
    release();
    // Still before the response (30 ms): the request has been cancelled.
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    expect(mockFetch.calls[0].options.signal?.aborted).toBe(true);
    await sleep(40);
  });
});

describe('client.retain()', () => {
  it('issues the first request of a chained lease before returning, and the next when its input arrives', async () => {
    const { client, mockFetch } = setup();
    const release = client.retain(() => {
      const identity = fetchQuery(GetIdentity);
      if (!identity.isReady) return identity;
      return fetchQuery(GetHoldings, { owner: identity.value.id });
    });
    expect(mockFetch.calls.map(c => new URL(c.url).pathname)).toEqual(['/identity']);
    await sleep(10);
    expect(mockFetch.calls.map(c => new URL(c.url).pathname)).toEqual(['/identity', '/holdings/42']);

    const { w, unsub } = mountReader(client, () => fetchQuery(GetHoldings, { owner: 42 }).value);
    expect(w.value).toMatchObject({ n: expect.any(Number) });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(2);
    unsub();
    release();
  });

  it('issues both requests of a chained lease before returning when the first is cached and fresh', async () => {
    const kv = new MemoryPersistentStore();
    const seed = setup(kv);
    seed.client.retain(() => fetchQuery(GetFreshUser, { id: 1 }));
    await sleep(10);
    seed.client.destroy();

    const { client, mockFetch } = setup(kv);
    const release = client.retain(() => {
      const user = fetchQuery(GetFreshUser, { id: 1 });
      if (!user.isReady) return user;
      return fetchQuery(GetHoldings, { owner: user.value.n });
    });
    expect(mockFetch.calls.map(c => new URL(c.url).pathname)).toEqual(['/holdings/1']);
    release();
  });

  it('holds the query promises the callback returns', async () => {
    const { client, mockFetch } = setup();
    const release = client.retain(() => [fetchQuery(GetItem), fetchQuery(GetOther)]);
    await sleep(10);
    expect(mockFetch.calls.map(c => new URL(c.url).pathname).sort()).toEqual(['/item', '/other']);

    const { w, unsub } = mountReader(client, () => [fetchQuery(GetItem).value, fetchQuery(GetOther).value]);
    expect(w.value).toEqual([expect.objectContaining({ n: expect.any(Number) }), expect.any(Object)]);
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(2);
    unsub();
    release();
  });

  it('holds queries whose fields the callback reads', async () => {
    const { client, mockFetch } = setup();
    const release = client.retain(() => {
      fetchQuery(GetItem).isReady;
    });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    const { w, unsub } = mountReader(client, () => fetchQuery(GetItem).value);
    expect(w.value).toMatchObject({ n: 1 });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    unsub();
    release();
  });

  it('keeps a subscription running until released', async () => {
    const { client } = setup();
    const release = client.retain(() => fetchQuery(GetStreamed));
    await sleep(10);
    expect(subscribed).toBe(1);

    // A reader coming and going doesn't restart it.
    const reader = mountReader(client, () => fetchQuery(GetStreamed).value);
    reader.unsub();
    await sleep(10);
    expect(subscribed).toBe(1);
    expect(unsubscribed).toBe(0);

    release();
    await sleep(10);
    expect(unsubscribed).toBe(1);
  });

  it('follows Signal params', async () => {
    const { client, mockFetch } = setup();
    const id = signal(1);
    const release = client.retain(() => fetchQuery(GetUser, { id }));
    await sleep(10);
    id.value = 2;
    await sleep(20);
    expect(mockFetch.calls.map(c => new URL(c.url).pathname)).toEqual(['/users/1', '/users/2']);
    release();
  });

  it('without ttl, holds until released', async () => {
    const { client } = setup();
    const release = client.retain(() => fetchQuery(GetStreamed));
    await sleep(50);
    expect(unsubscribed).toBe(0);
    release();
    await sleep(10);
    expect(unsubscribed).toBe(1);
  });

  it('with ttl, releases itself', async () => {
    const { client } = setup();
    client.retain(() => fetchQuery(GetStreamed), { ttl: 20 });
    await sleep(10);
    expect(subscribed).toBe(1);
    await sleep(40);
    expect(unsubscribed).toBe(1);
  });

  it('destroy() releases outstanding leases', async () => {
    const { client } = setup();
    client.retain(() => fetchQuery(GetStreamed));
    await sleep(10);
    client.destroy();
    await sleep(10);
    expect(unsubscribed).toBe(1);
  });

  it('destroy() leaves no GC timer behind for the queries it releases', async () => {
    const created: unknown[] = [];
    const cleared = new Set<unknown>();
    const realSetInterval = globalThis.setInterval;
    const realClearInterval = globalThis.clearInterval;
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms?: number) => {
      const id = realSetInterval(fn, ms);
      created.push(id);
      return id;
    }) as typeof setInterval);
    vi.spyOn(globalThis, 'clearInterval').mockImplementation(((id: ReturnType<typeof setInterval>) => {
      cleared.add(id);
      realClearInterval(id);
    }) as typeof clearInterval);

    try {
      const { client } = setup();
      // A real GcManager: the tests' window-less environment gets the no-op one.
      (client as unknown as { gcManager: GcManager }).gcManager = new GcManager(
        (client as unknown as { handleEviction: (key: number, type: GcKeyType) => void }).handleEviction,
        1,
      );
      client.retain(() => fetchQuery(GetItem));
      await sleep(20);
      client.destroy();
      clients = [];
      // The released query deactivates on Signalium's next flush, after destroy().
      await sleep(50);
      const leaked = created.filter(id => !cleared.has(id));
      for (const id of leaked) realClearInterval(id as ReturnType<typeof setInterval>);
      expect(leaked).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('warns, and keeps one lease, when called from a reactive computation that reruns', async () => {
    const warn = vi.fn();
    const mockFetch = createMockFetch();
    mockFetch.get('/item', () => ({ n: 1 }));
    const client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
      log: { warn },
    });
    clients.push(client);
    const leases = (client as unknown as { leases: Set<unknown> }).leases;

    const tick = signal(0);
    const computation = reactive(() => {
      const value = tick.value;
      client.retain(() => fetchQuery(GetItem));
      return value;
    });
    const { w, unsub } = mountReader(client, () => computation());
    expect(warn).toHaveBeenCalledTimes(1);
    for (let i = 1; i <= 5; i++) {
      tick.value = i;
      w.value;
      await sleep(10);
    }
    expect(leases.size).toBe(1);
    expect(mockFetch.calls).toHaveLength(1);
    unsub();
  });

  it('does not warn when called outside a reactive computation', () => {
    const warn = vi.fn();
    const client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new RESTQueryAdapter({ fetch: createMockFetch() as any, baseUrl: 'http://localhost' })],
      log: { warn },
    });
    clients.push(client);
    client.retain(() => fetchQuery(GetItem))();
    expect(warn).not.toHaveBeenCalled();
  });

  it('releases and rethrows when the callback throws', () => {
    const { client } = setup();
    expect(() =>
      client.retain(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('releases and rethrows when starting a query throws', async () => {
    const { client } = setup();
    const start = QueryInstance.prototype.startPendingNow;
    let calls = 0;
    const spy = vi.spyOn(QueryInstance.prototype, 'startPendingNow').mockImplementation(function (
      this: QueryInstance<any>,
    ) {
      if (++calls === 2) throw new Error('boom');
      start.call(this);
    });

    expect(() => client.retain(() => [fetchQuery(GetStreamed), fetchQuery(GetItem)])).toThrow('boom');
    spy.mockRestore();

    await sleep(10);
    expect(subscribed).toBe(1);
    expect(unsubscribed).toBe(1);
  });
});
