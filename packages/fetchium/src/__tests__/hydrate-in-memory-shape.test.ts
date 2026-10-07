import { describe, it, expect, afterEach, vi } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { AsyncQueryStore, type StoreMessage } from '../stores/async.js';
import { valueKeyFor, refIdsKeyFor, refCountKeyFor } from '../stores/shared.js';
import { hashValue } from 'signalium/utils';
import { sleep } from './utils.js';

/**
 * A persisted query is served from the cache when one of its entities is in
 * memory with data that doesn't fit the query's shape by itself, as long as
 * the cache can fill the gap without serving data older than memory:
 *   A. a required top-level `t.format` field, already parsed in memory;
 *   B. two classes share a typename and the in-memory class lacks a field the
 *      cached query's class requires. The in-memory class's writes must keep
 *      the other class's fields, or even a cold start cannot serve the cache.
 * The negative cases (C) fall back to the network: the cache must never
 * resurrect a value the fresher in-memory entity contradicts.
 */

let clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients) c.destroy();
  clients = [];
});

type Route = { body: unknown; delay: number };
function makeFetch() {
  const routes = new Map<string, Route>();
  const calls: string[] = [];
  const fetch = (url: string) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const route = routes.get(path);
    if (route === undefined) return Promise.reject(new Error(`no route for ${path}`));
    const body = JSON.parse(JSON.stringify(route.body));
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
          }),
        route.delay,
      ),
    );
  };
  return {
    fetch,
    calls,
    set(path: string, body: unknown, delay = 0) {
      routes.set(path, { body, delay });
    },
    count(path: string) {
      return calls.filter(c => c === path).length;
    },
  };
}

function makeClient(kv: MemoryPersistentStore, f: ReturnType<typeof makeFetch>, logs: string[] = []) {
  const client = new QueryClient({
    store: new SyncQueryStore(kv),
    adapters: [new RESTQueryAdapter({ fetch: f.fetch as any, baseUrl: 'http://localhost' })],
    log: {
      warn: (m: unknown, e?: unknown) => logs.push(`warn: ${String(m)} ${e instanceof Error ? e.message : ''}`),
      error: (m: unknown) => logs.push(`error: ${String(m)}`),
    },
  } as any);
  clients.push(client);
  return client;
}

function start<T>(client: QueryClient, fn: () => T): T {
  return withContexts([[QueryClientContext, client]], () => {
    const q = fn();
    const w = watcher(() => (q as any).value);
    w.addListener(() => {});
    return q;
  });
}

function read<T>(fn: () => T): T | string {
  try {
    return fn();
  } catch (e) {
    return `read threw: ${(e as Error).message}`;
  }
}

function recordOf(kv: MemoryPersistentStore, typename: string, id: string): Record<string, unknown> | undefined {
  const raw = kv.getString(valueKeyFor(hashValue([typename, id])));
  return raw === undefined ? undefined : JSON.parse(raw);
}

/** Session boundary: a fresh client over the same kv (an app restart). */
async function session(
  kv: MemoryPersistentStore,
  f: ReturnType<typeof makeFetch>,
  run: (c: QueryClient) => Promise<void>,
) {
  const c = makeClient(kv, f);
  await run(c);
  c.destroy();
  clients = clients.filter(x => x !== c);
}

// ---------------------------------------------------------------------------
// A. Required top-level format field
// ---------------------------------------------------------------------------

class Reading extends Entity {
  __typename = t.typename('Reading');
  id = t.id;
  value = t.number;
  takenAt = t.format('date-time');
}
class GetLatestReading extends RESTQuery {
  path = '/reading/latest';
  result = { reading: t.entity(Reading) };
}
class GetReadingPage extends RESTQuery {
  path = '/reading/page';
  result = { reading: t.entity(Reading), label: t.string };
}
const readingPayload = { __typename: 'Reading', id: 'r1', value: 1, takenAt: '2026-01-01T00:00:00.000Z' };

describe('A. required top-level t.format on an in-memory entity', () => {
  for (const inMemory of [false, true]) {
    it(`cached query is served (entity in memory: ${inMemory})`, async () => {
      const kv = new MemoryPersistentStore();
      const f = makeFetch();
      f.set('/reading/page', { reading: readingPayload, label: 'cached' });
      await session(kv, f, async c => {
        await start(c, () => fetchQuery(GetReadingPage));
      });

      const logs: string[] = [];
      const c2 = makeClient(kv, f, logs);
      f.set('/reading/latest', { reading: { ...readingPayload, value: 2 } });
      const latest = inMemory ? start(c2, () => fetchQuery(GetLatestReading)) : undefined;
      if (latest !== undefined) await latest;

      f.set('/reading/page', { reading: { ...readingPayload, value: 3 }, label: 'net' }, 200);
      const page: any = start(c2, () => fetchQuery(GetReadingPage));
      await sleep(20);
      const early = {
        isReady: page.isReady,
        label: read(() => page.value?.label),
        value: read(() => page.value?.reading.value),
        takenAt: read(() => page.value?.reading.takenAt?.toISOString?.()),
      };
      const latestEarly =
        latest !== undefined ? read(() => (latest as any).value.reading.takenAt.toISOString()) : undefined;
      await sleep(300);

      expect(logs).toEqual([]);
      expect(early.isReady).toBe(true);
      expect(early.label).toBe('cached');
      // In memory is fresher than the record: its value wins.
      expect(early.value).toBe(inMemory ? 2 : 1);
      expect(early.takenAt).toBe('2026-01-01T00:00:00.000Z');
      if (latest !== undefined) expect(latestEarly).toBe('2026-01-01T00:00:00.000Z');
      // The network fetch still happens and wins.
      expect(f.count('/reading/page')).toBe(2);
      expect(page.value.label).toBe('net');
      expect(page.value.reading.value).toBe(3);
    });
  }
});

// ---------------------------------------------------------------------------
// B. Two classes share a typename; the summary class lacks `details`
// ---------------------------------------------------------------------------

