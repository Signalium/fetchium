import { describe, it, expect } from 'vitest';
import { t } from '../typeDefs.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { watcher } from 'signalium';
import { testWithClient, setupTestClient } from './utils.js';

/**
 * Query Behavior Tests
 *
 * Tests query system behavior including:
 * - Error handling
 * - Path interpolation via queries
 * - Query definition caching
 * - HTTP method support
 * - Concurrent operations
 * - Memory and performance
 */

describe('Query Behavior', () => {
  const getClient = setupTestClient();

  describe('Error Handling', () => {
    it('should handle fetch errors gracefully', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/item', null, {
        error: new Error('Network error'),
      });

      await testWithClient(client, async () => {
        class GetItem extends RESTQuery {
          path = '/item';
          result = { data: t.string };
        }

        const relay = fetchQuery(GetItem);

        await expect(relay).rejects.toThrow('Network error');
        expect(relay.isRejected).toBe(true);
      });
    });

    it('should handle JSON parsing errors', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/item', null, {
        jsonError: new Error('Invalid JSON'),
      });

      await testWithClient(client, async () => {
        class GetItem extends RESTQuery {
          path = '/item';
          result = { data: t.string };
        }

        const relay = fetchQuery(GetItem);

        await expect(relay).rejects.toThrow('Invalid JSON');
      });
    });

    it('should require QueryClient context', () => {
      class GetItem extends RESTQuery {
        path = '/item';
        result = { data: t.string };
      }

      // Call without reactive context should throw
      expect(() => fetchQuery(GetItem)).toThrow();
    });
  });

  describe('Path Interpolation via Queries', () => {
    it('should handle paths with no parameters', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/static/path', { data: 'test' });

      await testWithClient(client, async () => {
        class GetItem extends RESTQuery {
          path = '/static/path';
          result = { data: t.string };
        }

        const relay = fetchQuery(GetItem);
        await relay;

        expect(mockFetch.calls[0].url).toBe('http://localhost/static/path');
      });
    });

    it('should handle multiple path parameters', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/org/[orgId]/team/[teamId]/user/[userId]', { data: 'test' });

      await testWithClient(client, async () => {
        class GetItem extends RESTQuery {
          params = { orgId: t.id, teamId: t.id, userId: t.id };
          path = `/org/${this.params.orgId}/team/${this.params.teamId}/user/${this.params.userId}`;
          result = { data: t.string };
        }

        const relay = fetchQuery(GetItem, { orgId: '1', teamId: '2', userId: '3' });
        await relay;

        expect(mockFetch.calls[0].url).toContain('/org/1/team/2/user/3');
      });
    });
  });

  describe('Query Definition Caching', () => {
    it('should cache query definition across calls', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/counter', { count: 1 });

      await testWithClient(client, async () => {
        class GetCounter extends RESTQuery {
          path = '/counter';
          result = { count: t.number };
        }

        // Call multiple times
        const relay1 = fetchQuery(GetCounter);
        const relay2 = fetchQuery(GetCounter);
        const relay3 = fetchQuery(GetCounter);

        // Should all return the same relay (deduplication)
        expect(relay1).toBe(relay2);
        expect(relay2).toBe(relay3);

        await relay1;

        // Should only fetch once
        expect(mockFetch.calls).toHaveLength(1);
      });
    });
  });

  describe('HTTP Method Support', () => {
    it('should include method in query ID', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { success: true });
      mockFetch.post('/items', { success: true });

      await testWithClient(client, async () => {
        class GetItem extends RESTQuery {
          path = '/items';
          method = 'GET' as const;
          result = { success: t.boolean };
        }

        class PostItem extends RESTQuery {
          path = '/items';
          method = 'POST' as const;
          result = { success: t.boolean };
        }

        const relay1 = fetchQuery(GetItem);
        const relay2 = fetchQuery(PostItem);

        // Different methods should create different relays
        expect(relay1).not.toBe(relay2);

        await Promise.all([relay1, relay2]);
      });
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle race conditions safely', async () => {
      const { client, mockFetch } = getClient();
      // Set up single mock response with delay - testing query deduplication
      mockFetch.get('/counter', { count: 1 }, { delay: 25 });

      await testWithClient(client, async () => {
        class GetCounter extends RESTQuery {
          path = '/counter';
          result = { count: t.number };
        }

        // Start many concurrent requests with random delays
        const promises = [];

        for (let i = 0; i < 20; i++) {
          const relay = fetchQuery(GetCounter);
          promises.push(relay);
        }

        // All should resolve to the same value (deduplication)
        const results = await Promise.all(promises);

        // Should only fetch once despite concurrent requests
        expect(mockFetch.calls).toHaveLength(1);

        // All results should be identical
        results.forEach(result => {
          expect(result.count).toBe(1);
        });
      });
    });

    it('should handle many concurrent queries', async () => {
      const { client, mockFetch } = getClient();
      // Set up 50 individual mock responses
      for (let i = 0; i < 50; i++) {
        mockFetch.get('/items/[id]', { url: `/items/${i}` });
      }

      await testWithClient(client, async () => {
        class GetItem extends RESTQuery {
          params = { id: t.id };
          path = `/items/${this.params.id}`;
          result = { url: t.string };
        }

        const relays = [];

        // Create 50 concurrent queries
        for (let i = 0; i < 50; i++) {
          const relay = fetchQuery(GetItem, { id: String(i) });
          relays.push(relay);
        }

        // Wait for all to complete
        await Promise.all(relays);

        // Should have handled all queries
        expect(mockFetch.calls).toHaveLength(50);
      });
    });
  });

  describe('Memory and Watchers', () => {
    it('should cleanup watchers properly', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/counter', { count: 1 });

      await testWithClient(client, async () => {
        class GetCounter extends RESTQuery {
          path = '/counter';
          result = { count: t.number };
        }

        const relay = fetchQuery(GetCounter);

        // Create and immediately cleanup multiple watchers
        for (let i = 0; i < 10; i++) {
          const w = watcher(() => relay.value);
          const unsub = w.addListener(() => {});
          unsub();
        }

        // Relay should still work
        await relay;

        expect(relay.isReady).toBe(true);
      });
    });
  });
});
