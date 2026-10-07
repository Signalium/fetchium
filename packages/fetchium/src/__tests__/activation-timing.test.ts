import { describe, it, expect, afterEach } from 'vitest';
import { reactive, signal, watcher, withContexts } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { NetworkManager } from '../NetworkManager.js';
import { t } from '../typeDefs.js';
import { fetchQuery, queryKeyForClass } from '../query.js';
import { updatedAtKeyFor } from '../stores/shared.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import { Entity } from '../proxy.js';
import { getEntityMapSize, sleep } from './utils.js';

// First fetches and zero-delay refetches start on a microtask, ahead of the
// Signalium flush that applies Signal param changes and deactivations.

interface Call {
  path: string;
  aborted: boolean;
}

/** A fetch answering `{ value: <path> }` after `delay` ms. Honours abort by default. */
function createFetch(delay: number, { ignoreAbort = false }: { ignoreAbort?: boolean } = {}) {
  const calls: Call[] = [];
  const fetch = (url: string, options: RequestInit = {}): Promise<Response> => {
    const path = new URL(url).pathname;
    const call: Call = { path, aborted: false };
    calls.push(call);
    return new Promise<Response>((resolve, reject) => {
      const signal = options.signal as AbortSignal | undefined;
      const onAbort = () => {
        call.aborted = true;
        if (ignoreAbort) return;
        clearTimeout(timer);
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        const body = { value: path };
        resolve({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers(),
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as unknown as Response);
      }, delay);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  };
  return { fetch, calls, paths: () => calls.map(c => c.path + (c.aborted ? '(aborted)' : '')) };
}

function makeClient(
  kv: MemoryPersistentStore,
  fetch: (url: string, options?: RequestInit) => Promise<Response>,
  networkManager?: NetworkManager,
): QueryClient {
  return new QueryClient({
    store: new SyncQueryStore(kv),
    adapters: [new RESTQueryAdapter({ fetch: fetch as any, baseUrl: 'http://localhost' })],
    networkManager,
  });
}

/** Watches `read` the way a render read does, and returns a disposer. */
function activate(client: QueryClient, read: () => unknown): () => void {
  const w = withContexts([[QueryClientContext, client]], () => watcher(read));
  const dispose = w.addListener(() => {});
  void w.value;
  return dispose;
}

/** How `relay` settles: 'resolved', 'rejected:<name>', or 'pending' if it has not within `ms`. */
async function outcome(relay: PromiseLike<unknown>, ms: number = 200): Promise<string> {
  return Promise.race([
    Promise.resolve(relay).then(
      () => 'resolved',
      (error: any) => `rejected:${error?.name ?? error}`,
    ),
    sleep(ms).then(() => 'pending'),
  ]);
}

function state(relay: any) {
  return {
    isPending: relay.isPending as boolean,
    isRejected: relay.isRejected as boolean,
    value: relay.value?.value as string | undefined,
  };
}

class GetItem extends RESTQuery {
  path = '/item';
  result = { value: t.string };
}

class GetItemById extends RESTQuery {
  params = { id: t.string };
  path = `/items/${this.params.id}`;
  result = { value: t.string };
}

class GetItemByIdFresh extends RESTQuery {
  params = { id: t.string };
  path = `/items/${this.params.id}`;
  result = { value: t.string };
  config = { staleTime: 60_000 };
}

function persisted(kv: MemoryPersistentStore, params: { id: string }): boolean {
  return kv.getNumber(updatedAtKeyFor(queryKeyForClass(GetItemById, params))) !== undefined;
}

describe('Activation and deactivation in one task', () => {
  it('lets the first fetch finish when the query is mounted and unmounted in one task', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(10);
    const client = makeClient(kv, f.fetch);

    let relay: any;
    const dispose = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    dispose();
    await sleep(40);

    expect(f.paths()).toEqual(['/item']);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/item' });
    expect(kv.getNumber(updatedAtKeyFor(queryKeyForClass(GetItem, undefined)))).toBeTypeOf('number');

    let first: any;
    const again = activate(client, () => (first ??= state(fetchQuery(GetItem))));
    expect(first).toEqual({ isPending: false, isRejected: false, value: '/item' });
    again();
    client.destroy();
  });

  it('still aborts a first fetch the query leaves in a later task', async () => {
    const f = createFetch(30);
    const client = makeClient(new MemoryPersistentStore(), f.fetch);

    const dispose = activate(client, () => fetchQuery(GetItem).isPending);
    await sleep(5);
    dispose();
    await sleep(10);

    expect(f.paths()).toEqual(['/item(aborted)']);
    client.destroy();
  });

  it('sends no request for a Signal param change made in the task the last watcher leaves', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(5);
    const client = makeClient(kv, f.fetch);
    const id = signal('1');

    let relay: any;
    const dispose = activate(client, () => (relay = fetchQuery(GetItemById, { id })).isPending);
    await sleep(20);
    id.value = '2';
    dispose();
    await sleep(20);

    expect(f.paths()).toEqual(['/items/1']);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/1' });
    expect(persisted(kv, { id: '2' })).toBe(false);

    const again = activate(client, () => fetchQuery(GetItemById, { id }).isPending);
    await sleep(20);
    expect(f.paths()).toEqual(['/items/1', '/items/2']);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/2' });
    again();
    client.destroy();
  });

  it('a stale reactivation in the task the network goes offline waits for the network, without an error', async () => {
    const f = createFetch(5);
    const networkManager = new NetworkManager(true);
    const client = makeClient(new MemoryPersistentStore(), f.fetch, networkManager);

    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    await sleep(20);
    first();
    await sleep(5);

    const second = activate(client, () => fetchQuery(GetItem).isPending);
    networkManager.setNetworkStatus(false);
    await sleep(20);
    expect(f.calls).toHaveLength(1);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/item' });

    networkManager.setNetworkStatus(true);
    await sleep(20);
    expect(f.calls).toHaveLength(2);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/item' });
    second();
    client.destroy();
  });
});

