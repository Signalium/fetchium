import { describe, it, expect } from 'vitest';
import { reactive } from 'signalium';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, sleep, setupTestClient } from './utils.js';

/**
 * Nested values (`t.object` and `t.record` fields, live collection values) are
 * merged in place. A computation that only holds the nested value, such as a
 * child component given `entity.price` as a prop, never reads the entity:
 * - an entity's nested value is handed out through a new wrapper once a merge
 *   changed it, so the parent, which the entity re-runs, passes a new value;
 *   an unchanged one keeps its wrapper, so the child is left alone;
 * - a live collection's value changes in place under the collection's
 *   notifier, which reads through its wrapper consume.
 */
describe('reads through a held nested value', () => {
  const getClient = setupTestClient();

  class Token extends Entity {
    __typename = t.typename('Token');
    id = t.id;
    price = t.object({ usd: t.number, change: t.object({ h24: t.number }) });
    balances = t.record(t.number);
  }

  class GetToken extends RESTQuery {
    params = { id: t.id };
    path = `/token/${this.params.id}`;
    result = t.entity(Token);
  }

  it('hand out a new wrapper once an in-place merge changes a t.object field, a nested t.object field or a t.record value', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/token/[id]', {
      __typename: 'Token',
      id: '1',
      price: { usd: 100, change: { h24: 1 } },
      balances: { SOL: 1, USDC: 2 },
    });
    mockFetch.get('/token/[id]', {
      __typename: 'Token',
      id: '1',
      price: { usd: 150, change: { h24: 2 } },
      balances: { SOL: 5, USDC: 2 },
    });

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetToken, { id: '1' });
      await relay;
      const token = relay.value!;
      const price = token.price;
      const change = token.price.change;
      const balances = token.balances;
      expect([price.usd, change.h24, balances.SOL]).toEqual([100, 1, 1]);

      // Readers through the entity re-run.
      const usd = reactive(() => token.price.usd);
      const h24 = reactive(() => token.price.change.h24);
      const sol = reactive(() => token.balances.SOL);
      expect([usd(), h24(), sol()]).toEqual([100, 1, 1]);

      await token.__refetch();
      await sleep(0);

      expect([usd(), h24(), sol()]).toEqual([150, 2, 5]);
      // Changed in place: new wrappers, so a holder of the old one is handed a new value.
      expect(token.price).not.toBe(price);
      expect(token.price.change).not.toBe(change);
      expect(token.balances).not.toBe(balances);
      // The old wrappers still read the merged data.
      expect([price.usd, change.h24, balances.SOL]).toEqual([150, 2, 5]);
    });
  });

  it('keep the wrapper of a nested value no merge changed', async () => {
    const { client, mockFetch } = getClient();

    class Quote extends Entity {
      __typename = t.typename('Quote');
      id = t.id;
      symbol = t.string;
      price = t.object({ usd: t.number, change: t.object({ h24: t.number }) });
    }

    class GetQuote extends RESTQuery {
      params = { id: t.id };
      path = `/quote/${this.params.id}`;
      result = t.entity(Quote);
    }

    mockFetch.get('/quote/[id]', {
      __typename: 'Quote',
      id: '1',
      symbol: 'A',
      price: { usd: 100, change: { h24: 1 } },
    });
    mockFetch.get('/quote/[id]', {
      __typename: 'Quote',
      id: '1',
      symbol: 'B',
      price: { usd: 100, change: { h24: 1 } },
    });
    mockFetch.get('/quote/[id]', {
      __typename: 'Quote',
      id: '1',
      symbol: 'B',
      price: { usd: 120, change: { h24: 1 } },
    });

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetQuote, { id: '1' });
      await relay;
      const quote = relay.value!;
      const price = quote.price;
      const change = quote.price.change;

      await quote.__refetch();
      await sleep(0);
      expect(quote.symbol).toBe('B');
      expect(quote.price).toBe(price);
      expect(quote.price.change).toBe(change);

      // A change to `price.usd` replaces the wrapper of `price`, not of `price.change`.
      await quote.__refetch();
      await sleep(0);
      expect(quote.price.usd).toBe(120);
      expect(quote.price).not.toBe(price);
      expect(quote.price.change).toBe(change);
    });
  });

  it('re-run when a streamed create grows a held unconstrained t.liveArray', async () => {
    const { client, mockFetch } = getClient();

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

    let items!: { length: number; map<U>(fn: (item: { name: string }) => U): U[] };
    let length!: () => number;
    let names!: () => string;
    await testWithClient(client, async () => {
      const relay = fetchQuery(GetList, { id: '1' });
      await relay;
      items = relay.value!.items;
      length = reactive(() => items.length);
      names = reactive(() => items.map(item => item.name).join(','));
      expect(length()).toBe(1);
      expect(names()).toBe('A');
    });

    // Unconstrained live arrays are routed by event source, the parent entity's key.
    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: '2', name: 'B' },
      __eventSource: hashValue(['List', '1']),
    });
    await sleep(0);

    await testWithClient(client, async () => {
      expect(length()).toBe(2);
      expect(names()).toBe('A,B');
    });
  });

  it('re-run when a liveValue reducer mutates a held array or object value in place', async () => {
    const { client, mockFetch } = getClient();

    class Item extends Entity {
      __typename = t.typename('Item');
      id = t.id;
      listId = t.string;
    }

    class List extends Entity {
      __typename = t.typename('List');
      id = t.id;
      ids = t.liveValue(t.array(t.string), Item, {
        constraints: { listId: (this as any).id },
        onCreate: (v: string[], item: any) => {
          v.push(item.id);
          return v;
        },
        onUpdate: (v: string[]) => v,
        onDelete: (v: string[]) => v,
      });
      seen = t.liveValue(t.record(t.boolean), Item, {
        constraints: { listId: (this as any).id },
        onCreate: (v: Record<string, boolean>, item: any) => {
          v[item.id] = true;
          return v;
        },
        onUpdate: (v: Record<string, boolean>) => v,
        onDelete: (v: Record<string, boolean>) => v,
      });
    }

    class GetList extends RESTQuery {
      params = { id: t.id };
      path = `/list/${this.params.id}`;
      result = { list: t.entity(List) };
    }

    mockFetch.get('/list/[id]', { list: { __typename: 'List', id: '1', ids: [], seen: {} } });

    let length!: () => number;
    let keys!: () => string;
    let has!: () => boolean;
    await testWithClient(client, async () => {
      const relay = fetchQuery(GetList, { id: '1' });
      await relay;
      const ids = relay.value!.list.ids as string[];
      const seen = relay.value!.list.seen as Record<string, boolean>;
      length = reactive(() => ids.length);
      keys = reactive(() => Object.keys(seen).join(','));
      has = reactive(() => 'x' in seen);
      expect([length(), keys(), has()]).toEqual([0, '', false]);
    });

    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: 'x', listId: '1' },
    });
    await sleep(0);

    await testWithClient(client, async () => {
      expect([length(), keys(), has()]).toEqual([1, 'x', true]);
    });
  });
});