class ProductSummary extends Entity {
  __typename = t.typename('Product');
  id = t.id;
  name = t.string;
}
class ProductDetail extends Entity {
  __typename = t.typename('Product');
  id = t.id;
  name = t.string;
  details = t.object({ rating: t.number, tags: t.array(t.string) });
}
class GetProductList extends RESTQuery {
  path = '/products';
  result = { items: t.array(t.entity(ProductSummary)) };
}
class GetProductDetail extends RESTQuery {
  path = '/product';
  result = { product: t.entity(ProductDetail), label: t.string };
}

const detailBody = (rating: number, label: string, name = 'P') => ({
  product: { __typename: 'Product', id: 'p1', name, details: { rating, tags: ['a'] } },
  label,
});
const listBody = (name = 'P') => ({ items: [{ __typename: 'Product', id: 'p1', name }] });

type DetailOutcome = {
  isReady: boolean;
  label: unknown;
  name: unknown;
  rating: unknown;
  listName?: unknown;
  listKeys?: unknown;
  logs: string[];
  finalLabel: unknown;
  finalRating: unknown;
  detailRequests: number;
  recordAfterHydrate: Record<string, unknown> | undefined;
  recordAfterFetch: Record<string, unknown> | undefined;
};

/**
 * Session 1 caches the detail. `before(c, kv)` sets up session 2 up to the
 * moment the detail activates; the detail's network response is delayed so the
 * first read shows whether the cache was served.
 */
async function runDetail(
  kv: MemoryPersistentStore,
  f: ReturnType<typeof makeFetch>,
  before: (c: QueryClient) => Promise<{ list?: any } | undefined>,
): Promise<DetailOutcome> {
  const logs: string[] = [];
  const c = makeClient(kv, f, logs);
  // `before` wraps the list: a QueryPromise is thenable, so an async function returning it bare would unwrap it.
  const list = (await before(c))?.list;
  f.set('/product', detailBody(6, 'net', 'P-net'), 200);
  const requestsBefore = f.count('/product');
  const d: any = start(c, () => fetchQuery(GetProductDetail));
  await sleep(20);
  const out: DetailOutcome = {
    isReady: d.isReady,
    label: read(() => d.value?.label),
    name: read(() => d.value?.product.name),
    rating: read(() => d.value?.product.details?.rating),
    listName: list !== undefined ? read(() => list.value.items[0].name) : undefined,
    listKeys: list !== undefined ? read(() => Object.keys(list.value.items[0]).sort().join(',')) : undefined,
    logs,
    finalLabel: undefined,
    finalRating: undefined,
    detailRequests: 0,
    recordAfterHydrate: recordOf(kv, 'Product', 'p1'),
    recordAfterFetch: undefined,
  };
  await sleep(300);
  out.finalLabel = read(() => d.value?.label);
  out.finalRating = read(() => d.value?.product.details?.rating);
  out.detailRequests = f.count('/product') - requestsBefore;
  out.recordAfterFetch = recordOf(kv, 'Product', 'p1');
  return out;
}

async function seedDetail(kv: MemoryPersistentStore, f: ReturnType<typeof makeFetch>) {
  f.set('/product', detailBody(5, 'cached'));
  await session(kv, f, async c => {
    await start(c, () => fetchQuery(GetProductDetail));
  });
}

/** Seeds the list's cache without disturbing the product record. */
async function seedListCache(kv: MemoryPersistentStore, f: ReturnType<typeof makeFetch>) {
  // Cache the list first, then the detail, so the record on disk is the detail's.
  f.set('/products', listBody());
  await session(kv, f, async c => {
    await start(c, () => fetchQuery(GetProductList));
  });
  await seedDetail(kv, f);
}

function expectServed(o: DetailOutcome, name = 'P') {
  expect(o.logs).toEqual([]);
  expect(o.isReady).toBe(true);
  expect(o.label).toBe('cached');
  expect(o.name).toBe(name);
  expect(o.rating).toBe(5);
  // The network fetch still happens and wins.
  expect(o.detailRequests).toBe(1);
  expect(o.finalLabel).toBe('net');
  expect(o.finalRating).toBe(6);
  expect(o.recordAfterFetch).toMatchObject({ name: 'P-net', details: { rating: 6, tags: ['a'] } });
}

describe('B. shared typename, the in-memory class lacks a field the cached query needs', () => {
  it('B0 control: nothing in memory, the cache is served', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedDetail(kv, f);
    const o = await runDetail(kv, f, async () => undefined);
    expectServed(o);
  });

  it('B1 the summary was hydrated from its own cache (record intact): the cache is served', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedListCache(kv, f);
    f.set('/products', listBody(), 1000); // keep the list's refetch out of the window
    const o = await runDetail(kv, f, async c => {
      const list: any = start(c, () => fetchQuery(GetProductList));
      await sleep(5);
      expect(list.isReady).toBe(true);
      return { list };
    });
    expectServed(o);
    // The list's value is untouched: same name, and the detail-only field does not leak into its shape.
    expect(o.listName).toBe('P');
    expect(o.listKeys).toBe('__typename,id,name');
    // Hydration never writes; the record still has the detail's fields.
    expect(o.recordAfterHydrate).toMatchObject({ name: 'P', details: { rating: 5 } });
  });

  it('B2 the summary was fetched from the network this session: the cache is served', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedDetail(kv, f);
    f.set('/products', listBody());
    const o = await runDetail(kv, f, async c => {
      const list: any = start(c, () => fetchQuery(GetProductList));
      await list;
      return { list };
    });
    expectServed(o);
    expect(o.listName).toBe('P');
    // The summary's write kept the detail's fields on disk.
    expect(o.recordAfterHydrate).toMatchObject({ name: 'P', details: { rating: 5, tags: ['a'] } });
  });

  it('B3 the summary wrote the record in an earlier session: a cold start still serves the detail cache', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedDetail(kv, f);
    f.set('/products', listBody('P2'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetProductList));
    });
    expect(recordOf(kv, 'Product', 'p1')).toMatchObject({ name: 'P2', details: { rating: 5 } });
    const o = await runDetail(kv, f, async () => undefined);
    // The summary's newer name, the detail's own fields.
    expectServed(o, 'P2');
  });

  it('B4 the summary hydrated, then refetched with a change, before the detail opens: served, newer name wins', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedListCache(kv, f);
    f.set('/products', listBody('P3'));
    const o = await runDetail(kv, f, async c => {
      const list: any = start(c, () => fetchQuery(GetProductList));
      for (let i = 0; i < 20 && read(() => list.value?.items[0].name) !== 'P3'; i++) await sleep(5);
      expect(list.value.items[0].name).toBe('P3');
      return { list };
    });
    expectServed(o, 'P3');
    expect(o.listName).toBe('P3');
  });
});