describe('Signal params changing around a fetch', () => {
  it('keeps each params key cached with its own data', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(5);
    const client = makeClient(kv, f.fetch);
    const id = signal('1');

    let relay: any;
    const dispose = activate(client, () => (relay = fetchQuery(GetItemByIdFresh, { id })).isPending);
    await sleep(30);
    const first = relay.value;
    id.value = '2';
    await sleep(30);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/2' });
    expect(relay.value).not.toBe(first);
    dispose();
    await sleep(5);
    client.destroy();

    for (const key of ['1', '2']) {
      const cold = createFetch(5);
      const next = makeClient(kv, cold.fetch);
      let cached: any;
      const off = activate(next, () => (cached = fetchQuery(GetItemByIdFresh, { id: key })).isPending);
      expect(state(cached)).toEqual({ isPending: false, isRejected: false, value: `/items/${key}` });
      await sleep(20);
      expect(cold.paths()).toEqual([]);
      off();
      next.destroy();
    }
  });

  it('leaves another query showing the old params alone when a Signal param moves on', async () => {
    const f = createFetch(5);
    const client = makeClient(new MemoryPersistentStore(), f.fetch);
    const id = signal('1');

    let moving: any;
    let fixed: any;
    const offMoving = activate(client, () => (moving = fetchQuery(GetItemById, { id })).isPending);
    const offFixed = activate(client, () => (fixed = fetchQuery(GetItemById, { id: '1' })).isPending);
    await sleep(30);
    id.value = '2';
    await sleep(30);
    expect(state(moving).value).toBe('/items/2');
    expect(state(fixed).value).toBe('/items/1');
    offMoving();
    offFixed();
    client.destroy();
  });

  describe('with collection (a browser or React Native client)', () => {
    const hadWindow = 'window' in globalThis;
    afterEach(() => {
      if (!hadWindow) delete (globalThis as any).window;
    });

    class Thing extends Entity {
      __typename = t.typename('Thing');
      id = t.id;
      name = t.string;
    }

    function thingFetch() {
      let count = 0;
      return async (url: string): Promise<Response> => {
        await sleep(2);
        const id = new URL(url).pathname.split('/').pop();
        const body = { thing: { __typename: 'Thing', id: `t${id}`, name: `name${id}` }, n: ++count };
        return { ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response;
      };
    }

    it('collecting a query whose Signal param moved onto another query’s params leaves that query’s data live', async () => {
      if (!hadWindow) (globalThis as any).window = globalThis;
      class GetThingById extends RESTQuery {
        params = { id: t.string };
        path = `/things/${this.params.id}`;
        result = { thing: t.entity(Thing), n: t.number };
        config = { gcTime: 0, staleTime: 60_000 };
      }
      const client = makeClient(new MemoryPersistentStore(), thingFetch());
      const id = signal('1');

      let fixed: any;
      const offMoving = activate(client, () => fetchQuery(GetThingById, { id }).isPending);
      const offFixed = activate(client, () => (fixed = fetchQuery(GetThingById, { id: '2' })).isPending);
      await sleep(20);
      id.value = '2';
      await sleep(20);
      offMoving();
      await sleep(50);
      expect((client as any).queryInstances.size).toBe(1);

      client.applyMutationEvent({
        type: 'update',
        typename: 'Thing',
        data: { __typename: 'Thing', id: 't2', name: 'renamed' },
      });
      expect(fixed.value.thing.name).toBe('renamed');
      offFixed();
      client.destroy();
    });

    it('a collected query’s relay that a reactive function kept leaves the root of a new query for the same params alone', async () => {
      if (!hadWindow) (globalThis as any).window = globalThis;
      class GetThing extends RESTQuery {
        path = '/thing/1';
        result = { thing: t.entity(Thing), n: t.number };
        config = { gcTime: 0, staleTime: 0 };
      }
      const client = makeClient(new MemoryPersistentStore(), thingFetch());
      const getThing = reactive(() => fetchQuery(GetThing));

      let kept: any;
      const first = activate(client, () => (kept = getThing()).isPending);
      await sleep(20);
      first();
      await sleep(50);
      expect((client as any).queryInstances.size).toBe(0);

      const keptAgain = activate(client, () => getThing().isPending);
      let fresh: any;
      const second = activate(client, () => (fresh = fetchQuery(GetThing)).isPending);
      await sleep(20);
      const shown = fresh.value;
      await kept.value.__refetch();
      await fresh.value.__refetch();
      expect(fresh.value).toBe(shown);
      const instance = [...(client as any).queryInstances.values()][0];
      expect((client as any).entityMap.getEntity(instance.rootEntity.key)).toBe(instance.rootEntity);
      keptAgain();
      second();
      client.destroy();
    });
  });

  it('sends the current params when a Signal param changes in the task the query activates', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(5);
    const client = makeClient(kv, f.fetch);
    const id = signal('1');

    let relay: any;
    const dispose = activate(client, () => (relay = fetchQuery(GetItemById, { id })).isPending);
    id.value = '2';
    await sleep(30);

    expect(f.paths()).toEqual(['/items/2']);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/2' });
    expect(persisted(kv, { id: '1' })).toBe(false);
    expect(persisted(kv, { id: '2' })).toBe(true);
    dispose();
    client.destroy();
  });

  it('replaces a fetch in flight for the old params', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(15);
    const client = makeClient(kv, f.fetch);
    const id = signal('1');

    let relay: any;
    const dispose = activate(client, () => (relay = fetchQuery(GetItemById, { id })).isPending);
    await sleep(5);
    id.value = '2';
    await sleep(50);

    expect(f.paths()).toEqual(['/items/1(aborted)', '/items/2']);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/2' });
    expect(persisted(kv, { id: '1' })).toBe(false);
    expect(persisted(kv, { id: '2' })).toBe(true);
    dispose();
    client.destroy();
  });

  it('never applies or persists an old-params response from an adapter that ignores the abort', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(15, { ignoreAbort: true });
    const client = makeClient(kv, f.fetch);
    const id = signal('1');

    let relay: any;
    const values: (string | undefined)[] = [];
    const dispose = activate(client, () => {
      relay = fetchQuery(GetItemById, { id });
      values.push(relay.value?.value);
    });
    await sleep(5);
    id.value = '2';
    await sleep(50);

    expect(f.calls.map(c => c.path)).toEqual(['/items/1', '/items/2']);
    expect(values).not.toContain('/items/1');
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/2' });
    expect(persisted(kv, { id: '1' })).toBe(false);
    dispose();
    client.destroy();
  });

  it('refetches on reactivation when a Signal param changed while the query was inactive, even if fresh', async () => {
    class GetFreshItem extends RESTQuery {
      params = { id: t.string };
      path = `/items/${this.params.id}`;
      result = { value: t.string };
      config = { staleTime: 60_000 };
    }
    const f = createFetch(5);
    const client = makeClient(new MemoryPersistentStore(), f.fetch);
    const id = signal('1');

    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetFreshItem, { id })).isPending);
    await sleep(20);
    first();
    await sleep(5);
    id.value = '2';

    const second = activate(client, () => fetchQuery(GetFreshItem, { id }).isPending);
    await sleep(20);
    expect(f.paths()).toEqual(['/items/1', '/items/2']);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/2' });
    second();
    client.destroy();
  });
});

