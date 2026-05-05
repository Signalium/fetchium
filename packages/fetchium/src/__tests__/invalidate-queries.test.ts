/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, it, expect } from 'vitest';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, sleep, setupTestClient } from './utils.js';
import { t } from '../typeDefs.js';

describe('invalidateQueries', () => {
  const getClient = setupTestClient();

  it('refetches a still-mounted consumer immediately', async () => {
    const { client, mockFetch } = getClient();

    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      // Long staleTime so the query would not refetch on its own.
      staleTime = 60_000;
    }

    mockFetch.get('/item', { value: 'first' });

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetItem);
      await relay;
      expect(relay.value!).toMatchObject({ value: 'first' });
      expect(mockFetch.calls).toHaveLength(1);

      mockFetch.get('/item', { value: 'second' });

      client.invalidateQueries([GetItem]);

      // markStale schedules the refetch via setTimeout(0); give it a tick
      // to fire and the fetch to resolve.
      await sleep(20);

      expect(mockFetch.calls).toHaveLength(2);
      expect(relay.value!).toMatchObject({ value: 'second' });
    });
  });

  it('marks an unmounted query stale without firing a fetch', async () => {
    const { client, mockFetch } = getClient();

    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      staleTime = 60_000;
    }

    mockFetch.get('/item', { value: 'first' });

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetItem);
      await relay;
      expect(mockFetch.calls).toHaveLength(1);
    });

    // Relay is now unmounted. Invalidate should not trigger a network call.
    mockFetch.get('/item', { value: 'second' });
    client.invalidateQueries([GetItem]);
    await sleep(20);
    expect(mockFetch.calls).toHaveLength(1);

    // Re-mounting picks up fresh data because updatedAt was reset.
    await testWithClient(client, async () => {
      const relay = fetchQuery(GetItem);
      // Touch to drive activation; cached value comes through immediately,
      // and the stale check on activation kicks a background refetch.
      relay.value;
      await sleep(50);
      expect(relay.value!).toMatchObject({ value: 'second' });
      expect(mockFetch.calls).toHaveLength(2);
    });
  });

  it('only refetches instances whose params match the filter', async () => {
    const { client, mockFetch } = getClient();

    class GetUser extends RESTQuery {
      params = { id: t.id };
      path = `/users/${this.params.id}`;
      result = { name: t.string };
      staleTime = 60_000;
    }

    mockFetch.get('/users/[id]', { name: 'Alice' });
    mockFetch.get('/users/[id]', { name: 'Bob' });

    await testWithClient(client, async () => {
      const r1 = fetchQuery(GetUser, { id: '1' });
      const r2 = fetchQuery(GetUser, { id: '2' });
      await Promise.all([r1, r2]);
      expect(mockFetch.calls).toHaveLength(2);

      // Refresh the route handlers so the next fetch returns updated data.
      mockFetch.reset();
      mockFetch.get('/users/[id]', { name: 'Alice v2' });

      client.invalidateQueries([[GetUser, { id: '1' }]]);
      await sleep(20);

      expect(mockFetch.calls).toHaveLength(1);
      expect(mockFetch.calls[0].url).toContain('/users/1');
      expect(r1.value!).toMatchObject({ name: 'Alice v2' });
      expect(r2.value!).toMatchObject({ name: 'Bob' });
    });
  });

  it('dedupes overlapping invalidations on the same instance', async () => {
    const { client, mockFetch } = getClient();

    class GetItem extends RESTQuery {
      path = '/item';
      result = { value: t.string };
      staleTime = 60_000;
    }

    mockFetch.get('/item', { value: 'first' });

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetItem);
      await relay;
      expect(mockFetch.calls).toHaveLength(1);

      mockFetch.get('/item', { value: 'second' });

      client.invalidateQueries([GetItem]);
      client.invalidateQueries([GetItem]);
      client.invalidateQueries([GetItem]);
      await sleep(20);

      // Three invalidations collapse into a single refetch.
      expect(mockFetch.calls).toHaveLength(2);
      expect(relay.value!).toMatchObject({ value: 'second' });
    });
  });
});
