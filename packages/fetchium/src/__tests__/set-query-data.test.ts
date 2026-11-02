/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, it, expect, vi } from 'vitest';
import React, { Suspense } from 'react';
import { renderToString } from 'react-dom/server';
import { signal, watcher, withContexts } from 'signalium';
import { ContextProvider, useReactive } from 'signalium/react';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext, type CachedQuery } from '../QueryClient.js';
import { NoOpNetworkManager } from '../NetworkManager.js';
import { Entity } from '../proxy.js';
import { t } from '../typeDefs.js';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { useQuery } from '../react/use-query.js';
import { useSuspenseQuery } from '../react/use-suspense-query.js';
import type { GcKeyType } from '../GcManager.js';
import { createMockFetch, sleep } from './utils.js';

// setQueryData parses a raw response with the query's schema and makes the query's first read synchronous.

class Fungible extends Entity {
  __typename = t.typename('Fungible');
  id = t.id;
  name = t.string;
  price = t.optional(t.number);
}

/** `cacheTime: 0` keeps the sync store from ever serving this query, which is what a seed has to beat. */
class GetFungible extends RESTQuery {
  static cache = { cacheTime: 0 };
  path = '/f';
  result = t.entity(Fungible);
  config = { staleTime: 30_000 };
}

class GetFungibleAlwaysStale extends GetFungible {
  config = { staleTime: 0 };
}

class GetFungibleNeverStale extends GetFungible {
  config = { staleTime: Infinity };
}

class GetFungibleByAddress extends RESTQuery {
  static cache = { cacheTime: 0 };
  params = { chainId: t.string, address: t.string };
  path = `/f/${this.params.chainId}/${this.params.address}`;
  result = t.entity(Fungible);
  config = { staleTime: Infinity };
}

class GetFungibleWithOptions extends RESTQuery {
  static cache = { cacheTime: 0 };
  params = { id: t.string, include: t.optional(t.string) };
  path = `/f/${this.params.id}`;
  result = t.entity(Fungible);
  config = { staleTime: Infinity };
}

class GetFungibleStored extends RESTQuery {
  path = '/f';
  result = t.entity(Fungible);
  config = { staleTime: Infinity };
}

/** Served by the store, with a finite `staleTime`, so a record's and a seed's age decide whether it refetches. */
class GetFungibleStoredTimed extends RESTQuery {
  path = '/f';
  result = t.entity(Fungible);
  config = { staleTime: 30_000 };
}

class GetFungibleList extends RESTQuery {
  static cache = { cacheTime: 0 };
  path = '/fs';
  result = { items: t.array(t.entity(Fungible)) };
  config = { staleTime: Infinity };
}

const fungible = (name: string, extra: Record<string, unknown> = {}) => ({
  __typename: 'Fungible',
  id: 'x',
  name,
  ...extra,
});

// A JSON round trip, as the loader's response body takes.
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

type MockFetch = ReturnType<typeof createMockFetch>;

function makeClient(mockFetch: MockFetch, extra: ConstructorParameters<typeof QueryClient>[0] = {}): QueryClient {
  return new QueryClient({
    networkManager: new NoOpNetworkManager(),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    ...extra,
  });
}

function withClient(client: QueryClient, children: React.ReactNode) {
  const props = { contexts: [[QueryClientContext, client]], children } as React.ComponentProps<typeof ContextProvider>;
  return React.createElement(ContextProvider, props);
}

function label(r: { isReady: boolean; value?: { name: string; price?: number } }): string {
  return r.isReady ? `${r.value!.name}:${r.value!.price}` : 'PENDING';
}

function htmlWithUseQuery(client: QueryClient, Query: new () => any, params?: Record<string, unknown>): string {
  function Reader() {
    const r = useQuery(Query, params);
    return React.createElement('div', null, label(r as any));
  }
  return renderToString(withClient(client, React.createElement(Reader)));
}

function htmlWithUseReactive(client: QueryClient, Query: new () => any): string {
  function Reader() {
    const r = useReactive(() => fetchQuery(Query)) as any;
    return React.createElement('div', null, label(r));
  }
  return renderToString(withClient(client, React.createElement(Reader)));
}

/** Activates `read` in a watched context, as a render does, and returns its first result. */
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

/** Reads the query inside a computation, which activates it, and returns its relay. */
function mount<T extends RESTQuery>(client: QueryClient, read: () => ReturnType<typeof fetchQuery<T>>) {
  return activate(client, () => {
    const relay = read();
    void relay.isReady;
    return relay;
  });
}