describe('Reactivating after a deactivation aborted the fetch', () => {
  it('refetches without showing the AbortError next to the cached value', async () => {
    class GetStaleItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      config = { staleTime: 0 };
    }
    const f = createFetch(20);
    const client = makeClient(new MemoryPersistentStore(), f.fetch);

    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetStaleItem)).isPending);
    await sleep(40);
    const refetched = relay.value.__refetch().then(
      () => 'resolved',
      (error: Error) => `rejected:${error.name}`,
    );
    await sleep(5);
    first();
    expect(await refetched).toBe('rejected:AbortError');
    expect(state(relay)).toEqual({ isPending: false, isRejected: true, value: '/item' });

    const reads: ReturnType<typeof state>[] = [];
    const second = activate(client, () => reads.push(state(fetchQuery(GetStaleItem))));
    expect(reads[0]).toEqual({ isPending: true, isRejected: false, value: '/item' });
    await sleep(40);
    expect(reads.some(r => r.isRejected)).toBe(false);
    expect(f.paths()).toEqual(['/item', '/item(aborted)', '/item']);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/item' });
    second();
    client.destroy();
  });
});

/** Socket-like topic adapter. Unsubscribing drops topic state, so a waiting send() never resolves. */
class SocketTopicAdapter extends TopicQueryAdapter {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  subscribe(topic: string): void {
    this.timers.set(
      topic,
      setTimeout(() => this.fulfillTopic(topic, { value: `data:${topic}` }), 5),
    );
  }
  unsubscribe(topic: string): void {
    clearTimeout(this.timers.get(topic));
    this.timers.delete(topic);
    this.clearTopic(topic);
  }
}

