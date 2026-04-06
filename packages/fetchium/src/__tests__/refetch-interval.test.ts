import { describe, it, expect } from 'vitest';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, sleep, setupTestClient } from './utils.js';
import { t } from '../typeDefs.js';
import { GcManager } from '../GcManager.js';
import { poll } from '../subscriptions/polling.js';

/**
 * Poll-based Subscription Tests
 *
 * Tests poll() subscribe factory with per-query timers,
 * subscriber tracking, no overlapping fetches, and getInterval support.
 */

describe('Poll Subscribe', () => {
  const getClient = setupTestClient({ evictionMultiplier: 0.001 });

  describe('Basic Polling', () => {
    it('should refetch at specified interval', async () => {
      const { client, mockFetch } = getClient();
      let callCount = 0;
      mockFetch.get('/counter', () => ({ count: ++callCount }));

      class GetCounter extends RESTQuery {
        path = '/counter';
        result = { count: t.number };
        config = { subscribe: poll({ interval: 100 }) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetCounter);
        await relay;
        expect(relay.value!).toMatchObject({ count: 1 });

        await sleep(120);
        expect(relay.value?.count).toBeGreaterThan(1);

        await sleep(110);
        expect(relay.value?.count).toBeGreaterThan(2);
      });
    });

    it('should stop polling when query is no longer accessed', async () => {
      const { client, mockFetch } = getClient();
      let callCount = 0;
      mockFetch.get('/item', () => ({ n: ++callCount }));

      class GetItem extends RESTQuery {
        path = '/item';
        result = { n: t.number };
        config = { subscribe: poll({ interval: 100 }) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItem);
        await relay;
        const initialCount = relay.value!.n;

        await sleep(250);
        const afterCount = relay.value!.n;

        expect(afterCount).toBeGreaterThan(initialCount);
      });

      const countBeforeWait = callCount;
      await sleep(200);
      expect(callCount).toBe(countBeforeWait);
    });

    it('should resume polling after deactivation and re-activation', async () => {
      const { client, mockFetch } = getClient();
      let callCount = 0;
      mockFetch.get('/reactivate', () => ({ n: ++callCount }));

      class GetReactivate extends RESTQuery {
        path = '/reactivate';
        result = { n: t.number };
        config = { gcTime: Infinity, subscribe: poll({ interval: 100 }) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetReactivate);
        await relay;
        await sleep(250);
        expect(callCount).toBeGreaterThan(1);
      });

      const countAfterDeactivation = callCount;
      await sleep(200);
      expect(callCount).toBe(countAfterDeactivation);

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetReactivate);
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        relay.value;
        await sleep(250);
        expect(callCount).toBeGreaterThan(countAfterDeactivation);
      });
    });
  });

  describe('Multiple Intervals', () => {
    it('should handle multiple queries with different intervals independently', async () => {
      const { client, mockFetch } = getClient();
      let count1 = 0;
      let count5 = 0;

      mockFetch.get('/every100ms', () => ({ count: ++count1 }));
      mockFetch.get('/every500ms', () => ({ count: ++count5 }));

      class GetEvery100ms extends RESTQuery {
        path = '/every100ms';
        result = { count: t.number };
        config = { subscribe: poll({ interval: 100 }) };
      }

      class GetEvery500ms extends RESTQuery {
        path = '/every500ms';
        result = { count: t.number };
        config = { subscribe: poll({ interval: 500 }) };
      }

      await testWithClient(client, async () => {
        const relay100 = fetchQuery(GetEvery100ms);
        const relay500 = fetchQuery(GetEvery500ms);

        await relay100;
        await relay500;

        await sleep(350);

        expect(count1).toBeGreaterThanOrEqual(3);
        expect(count1).toBeLessThanOrEqual(5);

        expect(count5).toBeGreaterThanOrEqual(1);
        expect(count5).toBeLessThanOrEqual(2);

        await sleep(200);

        expect(count5).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('No Overlapping Fetches', () => {
    it('should wait for previous fetch to complete before next refetch', async () => {
      const { client, mockFetch } = getClient();
      let activeFetches = 0;
      let maxConcurrent = 0;
      let fetchCount = 0;

      mockFetch.get('/slow', async () => {
        activeFetches++;
        maxConcurrent = Math.max(maxConcurrent, activeFetches);
        fetchCount++;
        await sleep(80);
        activeFetches--;
        return { count: fetchCount };
      });

      class GetSlow extends RESTQuery {
        path = '/slow';
        result = { count: t.number };
        config = { subscribe: poll({ interval: 100 }) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetSlow);
        await relay;

        await sleep(350);

        expect(maxConcurrent).toBe(1);
        expect(fetchCount).toBeGreaterThan(1);
      });
    });
  });

  describe('Edge Cases', () => {
    it('should handle query without poll subscribe', async () => {
      const { client, mockFetch } = getClient();
      let callCount = 0;
      mockFetch.get('/no-interval', () => ({ n: ++callCount }));

      class GetItem extends RESTQuery {
        path = '/no-interval';
        result = { n: t.number };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItem);
        await relay;
        expect(relay.value!).toMatchObject({ n: 1 });

        await sleep(200);

        expect(callCount).toBe(1);
      });
    });

    it('should handle fast intervals', async () => {
      const { client, mockFetch } = getClient();
      let callCount = 0;
      mockFetch.get('/fast', () => ({ count: ++callCount }));

      class GetFast extends RESTQuery {
        path = '/fast';
        result = { count: t.number };
        config = { subscribe: poll({ interval: 50 }) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetFast);
        await relay;

        await sleep(250);

        expect(callCount).toBeGreaterThanOrEqual(3);
      });
    });
  });

  describe('getConfig subscribe', () => {
    it('supports getConfig() for dynamic poll configuration', async () => {
      const { client, mockFetch } = getClient();
      let callCount = 0;
      mockFetch.get('/gs-dynamic', () => ({ v: ++callCount }));

      class GetGsDynamic extends RESTQuery {
        path = '/gs-dynamic';
        result = { v: t.number };

        getConfig() {
          return { subscribe: poll({ interval: 100 }) };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetGsDynamic);
        await relay;
        await sleep(250);
        expect(callCount).toBeGreaterThanOrEqual(3);
      });
    });

  });
});
