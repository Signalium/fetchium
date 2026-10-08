/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider, component } from 'signalium/react';
import React from 'react';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { RESTQuery } from '../../rest/index.js';
import { fetchQuery } from '../../query.js';
import { createMockFetch, sleep } from '../../__tests__/utils.js';
import { watcher, withContexts } from 'signalium';
import { RESTQueryAdapter } from '../../rest/RESTQueryAdapter.js';
import { useQuery } from '../use-query.js';

// A sync store's cached data shows on the first render, with no loading frame.

class GetFreshItem extends RESTQuery {
  path = '/item';
  result = { name: t.string };
  config = { staleTime: 60_000 };
}

class GetStaleItem extends RESTQuery {
  path = '/item';
  result = { name: t.string };
  config = { staleTime: 0 };
}

let clients: QueryClient[] = [];

afterEach(() => {
  for (const c of clients) c.destroy();
  clients = [];
});

function makeClient(kv: MemoryPersistentStore, mockFetch: ReturnType<typeof createMockFetch>): QueryClient {
  const client = new QueryClient({
    store: new SyncQueryStore(kv),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
  });
  clients.push(client);
  return client;
}

async function seededStore(QueryClass: new () => RESTQuery, name: string): Promise<MemoryPersistentStore> {
  const kv = new MemoryPersistentStore();
  const mockFetch = createMockFetch();
  mockFetch.get('/item', { name });
  const client = makeClient(kv, mockFetch);
  const w = withContexts([[QueryClientContext, client]], () => watcher(() => fetchQuery(QueryClass as any).value));
  const unsub = w.addListener(() => {});
  w.value;
  for (let i = 0; i < 50 && kv.getAllKeys().length === 0; i++) {
    await sleep(10);
  }
  unsub();
  expect(kv.getAllKeys().length).toBeGreaterThan(0);
  return kv;
}

describe('first render with a synchronous store', () => {
  it('useQuery renders fresh cached data on the first render, once', async () => {
    const kv = await seededStore(GetFreshItem, 'cached');
    const mockFetch = createMockFetch();
    const client = makeClient(kv, mockFetch);

    const renders: Array<string | undefined> = [];
    function Item(): React.ReactNode {
      const item = useQuery(GetFreshItem);
      const label = item.isReady ? item.value.name : undefined;
      renders.push(label);
      return <div>{label ?? 'Loading...'}</div>;
    }

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Item />
      </ContextProvider>,
    );

    await expect.element(getByText('cached')).toBeInTheDocument();
    await sleep(50);

    expect(renders[0]).toBe('cached');
    expect(renders).toEqual(['cached']);
    expect(mockFetch.calls).toHaveLength(0);
  });

  it('component() renders stale cached data on the first render, then the refetched data', async () => {
    const kv = await seededStore(GetStaleItem, 'cached');
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { name: 'fresh' }, { delay: 20 });
    const client = makeClient(kv, mockFetch);

    const renders: Array<string | undefined> = [];
    const Item = component(() => {
      const item = fetchQuery(GetStaleItem);
      const label = item.isReady ? item.value.name : undefined;
      renders.push(label);
      return <div>{label ?? 'Loading...'}</div>;
    });

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Item />
      </ContextProvider>,
    );

    await expect.element(getByText('fresh')).toBeInTheDocument();

    expect(renders[0]).toBe('cached');
    expect(renders).not.toContain(undefined);
    expect(mockFetch.calls).toHaveLength(1);
  });
});