class GetPrices extends TopicQuery {
  topic = 'prices';
  result = { value: t.string };
}

function makeTopicClient(kv: MemoryPersistentStore): QueryClient {
  return new QueryClient({ store: new SyncQueryStore(kv), adapters: [new SocketTopicAdapter()] });
}

describe('A topic query mounted and unmounted in one task', () => {
  it('settles when it is mounted again', async () => {
    const client = makeTopicClient(new MemoryPersistentStore());

    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetPrices)).isPending);
    first();
    await sleep(50);

    const second = activate(client, () => fetchQuery(GetPrices).isPending);
    await sleep(50);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: 'data:prices' });
    second();
    client.destroy();
  });

  it('settles when it is mounted again with a cached value', async () => {
    const kv = new MemoryPersistentStore();
    const seed = makeTopicClient(kv);
    const seeded = activate(seed, () => fetchQuery(GetPrices).isPending);
    await sleep(30);
    seeded();
    seed.destroy();

    const client = makeTopicClient(kv);
    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetPrices)).isPending);
    first();
    await sleep(50);

    const second = activate(client, () => fetchQuery(GetPrices).isPending);
    await sleep(50);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: 'data:prices' });
    second();
    client.destroy();
  });

  it('settles an awaiter of the first mount without another mount', async () => {
    const client = makeTopicClient(new MemoryPersistentStore());

    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetPrices)).isPending);
    first();
    expect(await outcome(relay)).toBe('rejected:AbortError');
    client.destroy();
  });

  describe('under an AbortController whose signal has no reason (the React Native polyfill)', () => {
    const NativeAbortController = globalThis.AbortController;
    class ReasonlessAbortController {
      private controller = new NativeAbortController();
      readonly signal: AbortSignal = this.controller.signal;
      constructor() {
        Object.defineProperty(this.signal, 'reason', { get: () => undefined });
      }
      abort(): void {
        this.controller.abort();
      }
    }
    afterEach(() => {
      globalThis.AbortController = NativeAbortController;
    });

    it('rejects the awaiter with an AbortError, not undefined, and a remount still settles', async () => {
      globalThis.AbortController = ReasonlessAbortController as unknown as typeof AbortController;
      const client = makeTopicClient(new MemoryPersistentStore());

      let relay: any;
      const first = activate(client, () => (relay = fetchQuery(GetPrices)).isPending);
      first();
      expect(await outcome(relay)).toBe('rejected:AbortError');
      expect(relay.error).toBeInstanceOf(Error);

      const second = activate(client, () => fetchQuery(GetPrices).isPending);
      await sleep(30);
      expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: 'data:prices' });
      second();
      client.destroy();
    });
  });
});

