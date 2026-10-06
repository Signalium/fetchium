import { describe, it, expect } from 'vitest';
import { signal, watcher, withContexts } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { NetworkManager } from '../NetworkManager.js';
import { t } from '../typeDefs.js';
import { fetchQuery, queryKeyForClass } from '../query.js';
import { updatedAtKeyFor } from '../stores/shared.js';
import { sleep } from './utils.js';

/**
 * The first fetch and zero-delay refetches start on a microtask, ahead of
 * Signalium's flush. That flush is where a Signal param change reaches the
 * query and where a query whose last watcher left is deactivated. These tests
 * pin what happens when either lands in the same task as the fetch was queued.
 */

interface Call {
  path: string;
  aborted: boolean;
}

/**
 * A fetch that answers `{ value: <path> }` after `delay` ms. By default it
 * honours the abort signal, as browser and React Native fetch do.
 */
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

    // Coming back shows the data the background request brought in.
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

    // Coming back fetches the current params.
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
    // A caller awaiting the refetch still settles.
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
