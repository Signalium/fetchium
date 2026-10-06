import { bench, describe } from 'vitest';
import { signal, watcher, withContexts } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { RESTQuery } from '../rest/index.js';
import { Entity } from '../proxy.js';
import { fetchQuery } from '../query.js';
import { t } from '../typeDefs.js';

/**
 * What reading a nested, non-entity field of an entity costs: `t.object` and
 * `t.record` values and `t.liveArray` values are handed out through wrapping
 * proxies, so every read goes through a proxy trap. Measured inside a reactive
 * computation (a `component()` render or a `reactive()` function) and outside
 * one. Each case reads 1,000 fields.
 *
 * Run with `npm run bench`.
 */

class Item extends Entity {
  __typename = t.typename('Item');
  id = t.id;
  name = t.string;
}

class Token extends Entity {
  __typename = t.typename('Token');
  id = t.id;
  symbol = t.string;
  price = t.object({ usd: t.number, change: t.object({ h24: t.number }) });
  balances = t.record(t.number);
  items = t.liveArray(Item);
}

class GetToken extends RESTQuery {
  params = { id: t.id };
  path = `/token/${this.params.id}`;
  result = t.entity(Token);
  getConfig() {
    return { retry: 0, gcTime: Infinity };
  }
}

const payload = {
  __typename: 'Token',
  id: '1',
  symbol: 'SOL',
  price: { usd: 150, change: { h24: 2 } },
  balances: { SOL: 5, USDC: 2 },
  items: [
    { __typename: 'Item', id: 'a', name: 'A' },
    { __typename: 'Item', id: 'b', name: 'B' },
  ],
};

const client = new QueryClient({
  store: new SyncQueryStore(new MemoryPersistentStore()),
  adapters: [
    new RESTQueryAdapter({
      fetch: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
      baseUrl: 'http://localhost',
    }),
  ],
});

const query = withContexts([[QueryClientContext, client]], () => fetchQuery(GetToken, { id: '1' }));
const holder = watcher(() => query.value);
holder.addListener(() => {});
await query;

type TokenValue = {
  symbol: string;
  price: { usd: number; change: { h24: number } };
  balances: Record<string, number>;
  items: { length: number }[] & { length: number };
};
const token = query.value as unknown as TokenValue;
const price = token.price;
const balances = token.balances;
const items = token.items;

const N = 1000;
let sink = 0;

/** A computation re-run on every bench iteration, the way a re-render re-runs a `component()`. */
function inComputation(body: () => number) {
  const tick = signal(0);
  const w = watcher(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    tick.value;
    return body();
  });
  w.addListener(() => {});
  return () => {
    tick.value++;
    sink += w.value;
  };
}

describe('nested reads, 1000 per iteration', () => {
  bench('entity field (baseline)', () => {
    for (let i = 0; i < N; i++) sink += token.symbol.length;
  });

  bench('entity -> t.object field', () => {
    for (let i = 0; i < N; i++) sink += token.price.usd;
  });

  bench('held t.object -> field', () => {
    for (let i = 0; i < N; i++) sink += price.usd;
  });

  bench('held t.object -> t.object -> field', () => {
    for (let i = 0; i < N; i++) sink += price.change.h24;
  });

  bench('held t.record -> key', () => {
    for (let i = 0; i < N; i++) sink += balances.SOL;
  });

  bench('held t.liveArray -> length', () => {
    for (let i = 0; i < N; i++) sink += items.length;
  });

  const parentRender = inComputation(() => {
    let s = 0;
    for (let i = 0; i < N; i++) s += token.price.usd;
    return s;
  });
  bench('in a computation: entity -> t.object field', parentRender);

  const childRender = inComputation(() => {
    let s = 0;
    for (let i = 0; i < N; i++) s += price.usd + price.change.h24;
    return s;
  });
  bench('in a computation: held t.object -> fields', childRender);

  const recordRender = inComputation(() => {
    let s = 0;
    for (let i = 0; i < N; i++) s += balances.SOL;
    return s;
  });
  bench('in a computation: held t.record -> key', recordRender);
});

// First reads: a wrapper is created once per nested value and then cached.
class Row extends Entity {
  __typename = t.typename('Row');
  id = t.id;
  meta = t.object({ logo: t.string });
}

class GetRows extends RESTQuery {
  params = { count: t.number };
  path = `/rows/${this.params.count}`;
  result = { rows: t.array(t.entity(Row)) };
  getConfig() {
    return { retry: 0, gcTime: Infinity };
  }
}

async function coldRows(count: number, readNested: boolean) {
  const body = JSON.stringify({
    rows: Array.from({ length: count }, (_, i) => ({ __typename: 'Row', id: `r${i}`, meta: { logo: `l${i}` } })),
  });
  const rowsClient = new QueryClient({
    store: new SyncQueryStore(new MemoryPersistentStore()),
    adapters: [
      new RESTQueryAdapter({
        fetch: (async () =>
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
        baseUrl: 'http://localhost',
      }),
    ],
  });
  const q = withContexts([[QueryClientContext, rowsClient]], () => fetchQuery(GetRows, { count }));
  const w = watcher(() => q.value);
  const stop = w.addListener(() => {});
  await q;
  const rows = (q.value as unknown as { rows: { meta: { logo: string } }[] }).rows;
  for (let i = 0; i < rows.length; i++)
    sink += readNested ? rows[i].meta.logo.length : rows[i].meta === undefined ? 0 : 1;
  stop();
  rowsClient.destroy();
}

describe('cold query, 1000 rows, first read of each row', () => {
  bench('row.meta (wrapper created)', () => coldRows(1000, false));
  bench('row.meta.logo (wrapper created, then read)', () => coldRows(1000, true));
});

// Keep `sink` observable so the reads aren't optimized away.
if (sink === -1) console.log(sink);