describe('A topic query unmounted before its first data, in a later task', () => {
  const hadWindow = 'window' in globalThis;
  afterEach(() => {
    if (!hadWindow) delete (globalThis as any).window;
  });

  /** Mounts the topic query and unmounts it 1 ms later, before its data (due at 5 ms). */
  async function mountAndLeave(client: QueryClient): Promise<{ relay: any }> {
    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetPrices)).isPending);
    await sleep(1);
    first();
    // Wrapped: returning the relay itself would await it.
    return { relay };
  }

  it('is pending, not rejected, when mounted again, until its data lands', async () => {
    const client = makeTopicClient(new MemoryPersistentStore());
    const { relay } = await mountAndLeave(client);
    await sleep(20);
    expect(relay.isRejected).toBe(false);

    const reads: ReturnType<typeof state>[] = [];
    const second = activate(client, () => reads.push(state(fetchQuery(GetPrices))));
    expect(reads[0]).toEqual({ isPending: true, isRejected: false, value: undefined });
    await sleep(3);
    expect(state(relay)).toEqual({ isPending: true, isRejected: false, value: undefined });
    await sleep(30);
    expect(reads.some(r => r.isRejected)).toBe(false);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: 'data:prices' });
    second();
    client.destroy();
  });

  it('settles an awaiter of the first mount with the data a later mount brings', async () => {
    const client = makeTopicClient(new MemoryPersistentStore());
    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetPrices)).isPending);
    const awaited = outcome(relay, 500);
    await sleep(1);
    first();
    await sleep(20);

    const second = activate(client, () => fetchQuery(GetPrices).isPending);
    expect(await awaited).toBe('resolved');
    second();
    client.destroy();
  });

  it('settles an awaiter with an AbortError when the client is destroyed', async () => {
    const client = makeTopicClient(new MemoryPersistentStore());
    const { relay } = await mountAndLeave(client);
    const awaited = outcome(relay, 500);
    await sleep(20);
    client.destroy();
    expect(await awaited).toBe('rejected:AbortError');
  });

  it('settles an awaiter with an AbortError when the query is collected', async () => {
    if (!hadWindow) (globalThis as any).window = globalThis;
    class GetCollectedPrices extends TopicQuery {
      topic = 'prices';
      result = { value: t.string };
      getConfig() {
        return { ...super.getConfig(), gcTime: 0 };
      }
    }
    const client = makeTopicClient(new MemoryPersistentStore());
    expect((client as any).isServer).toBe(false);
    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetCollectedPrices)).isPending);
    await sleep(1);
    first();
    expect(await outcome(relay, 500)).toBe('rejected:AbortError');
    expect((client as any).queryInstances.size).toBe(0);
    client.destroy();
  });
});

