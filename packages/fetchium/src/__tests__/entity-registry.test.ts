import { describe, it, expect, vi } from 'vitest';
import { reactiveMethod } from 'signalium';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { getProxyId } from '../proxyId.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, setupTestClient } from './utils.js';

describe('Entity proxy registry', () => {
  const getClient = setupTestClient();

  // Hermes walks every WeakMap entry on each young GC. The second map is Signalium's scope owner.
  it('keys each entity proxy into two WeakMaps', async () => {
    const { client, mockFetch } = getClient();
    class User extends Entity {
      __typename = t.typename('User');
      id = t.id;
      name = t.string;
      greet() {
        return `Hello, ${this.name}!`;
      }
    }
    mockFetch.get('/users', {
      users: Array.from({ length: 5 }, (_, id) => ({ __typename: 'User', id, name: `user-${id}` })),
    });

    const set = vi.spyOn(WeakMap.prototype, 'set');
    try {
      await testWithClient(client, async () => {
        class GetUsers extends RESTQuery {
          path = '/users';
          result = { users: t.array(t.entity(User)) };
        }
        const relay = fetchQuery(GetUsers);
        await relay;
        expect(relay.value!.users.map(user => user.name)).toEqual(['user-0', 'user-1', 'user-2', 'user-3', 'user-4']);
      });
      const mapsByProxy = new Map<WeakKey, Set<unknown>>();
      set.mock.calls.forEach(([key], i) => {
        if (getProxyId(key as Record<string, unknown>) === undefined) return;
        if (!mapsByProxy.has(key)) mapsByProxy.set(key, new Set());
        mapsByProxy.get(key)!.add(set.mock.contexts[i]);
      });
      expect(mapsByProxy.size).toBeGreaterThan(5);
      for (const maps of mapsByProxy.values()) expect(maps.size).toBe(2);
    } finally {
      set.mockRestore();
    }
  });

  it('owns the scope of a reactive method defined outside the entity class', async () => {
    const { client, mockFetch } = getClient();
    class Item extends Entity {
      __typename = t.typename('Item');
      id = t.id;
      name = t.string;
    }
    mockFetch.get('/item', { item: { __typename: 'Item', id: 1, name: 'one' } });

    await testWithClient(client, async () => {
      class GetItem extends RESTQuery {
        path = '/item';
        result = { item: t.entity(Item) };
      }
      const { item } = await fetchQuery(GetItem);
      const getName = reactiveMethod(item, () => item.name);
      expect(getName()).toBe('one');
    });
  });
});