// ---------------------------------------------------------------------------
// C. Negative controls: the cache must not be served
// ---------------------------------------------------------------------------

class ProductSummaryOptional extends Entity {
  __typename = t.typename('Product');
  id = t.id;
  name = t.string;
  details = t.optional(t.object({ rating: t.number, tags: t.array(t.string) }));
}
class GetProductListOptional extends RESTQuery {
  path = '/products-opt';
  result = { items: t.array(t.entity(ProductSummaryOptional)) };
}

class ProductSummaryConflict extends Entity {
  __typename = t.typename('Product');
  id = t.id;
  name = t.string;
  details = t.string;
}
class GetProductListConflict extends RESTQuery {
  path = '/products-conflict';
  result = { items: t.array(t.entity(ProductSummaryConflict)) };
}

class ProductSummaryNested extends Entity {
  __typename = t.typename('Product');
  id = t.id;
  name = t.string;
  details = t.object({ rating: t.number });
}
class GetProductListNested extends RESTQuery {
  path = '/products-nested';
  result = { items: t.array(t.entity(ProductSummaryNested)) };
}

function expectNotServed(o: DetailOutcome) {
  // Never shows the cached detail fields; waits for the network, which then wins.
  expect(o.isReady).toBe(false);
  expect(o.rating === 5).toBe(false);
  expect(o.detailRequests).toBe(1);
  expect(o.finalLabel).toBe('net');
  expect(o.finalRating).toBe(6);
}

describe('C. negative controls: a fresher in-memory value contradicts the cache', () => {
  it('C1 the in-memory class declares the field and the fresh response omitted it: not served', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedDetail(kv, f);
    f.set('/products-opt', { items: [{ __typename: 'Product', id: 'p1', name: 'P' }] });
    const o = await runDetail(kv, f, async c => {
      const list: any = start(c, () => fetchQuery(GetProductListOptional));
      await list;
      return { list };
    });
    expectNotServed(o);
  });

  it('C2 the in-memory class holds the field with another type: not served, the other query keeps its value', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedDetail(kv, f);
    f.set('/products-conflict', { items: [{ __typename: 'Product', id: 'p1', name: 'P', details: 'plain' }] });
    let listRef: any;
    const o = await runDetail(kv, f, async c => {
      const list: any = start(c, () => fetchQuery(GetProductListConflict));
      await list;
      listRef = list;
      return { list };
    });
    expectNotServed(o);
    expect(read(() => listRef.value.items[0].name)).toBe('P-net');
  });

  it('C3 the in-memory nested object lacks a required nested field: not served (nested fill is out of scope)', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    await seedDetail(kv, f);
    f.set('/products-nested', { items: [{ __typename: 'Product', id: 'p1', name: 'P', details: { rating: 9 } }] });
    const o = await runDetail(kv, f, async c => {
      const list: any = start(c, () => fetchQuery(GetProductListNested));
      await list;
      return { list };
    });
    expectNotServed(o);
  });
});

// ---------------------------------------------------------------------------
// D. Writes keep the fields another class declared, without a per-write cost
// ---------------------------------------------------------------------------

/** A SyncQueryStore that counts the record reads made for the kept fields. */
class CountingStore extends SyncQueryStore {
  reads = 0;
  /** Reads that found a record worth parsing. */
  parsed = 0;
  readEntity(entityKey: number) {
    this.reads++;
    const record = super.readEntity(entityKey);
    if (record !== undefined) this.parsed++;
    return record;
  }
}

function makeCountingClient(store: SyncQueryStore, f: ReturnType<typeof makeFetch>) {
  const client = new QueryClient({
    store,
    adapters: [new RESTQueryAdapter({ fetch: f.fetch as any, baseUrl: 'http://localhost' })],
  } as any);
  clients.push(client);
  return client;
}

class Vendor extends Entity {
  __typename = t.typename('Vendor');
  id = t.id;
  name = t.string;
}
class ItemSummary extends Entity {
  __typename = t.typename('Item');
  id = t.id;
  name = t.string;
}
class ItemSummaryOptional extends Entity {
  __typename = t.typename('Item');
  id = t.id;
  name = t.string;
  details = t.optional(t.object({ rating: t.number }));
}
class ItemDetail extends Entity {
  __typename = t.typename('Item');
  id = t.id;
  name = t.string;
  details = t.object({ rating: t.number });
  vendor = t.entity(Vendor);
}
class GetItems extends RESTQuery {
  path = '/items';
  result = { items: t.array(t.entity(ItemSummary)) };
}
class GetItemsOptional extends RESTQuery {
  path = '/items-opt';
  result = { items: t.array(t.entity(ItemSummaryOptional)) };
}
class GetItem extends RESTQuery {
  path = '/item';
  result = { item: t.entity(ItemDetail) };
}
const itemDetail = (vendor: string, rating = 5, name = 'I') => ({
  item: {
    __typename: 'Item',
    id: 'i1',
    name,
    details: { rating },
    vendor: { __typename: 'Vendor', id: vendor, name: vendor },
  },
});
const vendorKey = (id: string) => hashValue(['Vendor', id]);

