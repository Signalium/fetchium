import { describe, it, expect, vi } from 'vitest';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { QueryClient } from '../QueryClient.js';
import { testWithClient, setupTestClient, sleep } from './utils.js';

class Item extends Entity {
  __typename = t.typename('Item');
  id = t.id;
  listId = t.string;
  name = t.string;
}

class GetItems extends RESTQuery {
  path = '/items';
  result = { items: t.array(t.entity(Item)) };
}

class List extends Entity {
  __typename = t.typename('List');
  id = t.id;
  items = t.liveArray(Item, { constraints: { listId: (this as unknown as { id: string }).id } });
}

class GetList extends RESTQuery {
  path = '/list';
  result = { list: t.entity(List) };
}

function spyEntityWrites(store: { saveEntity: (...args: any[]) => void; mergeEntity: (...args: any[]) => void }) {
  const save = vi.spyOn(store, 'saveEntity');
  const merge = vi.spyOn(store, 'mergeEntity');
  return {
    get calls() {
      return [...save.mock.calls, ...merge.mock.calls];
    },
  };
}

function itemSaves(spy: { calls: unknown[][] }, typename = 'Item') {
  return spy.calls.filter(([, value]) => (value as Record<string, unknown>)?.__typename === typename);
}

describe('Entity Write Counts', () => {
  const getClient = setupTestClient();

  it('writes an entity once per streamed event that changes it', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/items', { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'A' }] });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetItems);
      await query;
    });

    const saveEntity = spyEntityWrites(store);
    client.applyMutationEvent({ type: 'update', typename: 'Item', data: { id: 'i-1', name: 'B' } });

    expect(itemSaves(saveEntity)).toHaveLength(1);
    expect(client.entityMap.getEntity(hashValue(['Item', 'i-1']))!.data.name).toBe('B');
  });

  it('writes nothing for streamed events that repeat the current value', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/items', { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'A' }] });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetItems);
      await query;
    });

    const saveEntity = spyEntityWrites(store);

    for (let i = 0; i < 10; i++) {
      client.applyMutationEvent({ type: 'update', typename: 'Item', data: { id: 'i-1', name: 'A' } });
    }
    expect(itemSaves(saveEntity)).toHaveLength(0);

    client.applyMutationEvent({ type: 'update', typename: 'Item', data: { id: 'i-1', name: 'B' } });
    expect(itemSaves(saveEntity)).toHaveLength(1);
    expect(client.entityMap.getEntity(hashValue(['Item', 'i-1']))!.data.name).toBe('B');
  });

  it('writes nothing for a created entity that no live collection routes', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/items', { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'A' }] });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetItems);
      await query;
    });

    const saveEntity = spyEntityWrites(store);
    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: 'i-2', listId: 'l-1', name: 'C' },
    });

    // Evicted, and an unreferenced record would never be collected.
    expect(itemSaves(saveEntity)).toHaveLength(0);
    expect(client.entityMap.getEntity(hashValue(['Item', 'i-2']))).toBeUndefined();
  });

  it('does not re-write a child when a live array gains it', async () => {
    const { client, mockFetch, store } = getClient();

    mockFetch.get('/list', {
      list: {
        __typename: 'List',
        id: 'l-1',
        items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'A' }],
      },
    });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetList);
      await query;
    });

    const saveEntity = spyEntityWrites(store);
    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: 'i-2', listId: 'l-1', name: 'B' },
    });
    await sleep(5);

    expect(itemSaves(saveEntity)).toHaveLength(1);
    expect(itemSaves(saveEntity, 'List')).toHaveLength(1);
  });

  it('writes only the parent when a live array gains a child that did not change', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/items', { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'A' }] });
    mockFetch.get('/list', { list: { __typename: 'List', id: 'l-1', items: [] } });

    let listQuery!: { value: { list: { items: { id: string }[] } } };
    await testWithClient(client, async () => {
      const items = fetchQuery(GetItems);
      await items;
      const query = fetchQuery(GetList);
      await query;
      listQuery = query as unknown as typeof listQuery;
    });

    const saveEntity = spyEntityWrites(store);
    // i-1 is already current in the store, so the apply skips its write. The insert must not add one.
    client.applyMutationEvent({
      type: 'update',
      typename: 'Item',
      data: { id: 'i-1', listId: 'l-1', name: 'A' },
    });
    await sleep(5);

    expect(itemSaves(saveEntity)).toHaveLength(0);
    // This write proves the insert ran.
    expect(itemSaves(saveEntity, 'List')).toHaveLength(1);
    expect(listQuery.value.list.items.map(i => i.id)).toEqual(['i-1']);
  });

  it('keeps an entity written by an event readable by a later client', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/items', { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'A' }] });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetItems);
      await query;
    });

    client.applyMutationEvent({ type: 'update', typename: 'Item', data: { id: 'i-1', name: 'Persisted' } });
    await sleep(5);
    client.destroy();

    // Serve a different value, slowly, so 'Persisted' can only come from the store.
    mockFetch.reset();
    mockFetch.get(
      '/items',
      { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'Refetched' }] },
      { delay: 1000 },
    );

    const client2 = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
    });

    await testWithClient(client2, async () => {
      const query = fetchQuery(GetItems);
      // Pull the value to start store hydration.
      void query.value;
      await sleep();
      expect((query.value as unknown as { items: { name: string }[] }).items[0].name).toBe('Persisted');
    });

    client2.destroy();
  });
});