describe('A query without a subscription unmounted mid-fetch, in a later task', () => {
  it('is pending, not rejected, when mounted again, and its awaiter gets the refetch', async () => {
    const f = createFetch(20);
    const client = makeClient(new MemoryPersistentStore(), f.fetch);

    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    const awaited = outcome(relay, 500);
    await sleep(5);
    first(); // aborts the fetch in flight
    await sleep(5);
    expect(state(relay)).toEqual({ isPending: true, isRejected: false, value: undefined });

    const reads: ReturnType<typeof state>[] = [];
    const second = activate(client, () => reads.push(state(fetchQuery(GetItem))));
    expect(reads[0]).toEqual({ isPending: true, isRejected: false, value: undefined });
    await sleep(50);
    expect(reads.some(r => r.isRejected)).toBe(false);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/item' });
    expect(await awaited).toBe('resolved');
    expect(f.paths()).toEqual(['/item(aborted)', '/item']);
    second();
    client.destroy();
  });

  it('settles its awaiter with an AbortError when the client is destroyed', async () => {
    const f = createFetch(20);
    const client = makeClient(new MemoryPersistentStore(), f.fetch);
    let relay: any;
    const first = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    const awaited = outcome(relay, 500);
    await sleep(5);
    first();
    await sleep(5);
    client.destroy();
    expect(await awaited).toBe('rejected:AbortError');
  });
});

describe('Every awaiter settles', () => {
  it('when destroy() runs in the task the query mounts, before its first start', async () => {
    const { fetch, calls } = createFetch(20);
    const client = makeClient(new MemoryPersistentStore(), fetch);

    let relay: any;
    const dispose = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    client.destroy();
    expect(await outcome(relay)).toBe('rejected:AbortError');
    expect(calls).toEqual([]);
    dispose();
  });

  it('when destroy() runs while a restart after a deactivation abort is queued', async () => {
    const { fetch } = createFetch(20);
    const client = makeClient(new MemoryPersistentStore(), fetch);

    const first = activate(client, () => fetchQuery(GetItem).isPending);
    await sleep(5);
    first(); // aborts the fetch in flight
    await sleep(5);
    let relay: any;
    const second = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    client.destroy();
    expect(await outcome(relay)).toBe('rejected:AbortError');
    second();
  });

  it('when a restart found the network offline and the query is then unmounted', async () => {
    const { fetch, paths } = createFetch(30);
    const networkManager = new NetworkManager(true);
    const client = makeClient(new MemoryPersistentStore(), fetch, networkManager);

    const first = activate(client, () => fetchQuery(GetItem).isPending);
    await sleep(5);
    first(); // aborts the fetch in flight
    await sleep(5);
    let relay: any;
    const second = activate(client, () => (relay = fetchQuery(GetItem)).isPending);
    networkManager.setNetworkStatus(false); // the restart finds the query offline
    await sleep(5);
    second();
    expect(await outcome(relay)).toBe('rejected:AbortError');

    networkManager.setNetworkStatus(true);
    const third = activate(client, () => fetchQuery(GetItem).isPending);
    await sleep(50);
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/item' });
    expect(paths()).toEqual(['/item(aborted)', '/item']);
    third();
    client.destroy();
  });
});