describe('D. writes keep the fields another class sharing the typename declared', () => {
  it('D1 a typename with one class never reads a record before writing', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/reading/page', { reading: readingPayload, label: 'x' });
    for (let session = 0; session < 2; session++) {
      const store = new CountingStore(kv);
      const c = makeCountingClient(store, f);
      await start(c, () => fetchQuery(GetReadingPage));
      expect(store.reads).toBe(0);
      c.destroy();
    }
  });

  it('D2 a kept field that references an entity keeps that record alive, and a class declaring it releases it', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });

    // The summary fetches in a later session and writes Item:i1: the record
    // keeps `details` and the reference to Vendor:v1, whose record survives.
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItems));
    });
    expect(recordOf(kv, 'Item', 'i1')).toEqual({
      __typename: 'Item',
      id: 'i1',
      name: 'I2',
      details: { rating: 5 },
      vendor: { __entityRef: vendorKey('v1') },
    });
    expect(kv.getString(valueKeyFor(vendorKey('v1')))).toBeDefined();

    // A cold start serves the detail from the cache, vendor included; its
    // fetch then replaces the vendor, and the old vendor's record goes.
    f.set('/item', itemDetail('v2', 6), 100);
    const c = makeClient(kv, f);
    const item: any = start(c, () => fetchQuery(GetItem));
    await sleep(20);
    expect(item.isReady).toBe(true);
    expect(item.value.item.name).toBe('I2');
    expect(item.value.item.vendor.name).toBe('v1');
    await sleep(200);
    expect(item.value.item.vendor.name).toBe('v2');
    expect(recordOf(kv, 'Item', 'i1')).toMatchObject({
      details: { rating: 6 },
      vendor: { __entityRef: vendorKey('v2') },
    });
    expect(kv.getString(valueKeyFor(vendorKey('v1')))).toBeUndefined();
  });

  it('D3 a class that declares the field optional and receives it absent removes it from the record', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });
    f.set('/items-opt', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItemsOptional));
    });
    const record = recordOf(kv, 'Item', 'i1')!;
    expect(record.details).toBeUndefined();
    // `vendor` is declared by the detail class only: kept.
    expect(record.vendor).toEqual({ __entityRef: vendorKey('v1') });
  });

  it('D4 streamed full updates of an in-memory entity read the record at most once', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });

    const store = new CountingStore(kv);
    const c = makeCountingClient(store, f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
    const list: any = start(c, () => fetchQuery(GetItems));
    await list;
    expect(store.reads).toBe(1);

    const itemValueKey = valueKeyFor(hashValue(['Item', 'i1']));
    const getString = kv.getString.bind(kv);
    let recordReads = 0;
    kv.getString = (key: string) => {
      if (key === itemValueKey) recordReads++;
      return getString(key);
    };
    for (let i = 0; i < 50; i++) {
      c.applyMutationEvent({ type: 'update', typename: 'Item', data: { __typename: 'Item', id: 'i1', name: `N${i}` } });
    }
    await sleep(0);
    expect(store.reads).toBe(1);
    expect(recordReads).toBe(0);
    expect(list.value.items[0].name).toBe('N49');
    expect(recordOf(kv, 'Item', 'i1')).toMatchObject({ name: 'N49', details: { rating: 5 } });
  });

  it('D6 an optional field only another class declares is served from the record, not as missing', async () => {
    class NoteSummary extends Entity {
      __typename = t.typename('Note');
      id = t.id;
      title = t.string;
    }
    class NoteDetail extends Entity {
      __typename = t.typename('Note');
      id = t.id;
      title = t.string;
      body = t.optional(t.string);
    }
    class GetNotes extends RESTQuery {
      path = '/notes';
      result = { notes: t.array(t.entity(NoteSummary)) };
    }
    class GetNote extends RESTQuery {
      path = '/note';
      result = { note: t.entity(NoteDetail) };
    }
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/note', { note: { __typename: 'Note', id: 'n1', title: 'T', body: 'cached body' } });
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetNote));
    });
    const c = makeClient(kv, f);
    f.set('/notes', { notes: [{ __typename: 'Note', id: 'n1', title: 'T2' }] });
    await start(c, () => fetchQuery(GetNotes));
    f.set('/note', { note: { __typename: 'Note', id: 'n1', title: 'T3', body: 'net body' } }, 100);
    const note: any = start(c, () => fetchQuery(GetNote));
    await sleep(20);
    expect(note.isReady).toBe(true);
    expect(note.value.note.title).toBe('T2');
    expect(note.value.note.body).toBe('cached body');
    await sleep(200);
    expect(note.value.note.body).toBe('net body');
  });

  it('D7 an event-built entity a cached list fills in keeps the other class fields at its next writes', async () => {
    class Shelf extends Entity {
      __typename = t.typename('Shelf');
      id = t.id;
      top = t.entity(ItemSummary);
    }
    class GetShelf extends RESTQuery {
      path = '/shelf';
      result = { shelf: t.entity(Shelf) };
    }
    const summary = (id: string, name: string) => ({ __typename: 'Item', id, name });
    const shelfEvent = (name: string) => ({
      type: 'update' as const,
      typename: 'Shelf',
      data: { __typename: 'Shelf', id: 's1', top: summary('i1', name) },
    });
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    // The list is cached with Item:i1, then the detail writes the record.
    f.set('/items', { items: [summary('i1', 'I')] });
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItems));
      await start(c, () => fetchQuery(GetItem));
    });

    const c = makeClient(kv, f);
    f.set('/shelf', { shelf: { __typename: 'Shelf', id: 's1', top: summary('i2', 'J') } });
    await start(c, () => fetchQuery(GetShelf));
    // Item:i1 enters memory from a streamed event, then the cached list fills it in.
    c.applyMutationEvent(shelfEvent('E1'));
    f.set('/items', { items: [summary('i1', 'L')] }, 50);
    const list: any = start(c, () => fetchQuery(GetItems));
    await sleep(10);
    expect(list.isReady).toBe(true);
    const kept = { details: { rating: 5 }, vendor: { __entityRef: vendorKey('v1') } };
    c.applyMutationEvent(shelfEvent('E2'));
    expect(recordOf(kv, 'Item', 'i1')).toEqual({ __typename: 'Item', id: 'i1', name: 'E2', ...kept });
    await sleep(100);
    expect(recordOf(kv, 'Item', 'i1')).toEqual({ __typename: 'Item', id: 'i1', name: 'L', ...kept });
  });

  it('D8 a failed record read is retried at the next write, so the other class fields are kept', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });

    class FlakyReadStore extends SyncQueryStore {
      failNext = true;
      readEntity(entityKey: number) {
        if (this.failNext) {
          this.failNext = false;
          throw new Error('read failed');
        }
        return super.readEntity(entityKey);
      }
    }
    class GetFirst extends RESTQuery {
      path = '/first';
      result = { items: t.array(t.entity(ItemSummary)) };
    }
    class GetSecond extends RESTQuery {
      path = '/second';
      result = { items: t.array(t.entity(ItemSummary)) };
    }
    f.set('/first', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
    f.set('/second', { items: [{ __typename: 'Item', id: 'i1', name: 'I3' }] });
    const c = makeCountingClient(new FlakyReadStore(kv), f);

    await Promise.resolve(start(c, () => fetchQuery(GetFirst))).catch(() => {});
    await start(c, () => fetchQuery(GetSecond));
    expect(recordOf(kv, 'Item', 'i1')).toMatchObject({ name: 'I3', details: { rating: 5 } });
  });

  it('D9 a failed async write over a surviving record keeps the other class fields at the next write', async () => {
    const data = new Map<string, unknown>();
    let failNextWriteOf: string | undefined;
    const delegate = {
      has: async (k: string) => data.has(k),
      getString: async (k: string) => data.get(k) as string | undefined,
      setString: async (k: string, v: string) => {
        if (k === failNextWriteOf) {
          failNextWriteOf = undefined;
          throw new Error('write failed');
        }
        data.set(k, v);
      },
      getNumber: async (k: string) => data.get(k) as number | undefined,
      setNumber: async (k: string, v: number) => void data.set(k, v),
      getBuffer: async (k: string) => data.get(k) as Uint32Array | undefined,
      setBuffer: async (k: string, v: Uint32Array) => void data.set(k, v),
      delete: async (k: string) => void data.delete(k),
      getAllKeys: async () => [...data.keys()],
    };
    const writerStore = () =>
      new AsyncQueryStore({
        isWriter: true,
        delegate,
        connect: handleMessage => ({ sendMessage: msg => handleMessage(msg) }),
      });
    const drain = async (store: AsyncQueryStore) => {
      for (let i = 0; i < 500 && !store.isSettled(); i++) await sleep(2);
    };
    const record = () => JSON.parse(data.get(valueKeyFor(hashValue(['Item', 'i1']))) as string);
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I' }] });

    // Both classes write i1 in the first session, so the record holds the detail fields.
    const first = writerStore();
    const c1 = makeCountingClient(first as any, f);
    await start(c1, () => fetchQuery(GetItem));
    await start(c1, () => fetchQuery(GetItems));
    await drain(first);
    c1.destroy();

    // Next session: only the summary class, hydrated from its cache over that record.
    const second = writerStore();
    const c2 = makeCountingClient(second as any, f);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await start(c2, () => fetchQuery(GetItems));
      await drain(second);
      const update = (name: string) =>
        c2.applyMutationEvent({ type: 'update', typename: 'Item', data: { __typename: 'Item', id: 'i1', name } });

      failNextWriteOf = valueKeyFor(hashValue(['Item', 'i1']));
      update('I2');
      await drain(second);
      expect(record()).toMatchObject({ name: 'I', details: { rating: 5 } });

      update('I3');
      await drain(second);
      expect(record()).toMatchObject({ name: 'I3', details: { rating: 5 } });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('D5 the stores write the kept fields with the record, the async writer included', async () => {
    const kv = new MemoryPersistentStore();
    new SyncQueryStore(kv).saveEntity(7, { id: 'a', name: 'n' }, undefined, '"extra":{"x":1}');
    expect(JSON.parse(kv.getString(valueKeyFor(7))!)).toEqual({ id: 'a', name: 'n', extra: { x: 1 } });

    const delegate = new Map<string, unknown>();
    const asyncDelegate = {
      has: async (k: string) => delegate.has(k),
      getString: async (k: string) => delegate.get(k) as string | undefined,
      setString: async (k: string, v: string) => void delegate.set(k, v),
      getNumber: async (k: string) => delegate.get(k) as number | undefined,
      setNumber: async (k: string, v: number) => void delegate.set(k, v),
      getBuffer: async (k: string) => delegate.get(k) as Uint32Array | undefined,
      setBuffer: async (k: string, v: Uint32Array) => void delegate.set(k, v),
      delete: async (k: string) => void delegate.delete(k),
      getAllKeys: async () => [...delegate.keys()],
    };
    let toWriter: ((msg: StoreMessage) => void) | undefined;
    const writer = new AsyncQueryStore({
      isWriter: true,
      delegate: asyncDelegate,
      connect: handleMessage => {
        toWriter = handleMessage;
        return { sendMessage: () => {} };
      },
    });
    const reader = new AsyncQueryStore({
      isWriter: false,
      connect: () => ({ sendMessage: msg => toWriter!(msg) }),
    });
    reader.saveEntity(8, { id: 'b', name: 'n' }, new Set([9]), '"extra":{"__entityRef":9}');
    for (let i = 0; i < 50 && !writer.isSettled(); i++) await sleep(1);
    await sleep(1);
    expect(JSON.parse(delegate.get(valueKeyFor(8)) as string)).toEqual({
      id: 'b',
      name: 'n',
      extra: { __entityRef: 9 },
    });
  });
});

