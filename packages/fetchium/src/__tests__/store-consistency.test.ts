import { describe, it, expect } from 'vitest';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { valueKeyFor, refCountKeyFor } from '../stores/shared.js';
import { setupTestClient, testWithClient, sleep } from './utils.js';

function getDocument(kv: any, key: number): unknown | undefined {
  const value = kv.getString(valueKeyFor(key));
  return value ? JSON.parse(value) : undefined;
}

describe('Store consistency: create events matching no live collection', () => {
  const getClient = setupTestClient();

  class Item extends Entity {
    __typename = t.typename('Item');
    id = t.id;
    name = t.string;
  }

  class GetItems extends RESTQuery {
    path = '/items';
    result = { items: t.array(t.entity(Item)) };
  }

  it('does not leave an orphaned record on disk for an entity it immediately evicts', async () => {
    const { client, mockFetch, kv } = getClient();
    mockFetch.get('/items', { items: [{ __typename: 'Item', id: 'i-1', name: 'A' }] });
    await testWithClient(client, async () => {
      await fetchQuery(GetItems);
    });

    const key = hashValue(['Item', 'i-2']);
    client.applyMutationEvent({ type: 'create', typename: 'Item', data: { __typename: 'Item', id: 'i-2', name: 'C' } });
    await sleep(5);

    expect(client.entityMap.getEntity(key)).toBeUndefined();
    expect(kv.getNumber(refCountKeyFor(key))).toBeUndefined();
    expect(getDocument(kv, key)).toBeUndefined();
  });
});
