import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider } from 'signalium/react';
import { watcher, withContexts } from 'signalium';
import React from 'react';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { Entity } from '../../proxy.js';
import { RESTQuery, RESTQueryAdapter } from '../../rest/index.js';
import { fetchQuery } from '../../query.js';
import { sleep } from '../../__tests__/utils.js';
import { useQuery } from '../index.js';

/**
 * React view of hydrate-in-memory-shape: a screen whose cached query shares
 * an entity with a query already in memory paints its cached value on the
 * first commit (a synchronous store), not a loading frame followed by the
 * network result.
 */

let clients: QueryClient[] = [];
afterEach(() => {
  for (const c of clients) c.destroy();
  clients = [];
});

function makeFetch() {
  const routes = new Map<string, { body: unknown; delay: number }>();
  const fetch = (url: string) => {
    const path = new URL(url).pathname;
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
    set(path: string, body: unknown, delay = 0) {
      routes.set(path, { body, delay });
    },
  };
}

function makeClient(kv: MemoryPersistentStore, f: ReturnType<typeof makeFetch>, warnings: string[] = []) {
  const client = new QueryClient({
    store: new SyncQueryStore(kv),
    adapters: [new RESTQueryAdapter({ fetch: f.fetch as any, baseUrl: 'http://localhost' })],
    log: { warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) },
  } as any);
  clients.push(client);
  return client;
}

async function fetchIn(client: QueryClient, Q: new () => RESTQuery) {
  await withContexts([[QueryClientContext, client]], () => {
    const q = fetchQuery(Q as any);
    const w = watcher(() => q.value);
    w.addListener(() => {});
    return q;
  });
}

class ProductSummary extends Entity {
  __typename = t.typename('RxProduct');
  id = t.id;
  name = t.string;
}
class ProductDetail extends Entity {
  __typename = t.typename('RxProduct');
  id = t.id;
  name = t.string;
  details = t.object({ rating: t.number });
  updatedAt = t.format('date-time');
}
class GetProductList extends RESTQuery {
  path = '/products';
  result = { items: t.array(t.entity(ProductSummary)) };
}
class GetProductDetail extends RESTQuery {
  path = '/product';
  result = { product: t.entity(ProductDetail), label: t.string };
}
class GetProductStamp extends RESTQuery {
  path = '/product-stamp';
  result = { product: t.entity(ProductDetail) };
}

const product = (rating: number) => ({
  __typename: 'RxProduct',
  id: 'p1',
  name: 'P',
  details: { rating },
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('cached first paint over an in-memory entity', () => {
  for (const scenario of ['nothing in memory', 'summary in memory', 'format field in memory'] as const) {
    it(`first commit shows the cached detail (${scenario})`, async () => {
      const kv = new MemoryPersistentStore();
      const f = makeFetch();
      f.set('/product', { product: product(5), label: 'cached' });
      const seedClient = makeClient(kv, f);
      await fetchIn(seedClient, GetProductDetail);
      seedClient.destroy();
      clients = [];

      const warnings: string[] = [];
      const client = makeClient(kv, f, warnings);
      if (scenario === 'summary in memory') {
        f.set('/products', { items: [{ __typename: 'RxProduct', id: 'p1', name: 'P' }] });
        await fetchIn(client, GetProductList);
      } else if (scenario === 'format field in memory') {
        f.set('/product-stamp', { product: product(5) });
        await fetchIn(client, GetProductStamp);
      }
      f.set('/product', { product: product(6), label: 'net' }, 150);

      const renders: string[] = [];
      function Detail(): React.ReactNode {
        const q = useQuery(GetProductDetail);
        const label = q.isReady
          ? `${q.value.label}:${q.value.product.details.rating}:${q.value.product.updatedAt.getUTCFullYear()}`
          : 'loading';
        renders.push(label);
        return <div>{label}</div>;
      }
      const { getByText } = render(
        <ContextProvider contexts={[[QueryClientContext, client]]}>
          <Detail />
        </ContextProvider>,
      );
      await expect.element(getByText('net:6:2026')).toBeInTheDocument();
      await sleep(10);
      expect(warnings).toEqual([]);
      expect(renders[0]).toBe('cached:5:2026');
      expect(renders).not.toContain('loading');
    });
  }
});