class Part extends Entity {
  __typename = t.typename('Part');
  id = t.id;
  name = t.string;
}
class GizmoRow extends Entity {
  __typename = t.typename('Gizmo');
  id = t.id;
  name = t.string;
  maker = t.entity(Part);
}
class GizmoDetail extends Entity {
  __typename = t.typename('Gizmo');
  id = t.id;
  name = t.string;
  maker = t.entity(Part);
  parts = t.array(t.entity(Part));
}
class GetGizmos extends RESTQuery {
  path = '/gizmos';
  result = { items: t.array(t.entity(GizmoRow)) };
}
class GetGizmo extends RESTQuery {
  path = '/gizmo';
  result = { item: t.entity(GizmoDetail) };
}
const part = (id: string) => ({ __typename: 'Part', id, name: id });
const row = (name: string) => ({ __typename: 'Gizmo', id: 'g1', name, maker: part('m1') });
const partKey = (id: string) => hashValue(['Part', id]);

describe('F. references and records the other class holds', () => {
  /** The summary in memory from the network, then the detail fetched over the same entity. */
  async function listThenDetail(kv: MemoryPersistentStore, f: ReturnType<typeof makeFetch>) {
    const c = makeClient(kv, f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I' }] });
    const list: any = start(c, () => fetchQuery(GetItems));
    await list;
    f.set('/item', itemDetail('v1'));
    const item: any = start(c, () => fetchQuery(GetItem));
    await item;
    return { c, list, item };
  }

  it('F1 a summary refetch over an entity the detail holds keeps the detail child referenced, on disk and after a restart', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    const { c, list, item } = await listThenDetail(kv, f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
    await list.value.__refetch();

    expect(item.value.item.vendor.name).toBe('v1');
    expect(recordOf(kv, 'Item', 'i1')).toEqual({
      __typename: 'Item',
      id: 'i1',
      name: 'I2',
      details: { rating: 5 },
      vendor: { __entityRef: vendorKey('v1') },
    });
    expect(Array.from(kv.getBuffer(refIdsKeyFor(hashValue(['Item', 'i1']))) ?? [])).toEqual([vendorKey('v1')]);
    expect(recordOf(kv, 'Vendor', 'v1')).toEqual({ __typename: 'Vendor', id: 'v1', name: 'v1' });
    c.destroy();
    clients = clients.filter(x => x !== c);

    f.set('/item', itemDetail('v1', 6, 'net'), 100);
    const cold = makeClient(kv, f);
    const served: any = start(cold, () => fetchQuery(GetItem));
    await sleep(20);
    expect(served.isReady).toBe(true);
    expect(served.value.item.vendor.name).toBe('v1');
  });

  it('F2 after a summary refetch, an update of the detail child still reaches the detail', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    const { c, list, item } = await listThenDetail(kv, f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
    await list.value.__refetch();

    c.applyMutationEvent({ type: 'update', typename: 'Vendor', data: { __typename: 'Vendor', id: 'v1', name: 'w1' } });
    await sleep(0);
    expect(item.value.item.vendor.name).toBe('w1');
    expect(recordOf(kv, 'Vendor', 'v1')).toMatchObject({ name: 'w1' });
  });

  it('F3 a summary fetched over records without detail fields reads each record once and writes the fetched fields', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    // The detail class registered and wrote i1; i2 and i3 hold summary fields only.
    f.set('/item', itemDetail('v1'));
    f.set('/items', {
      items: [
        { __typename: 'Item', id: 'i2', name: 'J' },
        { __typename: 'Item', id: 'i3', name: 'K' },
      ],
    });
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
      await start(c, () => fetchQuery(GetItems));
    });

    const store = new CountingStore(kv);
    const c = makeCountingClient(store, f);
    await start(c, () => fetchQuery(GetItem));
    f.set('/other-items', {
      items: [
        { __typename: 'Item', id: 'i1', name: 'I2' },
        { __typename: 'Item', id: 'i2', name: 'J2' },
        { __typename: 'Item', id: 'i3', name: 'K2' },
      ],
    });
    const before = { reads: store.reads, parsed: store.parsed };
    // A query with no cache, so i2 and i3 are new in memory; i1 is the detail's.
    class GetOtherItems extends RESTQuery {
      path = '/other-items';
      result = { items: t.array(t.entity(ItemSummary)) };
    }
    await start(c, () => fetchQuery(GetOtherItems));
    // One read per entity new in memory (i2, i3), at its first write.
    expect({ reads: store.reads - before.reads, parsed: store.parsed - before.parsed }).toEqual({
      reads: 2,
      parsed: 2,
    });
    expect(recordOf(kv, 'Item', 'i2')).toEqual({ __typename: 'Item', id: 'i2', name: 'J2' });
    expect(recordOf(kv, 'Item', 'i1')).toMatchObject({ name: 'I2', details: { rating: 5 } });
  });

  it('F6 after a restart, a detail class registered after a summary refetch keeps its children referenced through the next one', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/gizmo', { item: { ...row('G'), parts: [part('p1'), part('p2')] } });
    // Session 1 remembers the detail's field names.
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetGizmo));
    });

    // Session 2: the summary refetches before the detail class registers, so
    // the detail adds no field name the store did not already know.
    const c = makeClient(kv, f);
    f.set('/gizmos', { items: [row('A')] });
    const list: any = start(c, () => fetchQuery(GetGizmos));
    await list;
    f.set('/gizmos', { items: [row('B')] });
    await list.value.__refetch();
    const item: any = start(c, () => fetchQuery(GetGizmo));
    await item;
    await sleep(10);
    f.set('/gizmos', { items: [row('C')] });
    await list.value.__refetch();

    expect(item.value.item.parts.map((p: any) => p.name)).toEqual(['p1', 'p2']);
    expect(new Set(kv.getBuffer(refIdsKeyFor(hashValue(['Gizmo', 'g1']))) ?? [])).toEqual(
      new Set([partKey('m1'), partKey('p1'), partKey('p2')]),
    );
    c.applyMutationEvent({ type: 'update', typename: 'Part', data: { ...part('p1'), name: 'q1' } });
    await sleep(0);
    expect(item.value.item.parts[0].name).toBe('q1');
  });

  it('F7 a summary refetch that changes nothing still drops the reference a streamed update replaced', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    const c = makeClient(kv, f);
    f.set('/gizmos', { items: [row('A')] });
    const list: any = start(c, () => fetchQuery(GetGizmos));
    await list;
    f.set('/gizmo', { item: { ...row('A'), parts: [part('p1')] } });
    const item: any = start(c, () => fetchQuery(GetGizmo));
    await item;
    // Two full payloads count every reference, then an update replaces the maker.
    await list.value.__refetch();
    c.applyMutationEvent({
      type: 'update',
      typename: 'Gizmo',
      data: { __typename: 'Gizmo', id: 'g1', maker: part('m2') },
    });
    await sleep(0);
    f.set('/gizmos', { items: [{ ...row('A'), maker: part('m2') }] });
    await list.value.__refetch();

    expect(list.value.items[0].maker.name).toBe('m2');
    expect(new Set(kv.getBuffer(refIdsKeyFor(hashValue(['Gizmo', 'g1']))) ?? [])).toEqual(
      new Set([partKey('m2'), partKey('p1')]),
    );
    expect(c.entityMap.getEntity(partKey('m1'))).toBeUndefined();
  });

  it('F4 a summary hydrated from its cache over a detail record reads the record again at its first write, not holding it until then', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I' }] });
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
      await start(c, () => fetchQuery(GetItems));
    });

    const store = new CountingStore(kv);
    const c = makeCountingClient(store, f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I' }] }, 1000);
    const list: any = start(c, () => fetchQuery(GetItems));
    await sleep(5);
    expect(list.isReady).toBe(true);
    const instance = (c as any).entityMap.getEntity(hashValue(['Item', 'i1']));
    expect(instance._storedRecord).toBeUndefined();
    expect(store.reads).toBe(0);

    c.applyMutationEvent({ type: 'update', typename: 'Item', data: { __typename: 'Item', id: 'i1', name: 'U' } });
    c.applyMutationEvent({ type: 'update', typename: 'Item', data: { __typename: 'Item', id: 'i1', name: 'V' } });
    expect({ reads: store.reads, parsed: store.parsed }).toEqual({ reads: 1, parsed: 1 });
    expect(recordOf(kv, 'Item', 'i1')).toEqual({
      __typename: 'Item',
      id: 'i1',
      name: 'V',
      details: { rating: 5 },
      vendor: { __entityRef: vendorKey('v1') },
    });
  });

  it('F5 in a store an earlier release wrote, a summary hydrated from its cache keeps the detail fields under a streamed update', async () => {
    let kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I' }] });
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
      await start(c, () => fetchQuery(GetItems));
    });
    // Reopened without the field names, as a release that did not remember them left it.
    const copy = new MemoryPersistentStore();
    for (const k of kv.getAllKeys()) {
      if (k.startsWith('sq:meta:')) continue;
      const v = kv.getString(k) ?? kv.getNumber(k) ?? kv.getBuffer(k);
      if (typeof v === 'string') copy.setString(k, v);
      else if (typeof v === 'number') copy.setNumber(k, v);
      else if (v !== undefined) copy.setBuffer(k, v);
    }
    kv = copy;

    const c = makeClient(kv, f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I' }] }, 1000);
    const list: any = start(c, () => fetchQuery(GetItems));
    await sleep(5);
    expect(list.isReady).toBe(true);
    c.applyMutationEvent({ type: 'update', typename: 'Item', data: { __typename: 'Item', id: 'i1', name: 'U' } });
    expect(recordOf(kv, 'Item', 'i1')).toEqual({
      __typename: 'Item',
      id: 'i1',
      name: 'U',
      details: { rating: 5 },
      vendor: { __entityRef: vendorKey('v1') },
    });
  });
});