/** Pins `Date.now()` and nothing else, so timers and microtasks still run. */
function withPinnedClock<T>(now: number, run: () => T): T {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  try {
    return run();
  } finally {
    vi.useRealTimers();
  }
}
describe('QueryClient.setQueryData', () => {
  describe('first read', () => {
    it('renders data with cacheTime 0, and a client seeded the same way renders the same HTML', async () => {
      const serverFetch = createMockFetch();
      serverFetch.get('/f', fungible('FETCHED'));
      const server = makeClient(serverFetch);
      const payload = json(fungible('SEEDED', { price: 1.5 }));
      const fetchedAt = Date.now() - 5_000;

      server.setQueryData(GetFungible, undefined, payload, { updatedAt: fetchedAt });
      const serverHtml = htmlWithUseQuery(server, GetFungible);
      server.destroy();

      const clientFetch = createMockFetch();
      clientFetch.get('/f', fungible('FETCHED'));
      const browser = makeClient(clientFetch);
      browser.setQueryData(GetFungible, undefined, payload, { updatedAt: fetchedAt });
      const clientHtml = htmlWithUseQuery(browser, GetFungible);

      expect(serverHtml).toBe('<div>SEEDED:1.5</div>');
      expect(clientHtml).toBe(serverHtml);

      // 5 s old, 30 s staleTime: fresh.
      await sleep(20);
      expect(serverFetch.calls).toHaveLength(0);
      expect(clientFetch.calls).toHaveLength(0);
      browser.destroy();
    });

    it('renders data under useReactive(() => fetchQuery(...)) too', async () => {
      const mockFetch = createMockFetch();
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungible, undefined, fungible('SEEDED', { price: 2 }));

      expect(htmlWithUseReactive(client, GetFungible)).toBe('<div>SEEDED:2</div>');

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(0);
      client.destroy();
    });

    it('renders pending when nothing was seeded', () => {
      const client = makeClient(createMockFetch());

      expect(htmlWithUseQuery(client, GetFungible)).toBe('<div>PENDING</div>');
      client.destroy();
    });

    it('gives useSuspenseQuery its value, so the fallback is not rendered', async () => {
      const mockFetch = createMockFetch();
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungible, undefined, fungible('SEEDED'));

      function Reader() {
        const r = useSuspenseQuery(GetFungible);
        return React.createElement('div', null, r.value.name);
      }
      const html = renderToString(
        withClient(client, React.createElement(Suspense, { fallback: 'FALLBACK' }, React.createElement(Reader))),
      );

      expect(html).toContain('<div>SEEDED</div>');
      expect(html).not.toContain('FALLBACK');
      await sleep(20);
      expect(mockFetch.calls).toHaveLength(0);
      client.destroy();
    });

    it('is synchronous inside the activating read, before any fetch', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'), { delay: 20 });
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungibleAlwaysStale, undefined, fungible('SEEDED'), { updatedAt: Date.now() - 1_000 });

      const { first, dispose } = activate(client, () => {
        const relay = fetchQuery(GetFungibleAlwaysStale);
        return { isReady: relay.isReady, isPending: relay.isPending, name: relay.value?.name };
      });

      expect(first).toEqual({ isReady: true, isPending: false, name: 'SEEDED' });
      expect(mockFetch.calls).toHaveLength(0);

      dispose();
      client.destroy();
    });

    it('replaces what the store holds, without loading it', async () => {
      const kv = new MemoryPersistentStore();
      const first = createMockFetch();
      first.get('/f', fungible('STORED'));
      const warm = makeClient(first, { store: new SyncQueryStore(kv) });
      const { dispose } = activate(warm, () => fetchQuery(GetFungibleStored).value?.name);
      await sleep(20);
      dispose();
      warm.destroy();
      expect(kv.getAllKeys().length).toBeGreaterThan(0);

      let loads = 0;
      class CountingStore extends SyncQueryStore {
        override loadQuery(...args: Parameters<SyncQueryStore['loadQuery']>): CachedQuery | undefined {
          loads++;
          return super.loadQuery(...args);
        }
      }
      const mockFetch = createMockFetch();
      const client = makeClient(mockFetch, { store: new CountingStore(kv) });
      client.setQueryData(GetFungibleStored, undefined, fungible('SEEDED'));
      const read = activate(client, () => fetchQuery(GetFungibleStored).value?.name);

      // Server and client must agree even when only the client has a store.
      expect(read.first).toBe('SEEDED');
      expect(loads).toBe(0);
      read.dispose();
      client.destroy();
    });

    it('writes the seed to the store like a fetched response', async () => {
      const kv = new MemoryPersistentStore();
      const seeded = makeClient(createMockFetch(), { store: new SyncQueryStore(kv) });
      seeded.setQueryData(GetFungibleStored, undefined, fungible('SEEDED'));
      const read = activate(seeded, () => fetchQuery(GetFungibleStored).value?.name);
      expect(read.first).toBe('SEEDED');
      read.dispose();
      seeded.destroy();

      const mockFetch = createMockFetch();
      const later = makeClient(mockFetch, { store: new SyncQueryStore(kv) });
      const reread = activate(later, () => fetchQuery(GetFungibleStored).value?.name);

      expect(reread.first).toBe('SEEDED');
      await sleep(20);
      expect(mockFetch.calls).toHaveLength(0);
      reread.dispose();
      later.destroy();
    });

    it('falls back to the stored record when the seed does not parse', async () => {
      const kv = new MemoryPersistentStore();
      const first = createMockFetch();
      first.get('/f', fungible('STORED'));
      const warm = makeClient(first, { store: new SyncQueryStore(kv) });
      const { dispose } = activate(warm, () => fetchQuery(GetFungibleStored).value?.name);
      await sleep(20);
      dispose();
      warm.destroy();

      const warn = vi.fn();
      const client = makeClient(createMockFetch(), { store: new SyncQueryStore(kv), log: { warn } });
      client.setQueryData(GetFungibleStored, undefined, { __typename: 'Fungible', id: 'x', name: 42 });
      const read = activate(client, () => fetchQuery(GetFungibleStored).value?.name);

      expect(read.first).toBe('STORED');
      expect(warn.mock.calls.map(c => c[0])).toContain('Failed to apply seeded query data');
      read.dispose();
      client.destroy();
    });
  });

  describe('staleness', () => {
    it('refetches after the first read when the seed is older than staleTime', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED', { price: 9 }));
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungible, undefined, fungible('SEEDED', { price: 1 }), {
        updatedAt: Date.now() - 120_000,
      });

      expect(htmlWithUseQuery(client, GetFungible)).toBe('<div>SEEDED:1</div>');
      expect(mockFetch.calls).toHaveLength(0);

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(1);
      client.destroy();
    });

    it('does not refetch an old seed when staleTime is Infinity', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('SEEDED'), { updatedAt: Date.now() - 120_000 });

      expect(htmlWithUseQuery(client, GetFungibleNeverStale)).toBe('<div>SEEDED:undefined</div>');

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(0);
      client.destroy();
    });

    it('treats a seed without updatedAt as fetched now', async () => {
      const mockFetch = createMockFetch();
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungible, undefined, fungible('SEEDED'));

      htmlWithUseQuery(client, GetFungible);

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(0);
      client.destroy();
    });

    it('starts no refetch when the client is destroyed right after rendering', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungibleAlwaysStale, undefined, fungible('SEEDED'));

      expect(htmlWithUseQuery(client, GetFungibleAlwaysStale)).toBe('<div>SEEDED:undefined</div>');
      client.destroy();

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(0);
    });

    it('treats a seed timestamped ahead of the client clock as fetched just now', async () => {
      // A server clock that runs ahead of the browser's.
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungibleAlwaysStale, undefined, fungible('SEEDED'), { updatedAt: Date.now() + 5_000 });

      expect(htmlWithUseQuery(client, GetFungibleAlwaysStale)).toBe('<div>SEEDED:undefined</div>');

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(1);
      client.destroy();
    });

    it('keeps a seed timestamped ahead of the client clock fresh for the staleTime', async () => {
      const mockFetch = createMockFetch();
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungible, undefined, fungible('SEEDED'), { updatedAt: Date.now() + 5_000 });

      htmlWithUseQuery(client, GetFungible);

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(0);
      client.destroy();
    });

    it.each([0, -1, NaN, Infinity])('ignores updatedAt %s with a warning', async updatedAt => {
      const warn = vi.fn();
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch, { log: { warn } });

      client.setQueryData(GetFungible, undefined, fungible('SEEDED'), { updatedAt });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(htmlWithUseQuery(client, GetFungible)).toBe('<div>PENDING</div>');
      client.destroy();
    });
  });

  describe('repeated and late calls', () => {
    it('keeps the newest seed that has not been read', () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungible, undefined, fungible('NEWER'), { updatedAt: 2_000 });
      client.setQueryData(GetFungible, undefined, fungible('OLDER'), { updatedAt: 1_000 });

      expect(activate(client, () => fetchQuery(GetFungible).value?.name).first).toBe('NEWER');

      const other = makeClient(createMockFetch());
      other.setQueryData(GetFungible, undefined, fungible('OLDER'), { updatedAt: 1_000 });
      other.setQueryData(GetFungible, undefined, fungible('NEWER'), { updatedAt: 2_000 });

      expect(activate(other, () => fetchQuery(GetFungible).value?.name).first).toBe('NEWER');
      client.destroy();
      other.destroy();
    });

    it('updates a mounted reader with newer data and ignores older or equal data', async () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('FIRST'), { updatedAt: 1_000 });
      const seen: string[] = [];
      const { dispose } = activate(client, () => {
        seen.push(fetchQuery(GetFungibleNeverStale).value?.name ?? 'PENDING');
      });

      client.setQueryData(GetFungibleNeverStale, undefined, fungible('NEWER'), { updatedAt: 2_000 });
      await sleep(10);
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('OLDER'), { updatedAt: 500 });
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('SAME'), { updatedAt: 2_000 });
      await sleep(10);

      expect(seen).toEqual(['FIRST', 'NEWER']);
      dispose();
      client.destroy();
    });

    it('leaves nothing behind once the instance has the data', () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('FIRST'), { updatedAt: 1_000 });
      const { dispose } = activate(client, () => fetchQuery(GetFungibleNeverStale).value?.name);
      expect((client as any).seeds.size).toBe(0);

      // An instance that already holds newer data must not store the older seed for a later instance.
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('OLDER'), { updatedAt: 500 });

      expect((client as any).seeds.size).toBe(0);
      dispose();
      client.destroy();
    });

    it('applies to a query that was created but not read yet, on its first read', () => {
      const client = makeClient(createMockFetch());
      const relay = withContexts([[QueryClientContext, client]], () => fetchQuery(GetFungible));
      client.setQueryData(GetFungible, undefined, fungible('SEEDED'));

      expect(activate(client, () => relay.value?.name).first).toBe('SEEDED');
      client.destroy();
    });

    it('keeps a seed set while a fetch is in flight until the response replaces it', async () => {
      let respond!: () => void;
      const gate = new Promise<void>(resolve => (respond = resolve));
      const mockFetch = createMockFetch();
      mockFetch.get('/f', async () => {
        await gate;
        return fungible('FETCHED');
      });
      const client = makeClient(mockFetch);
      const seen: string[] = [];
      const { dispose } = activate(client, () => {
        const relay = fetchQuery(GetFungible);
        seen.push(relay.isReady ? relay.value.name : 'PENDING');
      });
      await sleep(10);
      expect(mockFetch.calls).toHaveLength(1);

      client.setQueryData(GetFungible, undefined, fungible('SEEDED'));
      await sleep(10);
      expect(seen).toEqual(['PENDING', 'SEEDED']);

      respond();
      await sleep(20);

      expect(seen).toEqual(['PENDING', 'SEEDED', 'FETCHED']);
      expect(mockFetch.calls).toHaveLength(1);
      dispose();
      client.destroy();
    });

    it('starts no refetch when it updates a read query with data that is already stale', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch);
      const { dispose } = activate(client, () => fetchQuery(GetFungibleAlwaysStale).value?.name);
      await sleep(20);
      expect(mockFetch.calls).toHaveLength(1);

      client.setQueryData(GetFungibleAlwaysStale, undefined, fungible('SEEDED'), { updatedAt: Date.now() - 1 });
      await sleep(30);

      expect(fetchQuery_(client, GetFungibleAlwaysStale).value!.name).toBe('SEEDED');
      expect(mockFetch.calls).toHaveLength(1);
      dispose();
      client.destroy();
    });

    it('is a no-op after destroy()', () => {
      const client = makeClient(createMockFetch());
      client.destroy();

      expect(() => client.setQueryData(GetFungible, undefined, fungible('SEEDED'))).not.toThrow();
      expect((client as any).seeds.size).toBe(0);
    });

    it('is dropped by destroy()', () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungible, undefined, fungible('SEEDED'));
      expect((client as any).seeds.size).toBe(1);

      client.destroy();

      expect((client as any).seeds.size).toBe(0);
    });

    it('warns in development when it updates a query inside a reactive computation', () => {
      const warn = vi.fn();
      const client = makeClient(createMockFetch(), { log: { warn } });
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('FIRST'), { updatedAt: 1_000 });
      let runs = 0;
      const { dispose } = activate(client, () => {
        fetchQuery(GetFungibleNeverStale).value?.name;
        if (runs++ === 0) {
          client.setQueryData(GetFungibleNeverStale, undefined, fungible('NEWER'), { updatedAt: 2_000 });
        }
      });

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('inside a reactive computation');

      // Outside a computation it stays quiet.
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('LATER'), { updatedAt: 3_000 });
      expect(warn).toHaveBeenCalledTimes(1);
      dispose();
      client.destroy();
    });

    it('does not warn when the call changes nothing, as on every render of a component that seeds', () => {
      const warn = vi.fn();
      const client = makeClient(createMockFetch(), { log: { warn } });
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('FIRST'), { updatedAt: 1_000 });
      const { dispose } = activate(client, () => {
        fetchQuery(GetFungibleNeverStale).value?.name;
        client.setQueryData(GetFungibleNeverStale, undefined, fungible('FIRST'), { updatedAt: 1_000 });
      });

      expect(warn).not.toHaveBeenCalled();
      dispose();
      client.destroy();
    });
  });

  describe('params', () => {
    it('seeds the query with the same params and no other', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f/1/0xb', fungible('FETCHED'));
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungibleByAddress, { chainId: '1', address: '0xa' }, fungible('A'));

      const a = activate(client, () => fetchQuery(GetFungibleByAddress, { chainId: '1', address: '0xa' }).value?.name);
      // Key order does not matter.
      const aReordered = activate(
        client,
        () => fetchQuery(GetFungibleByAddress, { address: '0xa', chainId: '1' } as any).value?.name,
      );
      const b = activate(client, () => fetchQuery(GetFungibleByAddress, { chainId: '1', address: '0xb' }).value?.name);

      expect(a.first).toBe('A');
      expect(aReordered.first).toBe('A');
      expect(b.first).toBeUndefined();
      await sleep(20);
      expect(mockFetch.calls.map(c => c.url)).toEqual(['http://localhost/f/1/0xb']);
      a.dispose();
      aReordered.dispose();
      b.dispose();
      client.destroy();
    });

    it('requires the params the query requires, at compile time', () => {
      const client = makeClient(createMockFetch());

      // @ts-expect-error params are required
      client.setQueryData(GetFungibleByAddress, undefined, fungible('A'));
      // @ts-expect-error `address` is required
      client.setQueryData(GetFungibleByAddress, { chainId: '1' }, fungible('A'));
      client.setQueryData(GetFungible, undefined, fungible('A'));
      client.setQueryData(GetFungibleWithOptions, { id: '1' }, fungible('A'));

      client.destroy();
    });

    it('keys optional params like fetchQuery: omitted and undefined are different queries', () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleWithOptions, { id: '1' }, fungible('OMITTED'));
      client.setQueryData(GetFungibleWithOptions, { id: '1', include: undefined }, fungible('UNDEFINED'));

      const omitted = activate(client, () => fetchQuery(GetFungibleWithOptions, { id: '1' }).value?.name);
      const explicit = activate(
        client,
        () => fetchQuery(GetFungibleWithOptions, { id: '1', include: undefined }).value?.name,
      );

      expect(omitted.first).toBe('OMITTED');
      expect(explicit.first).toBe('UNDEFINED');
      omitted.dispose();
      explicit.dispose();
      client.destroy();
    });

    it('keys Signal params by their current value', () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleWithOptions, { id: signal('1') }, fungible('ONE'));

      const read = activate(client, () => fetchQuery(GetFungibleWithOptions, { id: '1' }).value?.name);

      expect(read.first).toBe('ONE');
      read.dispose();
      client.destroy();
    });

    it('seeds a reader whose params are a Signal, by the value it has at its first read', () => {
      const id = signal('1');
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleWithOptions, { id: '1' }, fungible('ONE'));
      client.setQueryData(GetFungibleWithOptions, { id: '2' }, fungible('TWO'));

      const read = activate(client, () => fetchQuery(GetFungibleWithOptions, { id }).value?.name);

      expect(read.first).toBe('ONE');
      read.dispose();
      client.destroy();
    });

    it('updates a mounted reader whose params are a Signal', async () => {
      const id = signal('1');
      const client = makeClient(createMockFetch());
      const seen: Array<string | undefined> = [];
      const { dispose } = activate(client, () => {
        seen.push(fetchQuery(GetFungibleWithOptions, { id }).value?.name);
      });
      client.setQueryData(GetFungibleWithOptions, { id: '1' }, fungible('ONE'));
      await sleep(10);

      expect(seen).toEqual([undefined, 'ONE']);
      dispose();
      client.destroy();
    });

    it('does not apply a seed when a Signal param changes after the first read', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f/2', fungible('FETCHED'));
      const id = signal('1');
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungibleWithOptions, { id: '1' }, fungible('ONE'));
      client.setQueryData(GetFungibleWithOptions, { id: '2' }, fungible('TWO'));
      const seen: Array<string | undefined> = [];
      const { dispose } = activate(client, () => {
        seen.push(fetchQuery(GetFungibleWithOptions, { id }).value?.name);
      });

      id.value = '2';
      await sleep(30);

      expect(seen[0]).toBe('ONE');
      expect(seen.at(-1)).toBe('FETCHED');
      expect(mockFetch.calls).toHaveLength(1);
      // The seed for id 2 was never read, so it stays until destroy().
      expect((client as any).seeds.size).toBe(1);
      dispose();
      client.destroy();
    });

    it('does not scan the live queries for a query whose params hold no Signal', () => {
      const client = makeClient(createMockFetch());
      const live = activate(client, () => fetchQuery(GetFungible).value?.name);
      const values = vi.spyOn(client.queryInstances, 'values');

      client.setQueryData(GetFungibleByAddress, { chainId: '1', address: '0xa' }, fungible('A'));

      expect(values).not.toHaveBeenCalled();
      values.mockRestore();
      live.dispose();
      client.destroy();
    });

    it('forgets a Signal-param reader once it is collected', () => {
      const client = makeClient(createMockFetch());
      const read = activate(client, () => fetchQuery(GetFungibleWithOptions, { id: signal('1') }).value?.name);
      const tracked = (client as any).signalParamInstances as Set<unknown>;
      expect(tracked.size).toBe(1);
      read.dispose();

      const [key] = [...client.queryInstances.keys()];
      const evict = (client as unknown as { handleEviction: (key: number, type: GcKeyType) => void }).handleEviction;
      evict(key, 0 as GcKeyType);

      expect(tracked.size).toBe(0);
      client.destroy();
    });
  });

  describe('result shapes', () => {
    it('seeds a root entity', () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungible, undefined, fungible('ROOT', { price: 3 }));

      const { first, dispose } = activate(client, () => fetchQuery(GetFungible).value);

      expect(first).toMatchObject({ id: 'x', name: 'ROOT', price: 3 });
      dispose();
      client.destroy();
    });

    it('seeds a plain object, one per params', () => {
      class GetStats extends RESTQuery {
        static cache = { cacheTime: 0 };
        params = { range: t.string };
        path = `/stats/${this.params.range}`;
        result = { count: t.number, label: t.string };
        config = { staleTime: Infinity };
      }
      const client = makeClient(createMockFetch());
      client.setQueryData(GetStats, { range: 'day' }, { count: 1, label: 'day' });
      client.setQueryData(GetStats, { range: 'week' }, { count: 7, label: 'week' });

      const day = activate(client, () => ({ ...fetchQuery(GetStats, { range: 'day' }).value }));
      const week = activate(client, () => ({ ...fetchQuery(GetStats, { range: 'week' }).value }));

      expect(day.first).toMatchObject({ count: 1, label: 'day' });
      expect(week.first).toMatchObject({ count: 7, label: 'week' });
      day.dispose();
      week.dispose();
      client.destroy();
    });

    it('seeds an array of entities held by the result', () => {
      class GetFungibles extends RESTQuery {
        static cache = { cacheTime: 0 };
        path = '/fs';
        result = { items: t.array(t.entity(Fungible)) };
        config = { staleTime: Infinity };
      }
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibles, undefined, {
        items: [
          { __typename: 'Fungible', id: 'a', name: 'A' },
          { __typename: 'Fungible', id: 'b', name: 'B' },
        ],
      });

      const { first, dispose } = activate(client, () => fetchQuery(GetFungibles).value?.items.map(f => f.name));

      expect(first).toEqual(['A', 'B']);
      dispose();
      client.destroy();
    });

    it('shares entities with other queries, nested or not', async () => {
      class GetToken extends RESTQuery {
        static cache = { cacheTime: 0 };
        path = '/token';
        result = { token: t.entity(Fungible), related: t.array(t.entity(Fungible)) };
        config = { staleTime: Infinity };
      }
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED', { price: 5 }));
      const client = makeClient(mockFetch);
      client.setQueryData(GetToken, undefined, {
        token: fungible('SEEDED', { price: 1 }),
        related: [{ __typename: 'Fungible', id: 'y', name: 'Y' }],
      });

      const token = mount(client, () => fetchQuery(GetToken));
      const detail = mount(client, () => fetchQuery(GetFungibleNeverStale));
      await sleep(20);

      // The detail query's fetch updated the entity the seeded query holds.
      const tokenRelay = fetchQuery_(client, GetToken);
      const detailRelay = fetchQuery_(client, GetFungibleNeverStale);
      expect(tokenRelay.value!.token.name).toBe('FETCHED');
      expect(tokenRelay.value!.token).toBe(detailRelay.value);
      expect(tokenRelay.value!.related[0].name).toBe('Y');
      token.dispose();
      detail.dispose();
      client.destroy();
    });

    it('writes the entities of a newer seed for a second query to the first query’s readers', async () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('DETAIL'), { updatedAt: 1_000 });
      const detail = activate(client, () => fetchQuery(GetFungibleNeverStale).value?.name);
      const seen: Array<string | undefined> = [];
      const detailReader = activate(client, () => {
        seen.push(fetchQuery(GetFungibleNeverStale).value?.name);
      });

      client.setQueryData(GetFungibleList, undefined, { items: [fungible('FROM LIST')] }, { updatedAt: 2_000 });
      const listRead = activate(client, () => fetchQuery(GetFungibleList).value?.items.map(f => f.name));
      await sleep(10);

      expect(listRead.first).toEqual(['FROM LIST']);
      expect(seen).toEqual(['DETAIL', 'FROM LIST']);
      detail.dispose();
      detailReader.dispose();
      listRead.dispose();
      client.destroy();
    });

    it('lets an older seed for a second query overwrite an entity a fresher query holds', () => {
      // Newer wins per query, not per entity: the detail seed is the older write, and the list shows it.
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleList, undefined, { items: [fungible('NEW')] }, { updatedAt: 2_000 });
      const list = activate(client, () => fetchQuery(GetFungibleList).value?.items.map(f => f.name));
      expect(list.first).toEqual(['NEW']);

      client.setQueryData(GetFungibleNeverStale, undefined, fungible('OLD'), { updatedAt: 1_000 });
      const detail = activate(client, () => fetchQuery(GetFungibleNeverStale).value?.name);

      expect(detail.first).toBe('OLD');
      expect(fetchQuery_(client, GetFungibleList).value!.items.map((f: { name: string }) => f.name)).toEqual(['OLD']);
      list.dispose();
      detail.dispose();
      client.destroy();
    });

    it('replaces the items of a live array with a newer seed, like a refetch', () => {
      class Item extends Entity {
        __typename = t.typename('Item');
        id = t.id;
        listId = t.string;
        name = t.string;
      }
      class List extends Entity {
        __typename = t.typename('List');
        id = t.id;
        items = t.liveArray(Item, { constraints: { listId: (this as any).id } });
      }
      class GetList extends RESTQuery {
        static cache = { cacheTime: 0 };
        path = '/list';
        result = { list: t.entity(List) };
        config = { staleTime: Infinity };
      }
      const list = (...names: string[]) => ({
        list: {
          __typename: 'List',
          id: '1',
          items: names.map(name => ({ __typename: 'Item', id: name, listId: '1', name })),
        },
      });
      const client = makeClient(createMockFetch());
      client.setQueryData(GetList, undefined, list('A', 'B'), { updatedAt: 1_000 });
      const read = activate(client, () => fetchQuery(GetList).value?.list.items.map(item => item.name));
      expect(read.first).toEqual(['A', 'B']);

      client.setQueryData(GetList, undefined, list('C'), { updatedAt: 2_000 });

      expect(fetchQuery_(client, GetList).value!.list.items.map((item: { name: string }) => item.name)).toEqual(['C']);
      read.dispose();
      client.destroy();
    });
  });

  describe('paginated queries', () => {
    class GetItems extends RESTQuery {
      static cache = { cacheTime: 0 };
      path = '/items';
      result = { items: t.array(t.string), nextPage: t.optional(t.number) };
      fetchNext = { searchParams: { page: this.result.nextPage } };
      config = { staleTime: Infinity };
    }

    it('seeds the first page, and __fetchNext continues from it', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/items', { items: ['c', 'd'] });
      const client = makeClient(mockFetch);
      client.setQueryData(GetItems, undefined, { items: ['a', 'b'], nextPage: 2 });

      const { first, dispose } = mount(client, () => fetchQuery(GetItems));

      expect(first.value!.items).toEqual(['a', 'b']);
      expect(first.value!.__hasNext).toBe(true);
      expect(mockFetch.calls).toHaveLength(0);

      await first.value!.__fetchNext();

      expect(mockFetch.calls).toHaveLength(1);
      expect(mockFetch.calls[0].url).toContain('page=2');
      expect(first.value!.items).toEqual(['c', 'd']);
      expect(first.value!.__hasNext).toBe(false);
      dispose();
      client.destroy();
    });

    it('replaces the pages with a newer first page, like a refetch', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/items', { items: ['c', 'd'] });
      const client = makeClient(mockFetch);
      const base = Date.now();
      client.setQueryData(GetItems, undefined, { items: ['a', 'b'], nextPage: 2 }, { updatedAt: base });
      const { first, dispose } = mount(client, () => fetchQuery(GetItems));
      await first.value!.__fetchNext();
      expect(first.value!.items).toEqual(['c', 'd']);

      client.setQueryData(GetItems, undefined, { items: ['x', 'y'], nextPage: 2 }, { updatedAt: base + 60_000 });

      expect(first.value!.items).toEqual(['x', 'y']);
      expect(first.value!.__hasNext).toBe(true);
      dispose();
      client.destroy();
    });
  });

  describe('invalid data', () => {
    it('falls back to a fetch and warns when the first read finds data that does not parse', async () => {
      const warn = vi.fn();
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch, { log: { warn } });
      client.setQueryData(GetFungible, undefined, { __typename: 'Fungible', id: 'x', name: 42 });

      let read!: ReturnType<typeof mount<GetFungible>>;
      expect(() => {
        read = mount(client, () => fetchQuery(GetFungible));
      }).not.toThrow();

      expect(read.first.isReady).toBe(false);
      expect(warn.mock.calls.map(c => c[0])).toContain('Failed to apply seeded query data');

      await sleep(20);
      expect(mockFetch.calls).toHaveLength(1);
      expect(read.first.value!.name).toBe('FETCHED');
      read.dispose();
      client.destroy();
    });

    it('keeps a mounted reader’s data when newer data does not parse', async () => {
      const warn = vi.fn();
      const client = makeClient(createMockFetch(), { log: { warn } });
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('GOOD'), { updatedAt: 1_000 });
      const { first, dispose } = mount(client, () => fetchQuery(GetFungibleNeverStale));

      expect(() =>
        client.setQueryData(
          GetFungibleNeverStale,
          undefined,
          { __typename: 'Fungible', id: 'x' },
          { updatedAt: 2_000 },
        ),
      ).not.toThrow();

      expect(warn.mock.calls.map(c => c[0])).toContain('Failed to apply seeded query data');
      expect(first.value!.name).toBe('GOOD');

      // The failed write did not move the instance's clock.
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('BETWEEN'), { updatedAt: 1_500 });
      expect(first.value!.name).toBe('BETWEEN');
      dispose();
      client.destroy();
    });
  });

  describe('invalidateQueries', () => {
    it('drops a seed that has not been read', async () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungible, undefined, fungible('SEEDED'));

      client.invalidateQueries([GetFungible]);
      const { first, dispose } = mount(client, () => fetchQuery(GetFungible));

      expect(first.isReady).toBe(false);
      await sleep(20);
      expect(first.value!.name).toBe('FETCHED');
      expect(mockFetch.calls).toHaveLength(1);
      dispose();
      client.destroy();
    });

    it('drops only the seeds a param filter matches', () => {
      const client = makeClient(createMockFetch());
      client.setQueryData(GetFungibleByAddress, { chainId: '1', address: '0xa' }, fungible('ONE'));
      client.setQueryData(GetFungibleByAddress, { chainId: '2', address: '0xa' }, fungible('TWO'));
      client.setQueryData(GetFungible, undefined, fungible('OTHER QUERY'));

      client.invalidateQueries([[GetFungibleByAddress, { chainId: '1' }]]);

      const one = activate(
        client,
        () => fetchQuery(GetFungibleByAddress, { chainId: '1', address: '0xa' }).value?.name,
      );
      const two = activate(
        client,
        () => fetchQuery(GetFungibleByAddress, { chainId: '2', address: '0xa' }).value?.name,
      );
      const other = activate(client, () => fetchQuery(GetFungible).value?.name);

      expect(one.first).toBeUndefined();
      expect(two.first).toBe('TWO');
      expect(other.first).toBe('OTHER QUERY');
      one.dispose();
      two.dispose();
      other.dispose();
      client.destroy();
    });

    it('rejects a seed fetched before the invalidation, and accepts one fetched in its millisecond', () => {
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'), { delay: 50 });
      const client = makeClient(mockFetch);
      client.setQueryData(GetFungibleNeverStale, undefined, fungible('FIRST'), { updatedAt: 1_000 });
      const { first, dispose } = mount(client, () => fetchQuery(GetFungibleNeverStale));

      withPinnedClock(100_000, () => {
        client.invalidateQueries([GetFungibleNeverStale]);

        client.setQueryData(GetFungibleNeverStale, undefined, fungible('BEFORE'), { updatedAt: 99_999 });
        expect(first.value!.name).toBe('FIRST');

        // A default `updatedAt` is `Date.now()`, which an invalidation just before it shares.
        client.setQueryData(GetFungibleNeverStale, undefined, fungible('SAME MS'));
        expect(first.value!.name).toBe('SAME MS');
      });
      dispose();
      client.destroy();
    });

    it('rejects a seed fetched before an invalidation of a query that was created but not read', () => {
      const client = makeClient(createMockFetch());
      const relay = withContexts([[QueryClientContext, client]], () => fetchQuery(GetFungible));

      withPinnedClock(100_000, () => {
        client.invalidateQueries([GetFungible]);
        client.setQueryData(GetFungible, undefined, fungible('STALE'), { updatedAt: 99_999 });
      });

      expect(activate(client, () => relay.value?.name).first).toBeUndefined();
      client.destroy();
    });

    it('accepts a seed fetched in the millisecond of an invalidation of a query that was created but not read', () => {
      const client = makeClient(createMockFetch());
      const relay = withContexts([[QueryClientContext, client]], () => fetchQuery(GetFungible));

      withPinnedClock(100_000, () => {
        client.invalidateQueries([GetFungible]);
        client.setQueryData(GetFungible, undefined, fungible('SAME MS'));
      });

      expect(activate(client, () => relay.value?.name).first).toBe('SAME MS');
      client.destroy();
    });

    it('does not remember an invalidation from before the query existed', () => {
      const client = makeClient(createMockFetch());
      client.invalidateQueries([GetFungible]);

      client.setQueryData(GetFungible, undefined, fungible('OLD'), { updatedAt: Date.now() - 60_000 });

      expect(activate(client, () => fetchQuery(GetFungible).value?.name).first).toBe('OLD');
      client.destroy();
    });
  });

  describe('async stores', () => {
    /** loadQuery resolves when the test opens the gate, like a slow async store, and with what the store held when asked. */
    class GatedStore extends SyncQueryStore {
      private open!: () => void;
      private gate = new Promise<void>(resolve => (this.open = resolve));

      release(): void {
        this.open();
      }

      override loadQuery(...args: Parameters<SyncQueryStore['loadQuery']>): CachedQuery | undefined {
        const record = super.loadQuery(...args);
        return this.gate.then(() => record) as unknown as CachedQuery | undefined;
      }
    }

    /** A store whose record for `Query` was fetched at `storedAt`. */
    function warmStore(Query: new () => RESTQuery, storedAt: number): MemoryPersistentStore {
      const kv = new MemoryPersistentStore();
      const client = makeClient(createMockFetch(), { store: new SyncQueryStore(kv) });
      client.setQueryData(Query, undefined, fungible('STORED'), { updatedAt: storedAt });
      activate(client, () => (fetchQuery(Query) as any).value?.name).dispose();
      client.destroy();
      expect(kv.getAllKeys().length).toBeGreaterThan(0);
      return kv;
    }

    it('is read synchronously although the store has not loaded yet', async () => {
      const store = new GatedStore(warmStore(GetFungibleStored, Date.now() - 1_000));
      const mockFetch = createMockFetch();
      const client = makeClient(mockFetch, { store });
      client.setQueryData(GetFungibleStored, undefined, fungible('SEEDED'));

      const read = activate(client, () => fetchQuery(GetFungibleStored).value?.name);
      expect(read.first).toBe('SEEDED');

      store.release();
      await sleep(20);
      expect(fetchQuery_(client, GetFungibleStored).value!.name).toBe('SEEDED');
      expect(mockFetch.calls).toHaveLength(0);
      read.dispose();
      client.destroy();
    });

    it('keeps a fresh seed fresh when an older stored record loads after it', async () => {
      const store = new GatedStore(warmStore(GetFungibleStoredTimed, Date.now() - 60_000));
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch, { store });
      const read = activate(client, () => fetchQuery(GetFungibleStoredTimed).value?.name);

      // Lands while the store is still loading.
      client.setQueryData(GetFungibleStoredTimed, undefined, fungible('SEEDED'));
      expect(fetchQuery_(client, GetFungibleStoredTimed).value!.name).toBe('SEEDED');
      store.release();
      await sleep(20);

      expect(fetchQuery_(client, GetFungibleStoredTimed).value!.name).toBe('SEEDED');
      expect(mockFetch.calls).toHaveLength(0);
      read.dispose();
      client.destroy();
    });

    it('refetches an old seed when a fresher stored record loads after it', async () => {
      const store = new GatedStore(warmStore(GetFungibleStoredTimed, Date.now()));
      const mockFetch = createMockFetch();
      mockFetch.get('/f', fungible('FETCHED'));
      const client = makeClient(mockFetch, { store });
      const read = activate(client, () => fetchQuery(GetFungibleStoredTimed).value?.name);

      client.setQueryData(GetFungibleStoredTimed, undefined, fungible('SEEDED'), { updatedAt: Date.now() - 60_000 });
      expect(fetchQuery_(client, GetFungibleStoredTimed).value!.name).toBe('SEEDED');
      store.release();
      await sleep(20);

      expect(mockFetch.calls).toHaveLength(1);
      expect(fetchQuery_(client, GetFungibleStoredTimed).value!.name).toBe('FETCHED');
      read.dispose();
      client.destroy();
    });
  });

  describe('scheduling', () => {
    it('starts no timer or microtask for a seed that is never read', () => {
      const client = makeClient(createMockFetch());
      const timeout = vi.spyOn(globalThis, 'setTimeout');
      const interval = vi.spyOn(globalThis, 'setInterval');
      const microtask = vi.spyOn(globalThis, 'queueMicrotask');
      try {
        client.setQueryData(GetFungible, undefined, fungible('SEEDED'));
        client.setQueryData(GetFungible, undefined, fungible('NEWER'), { updatedAt: Date.now() + 1 });
        client.invalidateQueries([GetFungibleByAddress]);

        expect(timeout).not.toHaveBeenCalled();
        expect(interval).not.toHaveBeenCalled();
        expect(microtask).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
      client.destroy();
    });
  });
});

/** The instance's relay, outside any computation. */
function fetchQuery_(client: QueryClient, Query: new () => RESTQuery): any {
  return withContexts([[QueryClientContext, client]], () => (fetchQuery as any)(Query));
}
