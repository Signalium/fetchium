import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider, PauseSignalsProvider, component } from 'signalium/react';
import React from 'react';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext, type QueryClientConfig } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { RESTQuery } from '../../rest/index.js';
import { fetchQuery } from '../../query.js';
import { createMockFetch, sleep } from '../../__tests__/utils.js';
import { RESTQueryAdapter } from '../../rest/RESTQueryAdapter.js';

/**
 * A screen hidden behind `PauseSignalsProvider` pauses its queries; resuming
 * it reactivates them. With `reactivationGraceMs`, queries whose data is
 * younger than the grace resume without refetching.
 */

class GetItem extends RESTQuery {
  path = '/item';
  result = { n: t.number };
}

let clients: QueryClient[] = [];

afterEach(() => {
  for (const c of clients) c.destroy();
  clients = [];
});

function makeClient(mockFetch: ReturnType<typeof createMockFetch>, config: Partial<QueryClientConfig> = {}) {
  const client = new QueryClient({
    store: new SyncQueryStore(new MemoryPersistentStore()),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    ...config,
  });
  clients.push(client);
  return client;
}

const Item = component(() => {
  const item = fetchQuery(GetItem);
  return <div>{item.isReady ? `n=${item.value.n}` : 'Loading...'}</div>;
});

async function pauseThenResume(client: QueryClient): Promise<void> {
  const tree = (paused: boolean) => (
    <ContextProvider contexts={[[QueryClientContext, client]]}>
      <PauseSignalsProvider value={paused}>
        <Item />
      </PauseSignalsProvider>
    </ContextProvider>
  );

  const { getByText, rerender } = render(tree(false));
  await expect.element(getByText('n=1')).toBeInTheDocument();

  rerender(tree(true));
  await sleep(50);
  rerender(tree(false));
  await sleep(100);
}

describe('resuming a paused screen', () => {
  it('refetches its stale queries by default', async () => {
    const mockFetch = createMockFetch();
    let n = 0;
    mockFetch.get('/item', () => ({ n: ++n }));

    await pauseThenResume(makeClient(mockFetch));
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('skips the refetch for data younger than reactivationGraceMs', async () => {
    const mockFetch = createMockFetch();
    let n = 0;
    mockFetch.get('/item', () => ({ n: ++n }));

    await pauseThenResume(makeClient(mockFetch, { reactivationGraceMs: 15_000 }));
    expect(mockFetch.calls).toHaveLength(1);
  });
});
