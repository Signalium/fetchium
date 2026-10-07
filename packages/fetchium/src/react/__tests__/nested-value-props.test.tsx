import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider, component } from 'signalium/react';
import { hashValue } from 'signalium/utils';
import React from 'react';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { Entity } from '../../proxy.js';
import { RESTQuery } from '../../rest/index.js';
import { fetchQuery } from '../../query.js';
import { createMockFetch, sleep } from '../../__tests__/utils.js';
import { RESTQueryAdapter } from '../../rest/RESTQueryAdapter.js';

// A nested value prop keeps its identity when merged in place. A `component()`
// child that skips re-rendering for identical props updates through its own reads.
describe('component() child given a nested entity value as a prop', () => {
  let client: QueryClient;
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
    client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    });
  });

  afterEach(() => {
    client.destroy();
  });

  it('shows a changed t.object and t.record field after a refetch', async () => {
    class Token extends Entity {
      __typename = t.typename('Token');
      id = t.id;
      price = t.object({ usd: t.number });
      balances = t.record(t.number);
    }

    class GetToken extends RESTQuery {
      params = { id: t.id };
      path = `/token/${this.params.id}`;
      result = t.entity(Token);
    }

    mockFetch.get('/token/[id]', { __typename: 'Token', id: '1', price: { usd: 100 }, balances: { SOL: 1 } });
    mockFetch.get('/token/[id]', { __typename: 'Token', id: '1', price: { usd: 150 }, balances: { SOL: 5 } });

    let refetch!: () => Promise<unknown>;
    const Price = component(({ price }: { price: { usd: number } }) => <span data-testid="usd">{price.usd}</span>);
    const Balances = component(({ balances }: { balances: Record<string, number> }) => (
      <span data-testid="sol">{balances.SOL}</span>
    ));
    const Parent = component(() => {
      const q = fetchQuery(GetToken, { id: '1' });
      if (!q.isReady) return <div>Loading</div>;
      refetch = () => q.value.__refetch();
      return (
        <div>
          <Price price={q.value.price} />
          <Balances balances={q.value.balances} />
        </div>
      );
    });

    const { getByTestId } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Parent />
      </ContextProvider>,
    );
    await expect.element(getByTestId('usd')).toHaveTextContent('100');
    await expect.element(getByTestId('sol')).toHaveTextContent('1');

    await refetch();

    await expect.element(getByTestId('usd')).toHaveTextContent('150');
    await expect.element(getByTestId('sol')).toHaveTextContent('5');
  });

  it('does not re-render the child when only another field of the entity changes', async () => {
    class Token extends Entity {
      __typename = t.typename('Token');
      id = t.id;
      symbol = t.string;
      price = t.object({ usd: t.number });
    }

    class GetToken extends RESTQuery {
      params = { id: t.id };
      path = `/token/${this.params.id}`;
      result = t.entity(Token);
    }

    mockFetch.get('/token/[id]', { __typename: 'Token', id: '1', symbol: 'A', price: { usd: 100 } });
    mockFetch.get('/token/[id]', { __typename: 'Token', id: '1', symbol: 'B', price: { usd: 100 } });

    let refetch!: () => Promise<unknown>;
    let childRenders = 0;
    const Price = component(({ price }: { price: { usd: number } }) => {
      childRenders++;
      return <span data-testid="usd">{price.usd}</span>;
    });
    const Parent = component(() => {
      const q = fetchQuery(GetToken, { id: '1' });
      if (!q.isReady) return <div>Loading</div>;
      refetch = () => q.value.__refetch();
      return (
        <div>
          <span data-testid="symbol">{q.value.symbol}</span>
          <Price price={q.value.price} />
        </div>
      );
    });

    const { getByTestId } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Parent />
      </ContextProvider>,
    );
    await expect.element(getByTestId('usd')).toHaveTextContent('100');
    await sleep(20);
    const mounted = childRenders;

    await refetch();
    await expect.element(getByTestId('symbol')).toHaveTextContent('B');
    await sleep(20);

    expect(childRenders).toBe(mounted);
  });

  it('shows a streamed create in an unconstrained t.liveArray', async () => {
    class Item extends Entity {
      __typename = t.typename('Item');
      id = t.id;
      name = t.string;
    }

    class List extends Entity {
      __typename = t.typename('List');
      id = t.id;
      items = t.liveArray(Item);
    }

    class GetList extends RESTQuery {
      params = { id: t.id };
      path = `/list/${this.params.id}`;
      result = t.entity(List);
    }

    mockFetch.get('/list/[id]', { __typename: 'List', id: '1', items: [{ __typename: 'Item', id: '1', name: 'A' }] });

    const Items = component(({ items }: { items: Array<{ name: string }> }) => (
      <span data-testid="names">{items.map(item => item.name).join(',')}</span>
    ));
    const Parent = component(() => {
      const q = fetchQuery(GetList, { id: '1' });
      if (!q.isReady) return <div>Loading</div>;
      return <Items items={q.value.items} />;
    });

    const { getByTestId } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Parent />
      </ContextProvider>,
    );
    await expect.element(getByTestId('names')).toHaveTextContent('A');
    await sleep(0);

    // Unconstrained live arrays are routed by event source, the parent entity's key.
    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: '2', name: 'B' },
      __eventSource: hashValue(['List', '1']),
    });

    await expect.element(getByTestId('names')).toHaveTextContent('A,B');
  });
});