describe('E. what the store remembers about the other class, and for how long', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('E1 a cache wiped with clear() does not get the other class fields back from memory', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });

    // The summary keeps the detail's fields of Item:i1 in memory; then the
    // app wipes the cache (an account switch) and the summary refetches.
    const store = new SyncQueryStore(kv);
    const c = makeCountingClient(store, f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
    const list: any = start(c, () => fetchQuery(GetItems));
    await list;
    expect(recordOf(kv, 'Item', 'i1')).toMatchObject({ details: { rating: 5 } });

    store.clear();
    expect(kv.getAllKeys().filter(k => k.startsWith('sq:doc:'))).toEqual([]);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I3' }] });
    await list.value.__refetch();

    expect(list.value.items[0].name).toBe('I3');
    expect(recordOf(kv, 'Item', 'i1')).toEqual({ __typename: 'Item', id: 'i1', name: 'I3' });
    expect(kv.getBuffer(refIdsKeyFor(hashValue(['Item', 'i1'])))).toBeUndefined();
    expect(kv.getNumber(refCountKeyFor(vendorKey('v1')))).toBeUndefined();
  });

  it('E2 a field name no class has declared for 30 days is forgotten', async () => {
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(t0);
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });

    /** A list session at `at`, in a new app process (a store over a copy of the kv knows nothing yet). */
    const listSession = async (at: number): Promise<number> => {
      now.mockReturnValue(at);
      const copy = new MemoryPersistentStore();
      for (const k of kv.getAllKeys()) {
        const v = kv.getString(k) ?? kv.getNumber(k) ?? kv.getBuffer(k);
        if (typeof v === 'string') copy.setString(k, v);
        else if (typeof v === 'number') copy.setNumber(k, v);
        else if (v !== undefined) copy.setBuffer(k, v);
      }
      const store = new CountingStore(copy);
      const c = makeCountingClient(store, f);
      f.set('/items', { items: [{ __typename: 'Item', id: 'i1', name: 'I2' }] });
      await start(c, () => fetchQuery(GetItems));
      c.destroy();
      return store.reads;
    };

    // Within 30 days the detail's names are known: the summary's first write keeps its fields.
    expect(await listSession(t0 + 29 * day)).toBe(1);
    // Past 30 days the names are forgotten: the summary writes without reading.
    expect(await listSession(t0 + 31 * day)).toBe(0);
  });

  it('E3 a typename with one class: an event carrying every field writes the record whole, without a merge', async () => {
    const kv = new MemoryPersistentStore();
    // clear() makes the field names cover every record (otherwise that takes
    // 30 days; see E5).
    new SyncQueryStore(kv).clear();
    const f = makeFetch();
    f.set('/reading/latest', { reading: readingPayload });
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetLatestReading));
    });
    const store = new SyncQueryStore(kv);
    const c = makeCountingClient(store, f);
    f.set('/reading/page', { reading: { ...readingPayload, id: 'r2' }, label: 'x' });
    await start(c, () => fetchQuery(GetReadingPage));
    const merges = vi.spyOn(store, 'mergeEntity');
    const saves = vi.spyOn(store, 'saveEntity');
    c.applyMutationEvent({ type: 'update', typename: 'Reading', data: { ...readingPayload, value: 2 } });
    expect(merges).not.toHaveBeenCalled();
    expect(saves.mock.calls.map(call => call[0])).toEqual([hashValue(['Reading', 'r1'])]);
    expect(recordOf(kv, 'Reading', 'r1')).toMatchObject({ value: 2 });
  });

  it('E5 records an earlier release wrote keep the other class fields under such events until the names cover them', async () => {
    const day = 24 * 60 * 60 * 1000;
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(t0);
    let kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });
    /** The kv reopened by a new app process. `stripMeta` drops `sq:meta:` keys, as a release without field names left it. */
    const reopen = (stripMeta: boolean) => {
      const copy = new MemoryPersistentStore();
      for (const k of kv.getAllKeys()) {
        if (stripMeta && k.startsWith('sq:meta:')) continue;
        const v = kv.getString(k) ?? kv.getNumber(k) ?? kv.getBuffer(k);
        if (typeof v === 'string') copy.setString(k, v);
        else if (typeof v === 'number') copy.setNumber(k, v);
        else if (v !== undefined) copy.setBuffer(k, v);
      }
      kv = copy;
    };
    /** A session that registers the summary only, then streams an update carrying every summary field of Item:i1. */
    const listSession = async (at: number, name: string) => {
      now.mockReturnValue(at);
      const store = new SyncQueryStore(kv);
      const c = makeCountingClient(store, f);
      f.set('/items', { items: [{ __typename: 'Item', id: 'i2', name: 'J' }] });
      await start(c, () => fetchQuery(GetItems));
      const merges = vi.spyOn(store, 'mergeEntity');
      const saves = vi.spyOn(store, 'saveEntity');
      c.applyMutationEvent({ type: 'update', typename: 'Item', data: { __typename: 'Item', id: 'i1', name } });
      c.destroy();
      clients = clients.filter(x => x !== c);
      return {
        merged: merges.mock.calls.length,
        savedWhole: saves.mock.calls.some(call => call[0] === hashValue(['Item', 'i1'])),
      };
    };
    const kept = { details: { rating: 5 }, vendor: { __entityRef: vendorKey('v1') } };

    // The first session after the upgrade, and the next one (whose names are the summary's only), merge.
    const hour = 60 * 60 * 1000;
    reopen(true);
    expect(await listSession(t0 + hour, 'U1')).toEqual({ merged: 1, savedWhole: false });
    expect(recordOf(kv, 'Item', 'i1')).toEqual({ __typename: 'Item', id: 'i1', name: 'U1', ...kept });
    reopen(false);
    expect(await listSession(t0 + 2 * hour, 'U2')).toEqual({ merged: 1, savedWhole: false });
    expect(recordOf(kv, 'Item', 'i1')).toEqual({ __typename: 'Item', id: 'i1', name: 'U2', ...kept });
    // 30 days after the store started remembering names: written whole.
    reopen(false);
    kv.setNumber('sq:meta:fieldsSince', t0 + 3 * hour - 30 * day);
    expect(await listSession(t0 + 3 * hour, 'U3')).toEqual({ merged: 0, savedWhole: true });

    // A store without `fieldsSince` counts from now, empty or not, rather than
    // scan every key at startup.
    const fresh = new MemoryPersistentStore();
    const scans = vi.spyOn(fresh, 'getAllKeys');
    expect(new SyncQueryStore(fresh).entityFieldNamesComplete()).toBe(false);
    expect(scans).not.toHaveBeenCalled();
    const upgraded = new MemoryPersistentStore();
    upgraded.setString('sq:doc:value:1', '{}');
    const upgradedScans = vi.spyOn(upgraded, 'getAllKeys');
    expect(new SyncQueryStore(upgraded).entityFieldNamesComplete()).toBe(false);
    expect(upgradedScans).not.toHaveBeenCalled();
    // One that clear() emptied writes such events whole.
    reopen(true);
    const store = new SyncQueryStore(kv);
    expect(store.entityFieldNamesComplete()).toBe(false);
    store.clear();
    expect(store.entityFieldNamesComplete()).toBe(true);
    reopen(false);
    expect(new SyncQueryStore(kv).entityFieldNamesComplete()).toBe(true);
  });

  it('E4 a store that does not remember field names merges such an event, keeping fields of a class it has not seen', async () => {
    class NoFieldNamesStore extends SyncQueryStore {}
    (NoFieldNamesStore.prototype as any).getEntityFieldNames = undefined;
    (NoFieldNamesStore.prototype as any).addEntityFieldNames = undefined;
    const kv = new MemoryPersistentStore();
    const f = makeFetch();
    f.set('/item', itemDetail('v1'));
    await session(kv, f, async c => {
      await start(c, () => fetchQuery(GetItem));
    });
    const c = makeCountingClient(new NoFieldNamesStore(kv), f);
    f.set('/items', { items: [{ __typename: 'Item', id: 'i2', name: 'J' }] });
    await start(c, () => fetchQuery(GetItems));
    c.applyMutationEvent({ type: 'update', typename: 'Item', data: { __typename: 'Item', id: 'i1', name: 'I2' } });
    expect(recordOf(kv, 'Item', 'i1')).toEqual({
      __typename: 'Item',
      id: 'i1',
      name: 'I2',
      details: { rating: 5 },
      vendor: { __entityRef: vendorKey('v1') },
    });
  });
});