describe('A gcTime: 0 query whose kept first fetch outlives the unmount', () => {
  // Node clients use a no-op GC manager; a browser or React Native client gets the real one.
  const hadWindow = 'window' in globalThis;
  afterEach(() => {
    if (!hadWindow) delete (globalThis as any).window;
  });

  class Thing extends Entity {
    __typename = t.typename('Thing');
    id = t.id;
    name = t.string;
  }
  class GetThing extends RESTQuery {
    path = '/thing';
    result = { thing: t.entity(Thing) };
    config = { gcTime: 0 };
  }

  function createThingFetch(delay: number) {
    let calls = 0;
    const fetch = (_url: string, options: RequestInit = {}): Promise<Response> => {
      calls++;
      const body = { thing: { __typename: 'Thing', id: '1', name: 'a' } };
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve({ ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response),
          delay,
        );
        (options.signal as AbortSignal | undefined)?.addEventListener('abort', () => {
          clearTimeout(timer);
          const error = new Error('The operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    return { fetch, calls: () => calls };
  }

  it('is collected once the fetch lands, leaving nothing resident; a remount before that reuses the fetch', async () => {
    if (!hadWindow) (globalThis as any).window = globalThis;
    const { fetch, calls } = createThingFetch(20);
    const client = makeClient(new MemoryPersistentStore(), fetch);
    expect((client as any).isServer).toBe(false);

    const first = activate(client, () => fetchQuery(GetThing).isPending);
    first();
    await sleep(5);
    expect((client as any).queryInstances.size).toBe(1);
    const second = activate(client, () => fetchQuery(GetThing).isPending);
    await sleep(40);
    second();
    await sleep(20);
    expect(calls()).toBe(1);
    expect((client as any).queryInstances.size).toBe(0);
    expect(getEntityMapSize(client)).toBe(0);

    const third = activate(client, () => fetchQuery(GetThing).isPending);
    third();
    await sleep(60);
    expect((client as any).queryInstances.size).toBe(0);
    expect(getEntityMapSize(client)).toBe(0);
    client.destroy();
  });

  it('writes nothing after destroy()', async () => {
    if (!hadWindow) (globalThis as any).window = globalThis;
    const { fetch } = createThingFetch(20);
    const kv = new MemoryPersistentStore();
    const client = makeClient(kv, fetch);

    const first = activate(client, () => fetchQuery(GetThing).isPending);
    first();
    await sleep(5);
    client.destroy();
    await sleep(40);
    expect(kv.getNumber(updatedAtKeyFor(queryKeyForClass(GetThing, undefined)))).toBeUndefined();
  });
});

describe('A Signal param change while other signals keep flushing', () => {
  it('refetches within a task or two, not once the flushes stop', async () => {
    const f = createFetch(1);
    const client = makeClient(new MemoryPersistentStore(), f.fetch);
    const id = signal('1');
    const noise = signal(0);

    const dispose = activate(client, () => fetchQuery(GetItemById, { id }).isPending);
    // A listener that writes a signal makes every flush schedule the next.
    const reader = watcher(() => noise.value);
    let flushes = 0;
    const stopReader = reader.addListener(() => {
      if (flushes++ < 200) noise.value = noise.value + 1;
    });
    await sleep(20);

    let tasks = 0;
    let ticking = true;
    const tick = (): void => {
      if (!ticking) return;
      tasks++;
      setTimeout(tick, 0);
    };
    setTimeout(tick, 0);
    flushes = 0;
    id.value = '2';
    noise.value = noise.value + 1;

    let startedAt = -1;
    for (let i = 0; i < 400 && startedAt === -1; i++) {
      await sleep(0);
      if (f.calls.length === 2) startedAt = tasks;
    }
    ticking = false;

    expect(f.paths()).toEqual(['/items/1', '/items/2']);
    expect(startedAt).toBeLessThanOrEqual(3);
    expect(flushes).toBeLessThan(200);
    stopReader();
    dispose();
    client.destroy();
  });
});

describe('reactivationStaggerMs and refetches a pause aborted', () => {
  it('spreads the restarted refetches across the window on reconnect', async () => {
    const starts: number[] = [];
    let t0 = 0;
    const f = createFetch(10);
    const fetch = (url: string, options?: RequestInit) => {
      starts.push(performance.now() - t0);
      return f.fetch(url, options);
    };
    const networkManager = new NetworkManager(true);
    const client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new RESTQueryAdapter({ fetch: fetch as any, baseUrl: 'http://localhost' })],
      networkManager,
      reactivationStaggerMs: 300,
    });

    const relays: any[] = [];
    const disposers = ['1', '2', '3', '4'].map((id, i) =>
      activate(client, () => (relays[i] = fetchQuery(GetItemById, { id })).isPending),
    );
    await sleep(30);
    for (const relay of relays) relay.value.__refetch();
    await sleep(2);
    networkManager.setNetworkStatus(false);
    await sleep(20);

    t0 = performance.now();
    starts.length = 0;
    networkManager.setNetworkStatus(true);
    await sleep(400);

    expect(starts).toHaveLength(4);
    expect(Math.max(...starts) - Math.min(...starts)).toBeGreaterThan(100);
    for (const relay of relays) expect(relay.isRejected).toBe(false);
    for (const dispose of disposers) dispose();
    client.destroy();
  });
});

describe('Responses that arrive after the client or the params moved on', () => {
  it('writes nothing to the store after destroy(), including a same-task unmount kept first fetch', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(20);
    const client = makeClient(kv, f.fetch);

    const dispose = activate(client, () => fetchQuery(GetItem).isPending);
    dispose();
    await sleep(0);
    client.destroy();
    await sleep(60);

    expect(f.paths()).toEqual(['/item(aborted)']);
    expect(kv.getNumber(updatedAtKeyFor(queryKeyForClass(GetItem, undefined)))).toBeUndefined();
  });

  it('writes nothing to the store after destroy() when the adapter ignores the abort', async () => {
    const kv = new MemoryPersistentStore();
    const f = createFetch(20, { ignoreAbort: true });
    const client = makeClient(kv, f.fetch);

    activate(client, () => fetchQuery(GetItem).isPending);
    await sleep(0);
    client.destroy();
    await sleep(60);

    expect(f.paths()).toEqual(['/item(aborted)']);
    expect(kv.getNumber(updatedAtKeyFor(queryKeyForClass(GetItem, undefined)))).toBeUndefined();
    expect(kv.getAllKeys().filter(k => k.startsWith('sq:doc:value:'))).toEqual([]);
  });

  it('drops a fetchNext page for params that changed while it was in flight', async () => {
    class GetList extends RESTQuery {
      params = { id: t.string };
      path = `/lists/${this.params.id}`;
      searchParams = { page: 1 };
      result = { items: t.array(t.string), next: t.optional(t.number) };
      fetchNext = { searchParams: { page: this.result.next } };
    }
    const calls: string[] = [];
    const fetch = (url: string): Promise<Response> => {
      const u = new URL(url);
      const page = u.searchParams.get('page') ?? '1';
      calls.push(`${u.pathname}#p${page}`);
      const body = { items: [`${u.pathname}#p${page}`], next: page === '1' ? 2 : undefined };
      // Ignores the abort signal.
      return new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              ok: true,
              status: 200,
              statusText: 'OK',
              headers: new Headers(),
              json: async () => body,
              text: async () => JSON.stringify(body),
            } as unknown as Response),
          page === '1' ? 1 : 20,
        ),
      );
    };
    const kv = new MemoryPersistentStore();
    const client = makeClient(kv, fetch);
    const id = signal('1');

    let relay: any;
    const dispose = activate(client, () => (relay = fetchQuery(GetList, { id })).isPending);
    await sleep(15);
    const next = relay.value.__fetchNext().catch((error: Error) => error.name);
    await sleep(2);
    id.value = '2';
    await sleep(60);

    expect(await next).toBe('AbortError');
    expect(relay.value.items).toEqual(['/lists/2#p1']);
    dispose();
    client.destroy();
  });

  it('does not apply an asynchronous cache load for params that changed while it was pending', async () => {
    class SlowLoadStore extends SyncQueryStore {
      override loadQuery(...args: Parameters<SyncQueryStore['loadQuery']>): any {
        const loaded = super.loadQuery(...args);
        return new Promise(resolve => setTimeout(() => resolve(loaded), 30));
      }
    }
    const kv = new MemoryPersistentStore();
    {
      const seed = makeClient(kv, createFetch(1).fetch);
      const seeded = activate(seed, () => fetchQuery(GetItemById, { id: '1' }).isPending);
      await sleep(20);
      seeded();
      seed.destroy();
    }
    const f = createFetch(5);
    const client = new QueryClient({
      store: new SlowLoadStore(kv),
      adapters: [new RESTQueryAdapter({ fetch: f.fetch as any, baseUrl: 'http://localhost' })],
    });
    const id = signal('1');

    let relay: any;
    const values: (string | undefined)[] = [];
    const dispose = activate(client, () => {
      relay = fetchQuery(GetItemById, { id });
      values.push(relay.value?.value);
    });
    await sleep(2);
    id.value = '2';
    await sleep(80);

    expect(f.paths()).toEqual(['/items/2']);
    expect(values).not.toContain('/items/1');
    expect(state(relay)).toEqual({ isPending: false, isRejected: false, value: '/items/2' });
    dispose();
    client.destroy();
  });
});
