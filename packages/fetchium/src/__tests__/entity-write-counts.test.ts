import { describe, it, expect, vi } from 'vitest';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { QueryClient } from '../QueryClient.js';
import { testWithClient, setupTestClient, sleep } from './utils.js';

/**
 * Entity Write Counts
 *
 * A streamed entity event used to write the entity twice: once through
 * `applyEntityRefs(persist: true)` and again through an unconditional save in
 * `applyMutationEvent`. These pin the write count so the duplicate can't come
 * back, and pin that a single write is still enough for a later client to read.
 */

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

function itemSaves(spy: ReturnType<typeof vi.spyOn>, typename = 'Item') {
  return spy.mock.calls.filter(([, value]) => (value as Record<string, unknown>)?.__typename === typename);
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

    const saveEntity = vi.spyOn(store, 'saveEntity');
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

    const saveEntity = vi.spyOn(store, 'saveEntity');

    // A subscription re-broadcasting what the store already holds: the apply
    // declines the write, and nothing writes on its behalf afterwards.
    for (let i = 0; i < 10; i++) {
      client.applyMutationEvent({ type: 'update', typename: 'Item', data: { id: 'i-1', name: 'A' } });
    }
    expect(itemSaves(saveEntity)).toHaveLength(0);

    client.applyMutationEvent({ type: 'update', typename: 'Item', data: { id: 'i-1', name: 'B' } });
    expect(itemSaves(saveEntity)).toHaveLength(1);
    expect(client.entityMap.getEntity(hashValue(['Item', 'i-1']))!.data.name).toBe('B');
  });

  it('writes an entity once per streamed event that creates it', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/items', { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'A' }] });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetItems);
      await query;
    });

    const saveEntity = vi.spyOn(store, 'saveEntity');
    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: 'i-2', listId: 'l-1', name: 'C' },
    });

    expect(itemSaves(saveEntity)).toHaveLength(1);
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

    const saveEntity = vi.spyOn(store, 'saveEntity');
    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: 'i-2', listId: 'l-1', name: 'B' },
    });
    await sleep(5);

    // The apply writes the new child once. The parent is written because its
    // ref set changed. Neither should write the child a second time.
    expect(itemSaves(saveEntity)).toHaveLength(1);
    // The parent's ref set genuinely changed, so it is written — once.
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

    const saveEntity = vi.spyOn(store, 'saveEntity');
    // The item is already current in the store from the first query, so the
    // apply declines its write. The insert must not put one back.
    client.applyMutationEvent({
      type: 'update',
      typename: 'Item',
      data: { id: 'i-1', listId: 'l-1', name: 'A' },
    });
    await sleep(5);

    expect(itemSaves(saveEntity)).toHaveLength(0);
    // Only the parent's ref set changed, and that write proves the insert ran.
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

    // One write has to be enough for the read path to find it, not just enough
    // to put bytes on disk. Serve something different so a value of
    // 'Persisted' can only have come from the store.
    mockFetch.reset();
    mockFetch.get(
      '/items',
      { items: [{ __typename: 'Item', id: 'i-1', listId: 'l-1', name: 'Refetched' }] },
      { delay: 10_000 },
    );

    const client2 = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
    });

    await testWithClient(client2, async () => {
      const query = fetchQuery(GetItems);
      // Force a pull so the store hydration starts. The refetch is too slow
      // to land, so only the store read can satisfy this.
      void query.value;
      await sleep();
      expect((query.value as unknown as { items: { name: string }[] }).items[0].name).toBe('Persisted');
    });

    client2.destroy();
  });
});
