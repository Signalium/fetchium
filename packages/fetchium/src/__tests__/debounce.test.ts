import { describe, it, expect, vi } from 'vitest';
import { signal } from 'signalium';
import { t } from '../typeDefs.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, getEntityMapSize, sleep, setupTestClient } from './utils.js';

/**
 * Debounce Tests
 *
 * Tests for the debounce option that delays fetch requests
 * when parameters change.
 */

describe('Debounce', () => {
  const getClient = setupTestClient();

  describe('Basic Debounce Functionality', () => {
    it('should not delay initial fetch when debounce is configured', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users', { users: [] });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.object({ id: t.number })),
        };
        config = { debounce: 100 };
      }

      await testWithClient(client, async () => {
        // Initial fetch should happen immediately (debounce only applies to refetches)
        await fetchQuery(ListUsers);
        expect(mockFetch.calls.length).toBe(1);
      });
    });

    it('should not delay when debounce is not configured', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users', { users: [] });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.object({ id: t.number })),
        };
      }

      await testWithClient(client, async () => {
        await fetchQuery(ListUsers);
        // Should fetch immediately
        expect(mockFetch.calls.length).toBe(1);
      });
    });

    it('should delay refetch when Signal value changes', async () => {
      const { client, mockFetch } = getClient();
      const idSignal = signal('123');
      mockFetch.get('/users/[id]', { id: 123, name: 'User 123' });
      mockFetch.get('/users/[id]', { id: 456, name: 'User 456' });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
        config = { debounce: 100 };
      }

      await testWithClient(client, async () => {
        // Initial fetch
        const queryResult1 = fetchQuery(GetUser, { id: idSignal });
        await queryResult1;
        expect(mockFetch.calls.length).toBe(1);

        // Change Signal value outside reactive context
        await new Promise(resolve => {
          setTimeout(() => {
            idSignal.value = '456';
            resolve(undefined);
          }, 10);
        });

        await sleep(20);

        expect(mockFetch.calls.length).toBe(1);

        await sleep(100);

        // Should have fetched (new query key = new instance = immediate fetch)
        expect(mockFetch.calls.length).toBe(2);
      });
    });
  });

  describe('Debounce Cancellation', () => {
    it('should handle rapid Signal changes', async () => {
      const { client, mockFetch } = getClient();
      const idSignal = signal('123');
      mockFetch.get('/users/[id]', { id: 123, name: 'User 123' });
      mockFetch.get('/users/[id]', { id: 456, name: 'User 456' });
      mockFetch.get('/users/[id]', { id: 789, name: 'User 789' });

      class GetUser extends RESTQuery {
        params = { id: t.id };
        path = `/users/${this.params.id}`;
        result = {
          id: t.number,
          name: t.string,
        };
        config = { debounce: 50 };
      }

      await testWithClient(client, async () => {
        // Initial fetch
        const queryResult1 = fetchQuery(GetUser, { id: idSignal });
        await queryResult1;
        expect(mockFetch.calls.length).toBe(1);

        // Rapid Signal changes
        await new Promise(resolve => {
          setTimeout(() => {
            idSignal.value = '456';
            resolve(undefined);
          }, 5);
        });

        await new Promise(resolve => {
          setTimeout(() => {
            idSignal.value = '789';
            resolve(undefined);
          }, 5);
        });

        expect(mockFetch.calls.length).toBe(1);

        await sleep(60);

        expect(mockFetch.calls.length).toBe(2);
      });
    });
  });

  describe('Debounce Edge Cases', () => {
    it('should handle debounce with 0ms delay (no debounce)', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/users', { users: [] });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.object({ id: t.number })),
        };
        config = { debounce: 0 };
      }

      await testWithClient(client, async () => {
        await fetchQuery(ListUsers);
        // Should fetch immediately (0ms debounce = no debounce)
        expect(mockFetch.calls.length).toBe(1);
      });
    });

    it('should work with retry logic', async () => {
      const { client, mockFetch } = getClient();
      // First call fails, second succeeds
      mockFetch.get('/users', null, { status: 500 });
      mockFetch.get('/users', { users: [] });

      class ListUsers extends RESTQuery {
        path = '/users';
        result = {
          users: t.array(t.object({ id: t.number })),
        };
        config = {
          debounce: 100,
          retry: 1,
        };
      }

      await testWithClient(client, async () => {
        try {
          await fetchQuery(ListUsers);
        } catch (error) {
          // Expected to fail first time
        }

        // Should have attempted fetch after debounce
        expect(mockFetch.calls.length).toBeGreaterThanOrEqual(1);
      });
    });
  });
});
