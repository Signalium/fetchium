import { describe, it, expect, vi } from 'vitest';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { getProxyId } from '../proxyId.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, setupTestClient } from './utils.js';

describe('Entity proxy registry', () => {
  const getClient = setupTestClient();

  // Hermes walks every WeakMap entry on each young GC, so a proxy should not be keyed into several registries.
  it('keys each entity proxy into one WeakMap', async () => {
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
      const proxyKeys = set.mock.calls
        .map(([key]) => key)
        .filter(key => getProxyId(key as Record<string, unknown>) !== undefined);
      expect(proxyKeys.length).toBeGreaterThan(5);
      expect(proxyKeys).toHaveLength(new Set(proxyKeys).size);
    } finally {
      set.mockRestore();
    }
  });
});
