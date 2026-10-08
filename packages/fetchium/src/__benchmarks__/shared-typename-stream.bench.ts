import { bench, describe } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { RESTQuery } from '../rest/index.js';
import { Entity } from '../proxy.js';
import { fetchQuery } from '../query.js';
import { t } from '../typeDefs.js';

// Streamed full updates where list and detail classes share a typename.
// Each list write must keep the detail's fields. Run with `npm run bench`.

const meta = { logo: t.string, website: t.string, tags: t.array(t.string) };

class MarketRow extends Entity {
  __typename = t.typename('Market');
  id = t.id;
  symbol = t.string;
  name = t.string;
  price = t.number;
  change = t.number;
  volume = t.number;
}

class MarketDetail extends Entity {
  __typename = t.typename('Market');
  id = t.id;
  symbol = t.string;
  name = t.string;
  price = t.number;
  change = t.number;
  volume = t.number;
  extraMetadata = t.object(meta);
  categories = t.array(t.string);
}

class PlainRow extends Entity {
  __typename = t.typename('Plain');
  id = t.id;
  symbol = t.string;
  name = t.string;
  price = t.number;
  change = t.number;
  volume = t.number;
}

class GetMarkets extends RESTQuery {
  params = { n: t.number };
  path = `/markets/${this.params.n}`;
  result = { items: t.array(t.entity(MarketRow)) };
  getConfig() {
    return { retry: 0, gcTime: Infinity };
  }
}

class GetMarket extends RESTQuery {
  static cache = { maxCount: 1000 };
  params = { id: t.string };
  path = `/market/${this.params.id}`;
  result = { market: t.entity(MarketDetail) };
  getConfig() {
    return { retry: 0, gcTime: Infinity };
  }
}

class GetPlain extends RESTQuery {
  params = { n: t.number };
  path = `/plain/${this.params.n}`;
  result = { items: t.array(t.entity(PlainRow)) };
  getConfig() {
    return { retry: 0, gcTime: Infinity };
  }
}

const row = (typename: string, i: number, price = 100 + i) => ({
  __typename: typename,
  id: `m-${i}`,
  symbol: `SYM${i}`,
  name: `Market ${i}`,
  price,
  change: 0.5,
  volume: 1000 * i,
});

const detail = (i: number) => ({
  ...row('Market', i),
  extraMetadata: { logo: `logo-${i}.png`, website: `m${i}.example.com`, tags: ['defi', 'x'] },
  categories: ['a', 'b'],
});

function respond(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function client(kv: MemoryPersistentStore, n: number) {
  return new QueryClient({
    store: new SyncQueryStore(kv),
    adapters: [
      new RESTQueryAdapter({
        fetch: (async (url: string) => {
          const path = new URL(url).pathname;
          if (path.startsWith('/market/')) return respond({ market: detail(Number(path.split('-')[1])) });
          if (path.startsWith('/plain/'))
            return respond({ items: Array.from({ length: n }, (_, i) => row('Plain', i)) });
          return respond({ items: Array.from({ length: n }, (_, i) => row('Market', i)) });
        }) as unknown as typeof fetch,
        baseUrl: 'http://localhost',
      }),
    ],
  });
}

async function hold(c: QueryClient, start: () => unknown): Promise<void> {
  let q: any;
  const w = withContexts([[QueryClientContext, c]], () => {
    q = start();
    return watcher(() => q.value);
  });
  w.addListener(() => {});
  await q;
}

const N = 100;
const kv = new MemoryPersistentStore();

const first = client(kv, N);
for (let i = 0; i < N; i++) await hold(first, () => fetchQuery(GetMarket, { id: `m-${i}` }));
first.destroy();

const c = client(kv, N);
await hold(c, () => fetchQuery(GetMarkets, { n: N }));
await hold(c, () => fetchQuery(GetPlain, { n: N }));

let tick = 0;

describe(`streamed full updates, ${N} in-memory list entities`, () => {
  bench('shared typename: one entity, price changes', () => {
    tick++;
    c.applyMutationEvent({ type: 'update', typename: 'Market', data: row('Market', tick % N, tick) });
  });

  bench('single-class typename (control): one entity, price changes', () => {
    tick++;
    c.applyMutationEvent({ type: 'update', typename: 'Plain', data: row('Plain', tick % N, tick) });
  });

  bench(`shared typename: all ${N} entities, price changes`, () => {
    tick++;
    for (let i = 0; i < N; i++)
      c.applyMutationEvent({ type: 'update', typename: 'Market', data: row('Market', i, tick) });
  });

  bench(`single-class typename (control): all ${N} entities, price changes`, () => {
    tick++;
    for (let i = 0; i < N; i++)
      c.applyMutationEvent({ type: 'update', typename: 'Plain', data: row('Plain', i, tick) });
  });

  bench('shared typename: one entity, identical update', () => {
    c.applyMutationEvent({ type: 'update', typename: 'Market', data: row('Market', 7, 107) });
  });
});
