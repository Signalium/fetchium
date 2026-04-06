import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient } from '../QueryClient.js';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery, QueryDefinition, type Query, type ResolvedQueryOptions } from '../query.js';
import { type QueryContext } from '../QueryClient.js';
import { type RetryConfig } from '../types.js';
import { createMockFetch, testWithClient, getEntityMapSize, sleep, setupTestClient } from './utils.js';
import { RESTQueryController } from '../rest/RESTQueryController.js';

function resolveOpts(QueryClass: new () => Query, params: Record<string, unknown> = {}): ResolvedQueryOptions {
  const def = QueryDefinition.for(QueryClass);
  const ctx = def.createExecutionContext(params, {} as QueryContext);
  return def.resolveOptions(ctx);
}

/**
 * REST Query API Tests
 *
 * These tests focus on the PUBLIC query() API - what users will actually use.
 * All external fetch calls are mocked.
 */

describe('REST Query API', () => {
  const getClient = setupTestClient();

  describe('Basic Query Execution', () => {
    it('should execute a GET query with path parameters', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[id]', { id: 123, name: 'Test User' });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser, { id: '123' });
        const result = await relay;

        expect(result.id).toBe(123);
        expect(result.name).toBe('Test User');
        expect(mockFetch.calls[0].url).toBe('http://localhost/users/123');
        expect(mockFetch.calls[0].options.method).toBe('GET');
      });
    });

    it('should execute a GET query with search parameters', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users', { users: [], page: 1, total: 0 });

      class ListUsers extends RESTQuery {
        params = { page: t.number, limit: t.number };
        path = '/users';
        searchParams = { page: this.params.page, limit: this.params.limit };
        result = {
          users: t.array(
            t.object({
              id: t.number,
              name: t.string,
            }),
          ),
          page: t.number,
          total: t.number,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ListUsers, { page: 1, limit: 10 });
        const result = await relay;

        expect(result.page).toBe(1);
        expect(result.total).toBe(0);
        // Verify URL was constructed with search params
        const callUrl = mockFetch.calls[0].url;
        expect(callUrl).toContain('page=1');
        expect(callUrl).toContain('limit=10');
      });
    });

    it('should execute a GET query with both path and search params', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[userId]/posts', { posts: [], userId: 5 });

      class GetUserPosts extends RESTQuery {
        params = { userId: t.id, status: t.string };
        path = `/users/${this.params.userId}/posts`;
        searchParams = { status: this.params.status };
        result = {
          posts: t.array(
            t.object({
              id: t.number,
              title: t.string,
            }),
          ),
          userId: t.number,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUserPosts, { userId: '5', status: 'published' } as any);
        const result = await relay;

        expect(result.userId).toBe(5);
        const callUrl = mockFetch.calls[0].url;
        expect(callUrl).toContain('/users/5/posts');
        expect(callUrl).toContain('status=published');
      });
    });

    it('should execute POST requests', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.post('/users', { id: 456, name: 'New User', created: true });

      class CreateUser extends RESTQuery {
        path = '/users';
        method = 'POST' as const;
        result = {
          id: t.number,
          name: t.string,
          created: t.boolean,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(CreateUser);
        const result = await relay;

        expect(result.id).toBe(456);
        expect(result.created).toBe(true);
        expect(mockFetch.calls[0].url).toBe('http://localhost/users');
        expect(mockFetch.calls[0].options.method).toBe('POST');
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors', async () => {
      const { client, mockFetch } = getClient();
      const error = new Error('Network connection failed');
      mockFetch.get('/users/[id]', null, { error });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser, { id: '123' });

        await expect(relay).rejects.toThrow('Network connection failed');
        expect(relay.isRejected).toBe(true);
        expect(relay.error).toBe(error);
      });
    });

    it('should handle malformed JSON responses', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[id]', null, {
        jsonError: new Error('Unexpected token in JSON'),
      });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser, { id: '123' });

        await expect(relay).rejects.toThrow('Unexpected token in JSON');

        expect(relay.isRejected).toBe(true);
        expect(relay.error).toBeInstanceOf(Error);
        expect((relay.error as Error).message).toBe('Unexpected token in JSON');
      });
    });

    it('should require QueryClient context', async () => {
      const { client, mockFetch } = getClient();
      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      // Call without reactive context should throw
      expect(() => fetchQuery(GetUser, { id: '123' } as any)).toThrow();
    });
  });

  describe('Query Deduplication', () => {
    it('should deduplicate identical queries', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[id]', { id: 123, name: 'Test User' });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay1 = fetchQuery(GetUser, { id: '123' });
        const relay2 = fetchQuery(GetUser, { id: '123' });
        const relay3 = fetchQuery(GetUser, { id: '123' });

        // Should return the same relay instance
        expect(relay1).toBe(relay2);
        expect(relay2).toBe(relay3);

        await relay1;

        // Should only fetch once
        expect(mockFetch.calls).toHaveLength(1);
      });
    });

    it('should create separate queries for different parameters', async () => {
      const { client, mockFetch } = getClient();
      // Mocks are matched in LIFO order (last added is matched first)
      mockFetch.get('/users/1', { id: 1, name: 'User' });
      mockFetch.get('/users/2', { id: 2, name: 'User' });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay1 = fetchQuery(GetUser, { id: '1' });
        const relay2 = fetchQuery(GetUser, { id: '2' });

        // Should be different relay instances
        expect(relay1).not.toBe(relay2);

        const [result1, result2] = await Promise.all([relay1, relay2]);

        expect(result1.id).toBe(1);
        expect(result2.id).toBe(2);
        expect(mockFetch.calls).toHaveLength(2);
      });
    });
  });

  describe('Response Type Handling', () => {
    it.skip('should handle primitive response types', async () => {
      mockFetch.get('/message', 'Hello, World!');

      class GetMessage extends RESTQuery {
        path = '/message';
        result = t.string;
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetMessage);
        const result = await relay;

        expect(result).toBe('Hello, World!');
      });
    });

    it.skip('should handle array responses', async () => {
      mockFetch.get('/numbers', [1, 2, 3, 4, 5]);

      class GetNumbers extends RESTQuery {
        path = '/numbers';
        result = t.array(t.number);
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetNumbers);
        const result = await relay;

        expect(result).toEqual([1, 2, 3, 4, 5]);
      });
    });

    it('should handle nested object responses', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/user', {
        user: {
          id: 1,
          profile: {
            name: 'Alice',
            email: 'alice@example.com',
          },
        },
      });

      class GetUser extends RESTQuery {
        path = '/user';
        result = {
          user: t.object({
            id: t.number,
            profile: t.object({
              name: t.string,
              email: t.string,
            }),
          }),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser);
        const result = await relay;

        expect(result.user.profile.name).toBe('Alice');
        expect(result.user.profile.email).toBe('alice@example.com');
      });
    });
  });

  describe('Entity Handling', () => {
    it('should handle entity responses', async () => {
      const { client, mockFetch } = getClient();
      class User extends Entity {
        __typename = t.typename('User');
        id = t.id;
        name = t.string;
        email = t.string;
      }

      mockFetch.get('/users/[id]', {
        user: {
          __typename: 'User',
          id: 1,
          name: 'Alice',
          email: 'alice@example.com',
        },
      });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          user: t.entity(User),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser, { id: '1' });
        const result = await relay;

        expect(result.user.name).toBe('Alice');
        expect(result.user.email).toBe('alice@example.com');

        // Verify entity was cached (+ 1 for root query entity)
        expect(getEntityMapSize(client)).toBe(2);
      });
    });

    it('should handle array of entities', async () => {
      const { client, mockFetch } = getClient();
      class User extends Entity {
        __typename = t.typename('User');
        id = t.id;
        name = t.string;
      }

      mockFetch.get('/users', {
        users: [
          { __typename: 'User', id: 1, name: 'Alice' },
          { __typename: 'User', id: 2, name: 'Bob' },
          { __typename: 'User', id: 3, name: 'Charlie' },
        ],
      });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.entity(User)),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ListUsers);
        const result = await relay;

        expect(result.users).toHaveLength(3);
        expect(result.users[0].name).toBe('Alice');
        expect(result.users[1].name).toBe('Bob');
        expect(result.users[2].name).toBe('Charlie');

        // Verify all entities were cached (+ 1 for root query entity)
        expect(getEntityMapSize(client)).toBe(4);
      });
    });

    it('should deduplicate entities across queries', async () => {
      const { client, mockFetch } = getClient();
      class User extends Entity {
        __typename = t.typename('User');
        id = t.id;
        name = t.string;
      }

      mockFetch.get('/users/[id]', {
        user: { __typename: 'User', id: 1, name: 'Alice' },
      });
      mockFetch.get('/users', {
        users: [{ __typename: 'User', id: 1, name: 'Alice' }],
      });

      await testWithClient(client, async () => {
        class GetUser extends RESTQuery {
          params = { id: t.id };
          path = `/users/${this.params.id}`;
          result = {
            user: t.entity(User),
          };
        }

        class ListUsers extends RESTQuery {
          path = '/users';
          result = {
            users: t.array(t.entity(User)),
          };
        }

        const relay1 = fetchQuery(GetUser, { id: '1' });
        const result1 = await relay1;

        const relay2 = fetchQuery(ListUsers);
        const result2 = await relay2;

        // Should be the same entity proxy
        expect(result1.user).toBe(result2.users[0]);
      });
    });
  });

  describe('Optional Parameters', () => {
    it('should handle optional search parameters', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users', { users: [] });
      mockFetch.get('/users', { users: [] });
      mockFetch.get('/users', { users: [] });
      mockFetch.get('/users', { users: [] });

      class ListUsers extends RESTQuery {
        params = { page: t.optional(t.number), limit: t.optional(t.number) };
        path = '/users';
        searchParams = { page: this.params.page, limit: this.params.limit };
        result = {
          users: t.array(t.object({ id: t.number, name: t.string })),
        };
      }

      await testWithClient(client, async () => {
        const relay1 = fetchQuery(ListUsers);
        await relay1;

        const relay2 = fetchQuery(ListUsers, {});
        await relay2;

        const relay3 = fetchQuery(ListUsers, { page: 1 });
        await relay3;

        const relay4 = fetchQuery(ListUsers, { page: 1, limit: 10 });
        await relay4;

        expect(mockFetch.calls).toHaveLength(4);
      });
    });
  });

  describe('Type Safety', () => {
    it('should infer correct types for path parameters', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items/[itemId]/details/[detailId]', { id: 1, name: 'Test' });

      class GetItem extends RESTQuery {
        params = { itemId: t.id, detailId: t.id };
        path = `/items/${this.params.itemId}/details/${this.params.detailId}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        // TypeScript should require both path params
        const relay = fetchQuery(GetItem, { itemId: '1', detailId: '2' });
        await relay;

        expect(mockFetch.calls[0].url).toContain('/items/1/details/2');
        expect(mockFetch.calls[0].options.method).toBe('GET');
      });
    });
  });

  describe('Method-based definitions', () => {
    it('should support getPath() with this.params', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[id]', { id: 123, name: 'Test User' });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        getPath() {
          return `/users/${this.params.id}`;
        }
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser, { id: '123' });
        const result = await relay;

        expect(result.id).toBe(123);
        expect(result.name).toBe('Test User');
        expect(mockFetch.calls[0].url).toBe('http://localhost/users/123');
      });
    });

    it('should allow calling methods on this.params values inside getPath()', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[id]', { slug: 'abc', name: 'Test' });

      class GetUserBySlug extends RESTQuery {
        params = { slug: t.string };
        getPath() {
          return `/users/${this.params.slug.toLowerCase()}`;
        }
        result = {
          slug: t.string,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUserBySlug, { slug: 'ABC' });
        const result = await relay;

        expect(result.slug).toBe('abc');
        expect(mockFetch.calls[0].url).toBe('http://localhost/users/abc');
      });
    });

    it('should support getSearchParams()', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: [], total: 0 });

      class ListItems extends RESTQuery {
        params = { page: t.number, limit: t.number };
        path = '/items';
        getSearchParams() {
          return { page: this.params.page, limit: this.params.limit };
        }
        result = {
          items: t.array(t.object({ id: t.number })),
          total: t.number,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ListItems, { page: 2, limit: 25 });
        await relay;

        expect(mockFetch.calls[0].url).toBe('http://localhost/items?page=2&limit=25');
      });
    });

    it('should thread this context through nested method calls', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/api/[id]', { id: 1, data: 'test' });

      class GetResource extends RESTQuery {
        params = { id: t.id, version: t.string };
        getBasePath() {
          return `/api/${this.params.id}`;
        }
        getPath() {
          return this.getBasePath();
        }
        getSearchParams() {
          return { v: this.params.version };
        }
        result = {
          id: t.number,
          data: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetResource, { id: '1', version: '2' });
        await relay;

        expect(mockFetch.calls[0].url).toBe('http://localhost/api/1?v=2');
      });
    });
  });
});

describe('BaseUrl and RequestOptions', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    mockFetch = createMockFetch();
  });

  describe('Context-level baseUrl', () => {
    it('should prepend static baseUrl from context to request URL', async () => {
      mockFetch.get('https://api.example.com/users/[id]', { id: 123, name: 'Test User' });

      const store = new SyncQueryStore(new MemoryPersistentStore());
      const client = new QueryClient({ store: store, controllers: [new RESTQueryController({ fetch: mockFetch as any,
        baseUrl: 'https://api.example.com', })] });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser, { id: '123' });
        await relay;

        expect(mockFetch.calls[0].url).toBe('https://api.example.com/users/123');
      });

      client.destroy();
    });

    it('should support Signal-based baseUrl from context', async () => {
      const { signal } = await import('signalium');

      mockFetch.get('https://api-v1.example.com/users', { users: [] });
      mockFetch.get('https://api-v2.example.com/users', { users: [] });

      const baseUrlSignal = signal('https://api-v1.example.com');

      const store = new SyncQueryStore(new MemoryPersistentStore());
      const client = new QueryClient({ store: store, controllers: [new RESTQueryController({ fetch: mockFetch as any,
        baseUrl: baseUrlSignal, })] });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.object({ id: t.number, name: t.string })),
        };
      }

      await testWithClient(client, async () => {
        const relay1 = fetchQuery(ListUsers);
        await relay1;

        expect(mockFetch.calls[0].url).toBe('https://api-v1.example.com/users');
      });

      await sleep();

      // Update the signal and make another request
      baseUrlSignal.value = 'https://api-v2.example.com';

      await testWithClient(client, async () => {
        const relay2 = fetchQuery(ListUsers);
        await relay2;

        await sleep();

        expect(mockFetch.calls[1].url).toBe('https://api-v2.example.com/users');
      });

      client.destroy();
    });

    it('should support function-based baseUrl from context', async () => {
      mockFetch.get('https://dynamic.example.com/users', { users: [] });

      const store = new SyncQueryStore(new MemoryPersistentStore());
      const client = new QueryClient({ store: store, controllers: [new RESTQueryController({ fetch: mockFetch as any,
        baseUrl: () => 'https://dynamic.example.com', })] });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.object({ id: t.number, name: t.string })),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ListUsers);
        await relay;

        expect(mockFetch.calls[0].url).toBe('https://dynamic.example.com/users');
      });

      client.destroy();
    });
  });

  describe('Query-level baseUrl', () => {
    it('should allow query baseUrl field to override controller baseUrl', async () => {
      mockFetch.get('https://special-api.example.com/items', { items: [] });

      const client = new QueryClient({ controllers: [new RESTQueryController({ fetch: mockFetch as any,
        baseUrl: 'https://api.example.com', })] });

      class ListItems extends RESTQuery {
        path = '/items';
        baseUrl = 'https://special-api.example.com';
        result = {
          items: t.array(t.object({ id: t.number })),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ListItems);
        await relay;

        expect(mockFetch.calls[0].url).toBe('https://special-api.example.com/items');
      });

      client.destroy();
    });

    it('should allow requestOptions.baseUrl to override controller baseUrl', async () => {
      mockFetch.get('https://special-api.example.com/items', { items: [] });

      const client = new QueryClient({ controllers: [new RESTQueryController({ fetch: mockFetch as any,
        baseUrl: 'https://api.example.com', })] });

      class ListItems extends RESTQuery {
        path = '/items';
        requestOptions = { baseUrl: 'https://special-api.example.com' };
        result = {
          items: t.array(t.object({ id: t.number })),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ListItems);
        await relay;

        expect(mockFetch.calls[0].url).toBe('https://special-api.example.com/items');
      });

      client.destroy();
    });
  });

  describe('Absolute URL passthrough', () => {
    it('should use absolute path as-is without prepending baseUrl', async () => {
      mockFetch.get('https://other.example.com/data', { value: 1 });

      const client = new QueryClient({ controllers: [new RESTQueryController({ fetch: mockFetch as any,
        baseUrl: 'https://api.example.com', })] });

      class GetData extends RESTQuery {
        path = 'https://other.example.com/data';
        result = { value: t.number };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetData);
        await relay;

        expect(mockFetch.calls[0].url).toBe('https://other.example.com/data');
      });

      client.destroy();
    });
  });

  describe('Query-level requestOptions', () => {
    it('should pass additional request options to fetch', async () => {
      mockFetch.get('https://api.example.com/secure', { data: 'secret' });

      const client = new QueryClient({ controllers: [new RESTQueryController({ fetch: mockFetch as any,
        baseUrl: 'https://api.example.com', })] });

      class GetSecureData extends RESTQuery {
        path = '/secure';
        headers = {
          'X-Custom-Header': 'custom-value',
        };
        requestOptions = {
          credentials: 'include' as const,
          mode: 'cors' as const,
        };
        result = {
          data: t.string,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetSecureData);
        await relay;

        expect(mockFetch.calls[0].options.credentials).toBe('include');
        expect(mockFetch.calls[0].options.mode).toBe('cors');
        expect(mockFetch.calls[0].options.headers).toEqual({
          'X-Custom-Header': 'custom-value',
        });
      });

      client.destroy();
    });

    it('should throw when using root-relative path without any baseUrl configured', async () => {
      const client = new QueryClient({ controllers: [new RESTQueryController({ fetch: mockFetch as any })] });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.object({ id: t.number, name: t.string })),
        };
      }

      await expect(
        testWithClient(client, async () => {
          const relay = fetchQuery(ListUsers);
          await relay;
        }),
      ).rejects.toThrow('cannot resolve URL for path "/users"');

      client.destroy();
    });
  });
});

describe('Query definition getter methods', () => {
  const getClient = setupTestClient();

  describe('getConfig()', () => {
    it('should resolve config from a field assignment', () => {
      class CachedQuery extends RESTQuery {
        path = '/data';
        result = { value: t.string };
        config = { staleTime: 5000 };
      }

      expect(resolveOpts(CachedQuery).config?.staleTime).toBe(5000);
    });

    it('should resolve getConfig() referencing other fields', () => {
      class MethodAwareCache extends RESTQuery {
        path = '/data';
        result = { value: t.string };

        getConfig() {
          return this.method === 'GET' ? { staleTime: 10000 } : { staleTime: 0 };
        }
      }

      expect(resolveOpts(MethodAwareCache).config?.staleTime).toBe(10000);
    });

    it('should resolve getConfig() referencing path', () => {
      class PathAwareCache extends RESTQuery {
        path = '/important';
        result = { value: t.string };

        getConfig() {
          return this.path.includes('important') ? { staleTime: 60000 } : { staleTime: 1000 };
        }
      }

      expect(resolveOpts(PathAwareCache).config?.staleTime).toBe(60000);
    });

    it('should apply config from getConfig() at runtime', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/item', { value: 'first' });

      class GetItem extends RESTQuery {
        path = '/item';
        result = { value: t.string };

        getConfig() {
          return { staleTime: 10000 };
        }
      }

      await testWithClient(client, async () => {
        const relay1 = fetchQuery(GetItem);
        await relay1;
        expect(mockFetch.calls).toHaveLength(1);

        mockFetch.get('/item', { value: 'second' });
        const relay2 = fetchQuery(GetItem);
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        relay2.value;
        await sleep(50);

        // staleTime=10000 means data is still fresh, no refetch
        expect(mockFetch.calls).toHaveLength(1);
      });
    });
  });

  describe('getConfig() debounce', () => {
    it('should resolve debounce from a field assignment', () => {
      class DebouncedQuery extends RESTQuery {
        path = '/data';
        result = { value: t.string };
        config = { debounce: 200 };
      }

      expect(resolveOpts(DebouncedQuery).config?.debounce).toBe(200);
    });

    it('should resolve getConfig() debounce referencing other fields', () => {
      class MethodAwareDebounce extends RESTQuery {
        path = '/search';
        result = { value: t.string };

        getConfig() {
          return { debounce: this.method === 'GET' ? 300 : 0 };
        }
      }

      expect(resolveOpts(MethodAwareDebounce).config?.debounce).toBe(300);
    });

    it('should resolve getConfig() debounce referencing path', () => {
      class PathAwareDebounce extends RESTQuery {
        path = '/search';
        result = { value: t.string };

        getConfig() {
          return { debounce: this.path.includes('search') ? 500 : 0 };
        }
      }

      expect(resolveOpts(PathAwareDebounce).config?.debounce).toBe(500);
    });
  });

  describe('subscribe()', () => {
    it('should call subscribe on the execution context', () => {
      let called = false;

      class StreamQuery extends RESTQuery {
        path = '/posts';
        result = { id: t.string };

        getConfig() {
          return {
            subscribe(onEvent: any) {
              called = true;
              return () => {};
            },
          };
        }
      }

      const def = QueryDefinition.for(StreamQuery);
      const ctx = def.createExecutionContext({}, {} as QueryContext);
      const opts = def.resolveOptions(ctx);
      const unsub = opts.config!.subscribe!.call(ctx, () => {});

      expect(called).toBe(true);
      expect(typeof unsub).toBe('function');
    });

    it('should not have subscribe when not defined on the query', () => {
      class NoStreamMutation extends RESTQuery {
        path = '/posts';
        method = 'POST' as const;
        result = { id: t.string };
      }

      const def = QueryDefinition.for(NoStreamMutation);
      const ctx = def.createExecutionContext({}, {} as QueryContext);
      const opts = def.resolveOptions(ctx);

      expect(opts.config?.subscribe).toBeUndefined();
    });

    it('should have access to this.params in subscribe', () => {
      let receivedId: any;

      class ParamStream extends RESTQuery {
        params = { channelId: t.id };
        path = `/channels/${this.params.channelId}`;
        result = { id: t.string };

        getConfig() {
          return {
            subscribe: (onEvent: any) => {
              receivedId = this.params.channelId;
              return () => {};
            },
          };
        }
      }

      const def = QueryDefinition.for(ParamStream);
      const ctx = def.createExecutionContext({ channelId: 'ch-99' }, {} as QueryContext);
      const opts = def.resolveOptions(ctx);
      opts.config!.subscribe!.call(ctx, () => {});

      expect(receivedId).toBe('ch-99');
    });
  });

  describe('Standard field assignments with dynamic parameter references', () => {
    it('should resolve path with this.params FieldRef and config as a plain field', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[id]', { id: 1, name: 'Alice' });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = { id: t.number, name: t.string };
        config = { staleTime: 10000 };
      }

      expect(QueryDefinition.for(GetUser).statics.id).toBe('GET:/users/[params.id]');
      expect(resolveOpts(GetUser).config?.staleTime).toBe(10000);

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUser, { id: '1' });
        const result = await relay;

        expect(result.name).toBe('Alice');
        expect(mockFetch.calls[0].url).toBe('http://localhost/users/1');
      });
    });

    it('should resolve searchParams with this.params FieldRefs and debounce as a plain field', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/search', { results: [] });

      class SearchQuery extends RESTQuery {
        params = { q: t.string, page: t.number };
        path = '/search';
        searchParams = { q: this.params.q, page: this.params.page };
        result = { results: t.array(t.object({ id: t.number })) };
        config = { debounce: 200 };
      }

      expect(resolveOpts(SearchQuery).config?.debounce).toBe(200);

      await testWithClient(client, async () => {
        const relay = fetchQuery(SearchQuery, { q: 'test', page: 1 });
        const result = await relay;

        expect(result.results).toEqual([]);
        expect(mockFetch.calls[0].url).toBe('http://localhost/search?q=test&page=1');
      });
    });

    it('should resolve path + searchParams with FieldRefs and config + debounce as plain fields', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users/[userId]/posts', { posts: [] });

      class GetUserPosts extends RESTQuery {
        params = { userId: t.id, status: t.string };
        path = `/users/${this.params.userId}/posts`;
        searchParams = { status: this.params.status };
        result = { posts: t.array(t.object({ id: t.number, title: t.string })) };
        config = { staleTime: 5000, debounce: 100 };
      }

      expect(QueryDefinition.for(GetUserPosts).statics.id).toBe('GET:/users/[params.userId]/posts');
      const opts = resolveOpts(GetUserPosts);
      expect(opts.config?.staleTime).toBe(5000);
      expect(opts.config?.debounce).toBe(100);

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetUserPosts, { userId: '42', status: 'published' } as any);
        const result = await relay;

        expect(result.posts).toEqual([]);
        expect(mockFetch.calls[0].url).toContain('/users/42/posts');
        expect(mockFetch.calls[0].url).toContain('status=published');
      });
    });
  });

  describe('Getter methods referencing custom subclass fields', () => {
    it('should resolve getConfig() referencing a custom field', () => {
      class ConfigurableQuery extends RESTQuery {
        staleMs = 15000;
        path = '/data';
        result = { value: t.string };

        getConfig() {
          return { staleTime: this.staleMs };
        }
      }

      expect(resolveOpts(ConfigurableQuery).config?.staleTime).toBe(15000);
    });

    it('should resolve getConfig() debounce referencing a custom field', () => {
      class ConfigurableDebounce extends RESTQuery {
        debounceMs = 350;
        path = '/search';
        result = { value: t.string };

        getConfig() {
          return { debounce: this.debounceMs };
        }
      }

      expect(resolveOpts(ConfigurableDebounce).config?.debounce).toBe(350);
    });

    it('should resolve getIdentityKey() referencing a custom field', () => {
      class VersionedQuery extends RESTQuery {
        apiVersion = 'v2';
        path = '/users';
        result = { id: t.number };

        getIdentityKey() {
          return `${this.apiVersion}:${this.method}:${this.path}`;
        }
      }

      const def = QueryDefinition.for(VersionedQuery);
      expect(def.statics.id).toBe('v2:GET:/users');
    });

    it('should resolve getConfig() using multiple custom fields', () => {
      class MultiFieldCache extends RESTQuery {
        staleMs = 5000;
        gcMs = 30000;
        path = '/data';
        result = { value: t.string };

        getConfig() {
          return {
            staleTime: this.staleMs,
            gcTime: this.gcMs,
          };
        }
      }

      const opts = resolveOpts(MultiFieldCache);
      expect(opts.config?.staleTime).toBe(5000);
      expect(opts.config?.gcTime).toBe(30000);
    });

    it('should execute a query whose getters reference custom fields', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: [{ id: 1 }] });

      class VersionedItems extends RESTQuery {
        apiVersion = 'v2';
        staleMs = 10000;
        path = '/items';
        result = { items: t.array(t.object({ id: t.number })) };

        getIdentityKey() {
          return `${this.apiVersion}:${this.method}:${this.path}`;
        }

        getConfig() {
          return { staleTime: this.staleMs };
        }
      }

      expect(QueryDefinition.for(VersionedItems).statics.id).toBe('v2:GET:/items');
      expect(resolveOpts(VersionedItems).config?.staleTime).toBe(10000);

      await testWithClient(client, async () => {
        const relay = fetchQuery(VersionedItems);
        const result = await relay;

        expect(result.items).toHaveLength(1);
        expect(mockFetch.calls[0].url).toBe('http://localhost/items');
      });
    });
  });

  describe('Combined getter methods', () => {
    it('should resolve all getter methods together', () => {
      class Post extends Entity {
        __typename = t.typename('Post');
        id = t.id;
        title = t.string;
      }

      let streamCalled = false;

      class FullQuery extends RESTQuery {
        path = '/posts';
        result = { posts: t.array(t.entity(Post)) };

        getIdentityKey() {
          return `custom:${this.method}:${this.path}`;
        }

        getConfig() {
          const base = this.method === 'GET' ? { staleTime: 30000, debounce: 150 } : { debounce: 0 };
          return {
            ...base,
            subscribe: (onEvent: any) => {
              if (this.method === 'GET') {
                streamCalled = true;
              }
              return () => {};
            },
          };
        }
      }

      expect(QueryDefinition.for(FullQuery).statics.id).toBe('custom:GET:/posts');
      const opts = resolveOpts(FullQuery);
      expect(opts.config?.staleTime).toBe(30000);
      expect(opts.config?.debounce).toBe(150);

      const def = QueryDefinition.for(FullQuery);
      const ctx = def.createExecutionContext({}, {} as QueryContext);
      const fullOpts = def.resolveOptions(ctx);
      fullOpts.config!.subscribe!.call(ctx, () => {});
      expect(streamCalled).toBe(true);
    });

    it('should execute a query with all getter methods applied', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: [{ id: 1 }] });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.object({ id: t.number })) };

        getIdentityKey() {
          return `items:${this.method}:${this.path}`;
        }

        getConfig() {
          return { staleTime: 10000, debounce: 0 };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        const result = await relay;

        expect(result.items).toHaveLength(1);
        expect(result.items[0].id).toBe(1);
        expect(mockFetch.calls).toHaveLength(1);

        // Verify cache staleTime is applied (no refetch for fresh data)
        mockFetch.get('/items', { items: [{ id: 2 }] });
        const relay2 = fetchQuery(GetItems);
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        relay2.value;
        await sleep(50);
        expect(mockFetch.calls).toHaveLength(1);
      });
    });
  });

  describe('Params-dependent options via field assignments', () => {
    it('should resolve config.staleTime from this.params via field assignment', () => {
      class ParamCache extends RESTQuery {
        params = { staleTime: t.number };
        path = '/data';
        result = { value: t.string };
        config = { staleTime: this.params.staleTime };
      }

      const opts = resolveOpts(ParamCache, { staleTime: 8000 });
      expect(opts.config?.staleTime).toBe(8000);
    });

    it('should resolve debounce from this.params via field assignment', () => {
      class ParamDebounce extends RESTQuery {
        params = { debounceMs: t.number };
        path = '/search';
        result = { value: t.string };
        config = { debounce: this.params.debounceMs };
      }

      const opts = resolveOpts(ParamDebounce, { debounceMs: 400 });
      expect(opts.config?.debounce).toBe(400);
    });

    it('should apply params-dependent config at runtime', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/data', { value: 'first' });

      class ParamCacheQuery extends RESTQuery {
        params = { staleTime: t.number };
        path = '/data';
        result = { value: t.string };
        config = { staleTime: this.params.staleTime };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ParamCacheQuery, { staleTime: 10000 });
        await relay;
        expect(mockFetch.calls).toHaveLength(1);

        mockFetch.get('/data', { value: 'second' });
        const relay2 = fetchQuery(ParamCacheQuery, { staleTime: 10000 });
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        relay2.value;
        await sleep(50);

        // staleTime=10000 means data is still fresh
        expect(mockFetch.calls).toHaveLength(1);
      });
    });
  });

  describe('Params-dependent options via getter methods', () => {
    it('should resolve getConfig() referencing this.params', () => {
      class ParamCacheGetter extends RESTQuery {
        params = { staleTime: t.number };
        path = '/data';
        result = { value: t.string };

        getConfig() {
          return { staleTime: this.params.staleTime };
        }
      }

      const opts = resolveOpts(ParamCacheGetter, { staleTime: 5000 });
      expect(opts.config?.staleTime).toBe(5000);
    });

    it('should resolve getConfig() debounce referencing this.params', () => {
      class ParamDebounceGetter extends RESTQuery {
        params = { debounceMs: t.number };
        path = '/search';
        result = { value: t.string };

        getConfig() {
          return { debounce: this.params.debounceMs };
        }
      }

      const opts = resolveOpts(ParamDebounceGetter, { debounceMs: 250 });
      expect(opts.config?.debounce).toBe(250);
    });

    it('should resolve different options for different params', () => {
      class FlexibleQuery extends RESTQuery {
        params = { staleTime: t.number, debounceMs: t.number };
        path = '/data';
        result = { value: t.string };

        getConfig() {
          return {
            staleTime: this.params.staleTime,
            debounce: this.params.debounceMs,
          };
        }
      }

      const fast = resolveOpts(FlexibleQuery, { staleTime: 1000, debounceMs: 0 });
      expect(fast.config?.staleTime).toBe(1000);
      expect(fast.config?.debounce).toBe(0);

      const slow = resolveOpts(FlexibleQuery, { staleTime: 60000, debounceMs: 500 });
      expect(slow.config?.staleTime).toBe(60000);
      expect(slow.config?.debounce).toBe(500);
    });

    it('should apply params-dependent getConfig() at runtime', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/data', { value: 'first' });

      class ParamCacheQuery extends RESTQuery {
        params = { staleTime: t.number };
        path = '/data';
        result = { value: t.string };

        getConfig() {
          return { staleTime: this.params.staleTime };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(ParamCacheQuery, { staleTime: 10000 });
        await relay;
        expect(mockFetch.calls).toHaveLength(1);

        mockFetch.get('/data', { value: 'second' });
        const relay2 = fetchQuery(ParamCacheQuery, { staleTime: 10000 });
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        relay2.value;
        await sleep(50);

        // staleTime=10000 means data is still fresh
        expect(mockFetch.calls).toHaveLength(1);
      });
    });
  });
});
