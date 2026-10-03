import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { RESTQuery, RESTMutation } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { getMutation } from '../mutation.js';
import { NetworkManager } from '../NetworkManager.js';
import { defaultShouldRetry, getErrorStatus, type ShouldRetry } from '../retry.js';
import { createMockFetch, testWithClient } from './utils.js';
import { t } from '../typeDefs.js';

const user = { id: '1', name: 'Alice' };

/** An error shaped like a fetch wrapper's HTTP error (e.g. axios / request builders). */
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status } });
}

describe('shouldRetry', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let client: QueryClient;

  function createClient(shouldRetry?: ShouldRetry): QueryClient {
    return new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
      networkManager: new NetworkManager(true),
      shouldRetry,
    });
  }

  class GetUser extends RESTQuery {
    path = '/users/1';
    result = t.object({ id: t.string, name: t.string });
    config = { retry: { retries: 3, retryDelay: () => 1 } };
  }

  async function runFailing(query: new () => RESTQuery = GetUser): Promise<unknown> {
    let caught: unknown;
    await testWithClient(client, async () => {
      try {
        await fetchQuery(query as typeof GetUser);
      } catch (error) {
        caught = error;
      }
    });
    return caught;
  }

  beforeEach(() => {
    mockFetch = createMockFetch();
    client = createClient();
  });

  afterEach(() => {
    client.destroy();
  });

  describe('default', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      it(`does not retry a ${status} response whose body fails validation`, async () => {
        mockFetch.get('/users/1', { error: 'nope' }, { status });

        const error = await runFailing();

        expect(error).toBeDefined();
        expect(mockFetch.calls).toHaveLength(1);
      });
    }

    it('does not retry an error that carries a 4xx status', async () => {
      mockFetch.get('/users/1', null, { error: httpError(401) });

      const error = await runFailing();

      expect(error).toMatchObject({ response: { status: 401 } });
      expect(mockFetch.calls).toHaveLength(1);
    });

    for (const status of [408, 429, 500, 503]) {
      it(`retries a ${status} response`, async () => {
        mockFetch.get('/users/1', { error: 'busy' }, { status });

        await runFailing();

        expect(mockFetch.calls).toHaveLength(4);
      });
    }

    it('retries a 503 whose body is not JSON, then succeeds', async () => {
      mockFetch.get('/users/1', null, { status: 503, jsonError: new SyntaxError('Unexpected token <') });
      mockFetch.get('/users/1', user);

      await testWithClient(client, async () => {
        const result = fetchQuery(GetUser);
        await result;
        expect(result.value).toMatchObject(user);
      });
      expect(mockFetch.calls).toHaveLength(2);
    });

    it('retries an error that carries a 429 status', async () => {
      mockFetch.get('/users/1', null, { error: httpError(429) });

      await runFailing();

      expect(mockFetch.calls).toHaveLength(4);
    });

    it('retries network errors', async () => {
      mockFetch.get('/users/1', null, { error: new TypeError('Network request failed') });

      await runFailing();

      expect(mockFetch.calls).toHaveLength(4);
    });

    it('retries a 2xx response whose body fails validation', async () => {
      mockFetch.get('/users/1', { unexpected: true });

      await runFailing();

      expect(mockFetch.calls).toHaveLength(4);
    });

    it('does not take the status of an earlier response for a later network error', async () => {
      // Fetch 1 succeeds; the refetch fails with a network error, which must
      // not inherit a status from the response assigned by fetch 1.
      mockFetch.get('/users/1', user);
      mockFetch.get('/users/1', null, { error: new TypeError('Network request failed') });

      await testWithClient(client, async () => {
        const result = fetchQuery(GetUser);
        await result;
        await result.value!.__refetch().catch(() => {});
      });

      expect(mockFetch.calls).toHaveLength(5);
    });

    it('does not retry a 4xx page in fetchNext', async () => {
      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextPage: t.optional(t.number) };
        fetchNext = { searchParams: { page: this.result.nextPage } };
        config = { retry: { retries: 3, retryDelay: () => 1 } };
      }
      mockFetch.get('/items', { items: ['a'], nextPage: 2 });

      await testWithClient(client, async () => {
        const result = fetchQuery(GetItems);
        await result;
        mockFetch.get('/items', { error: 'bad page' }, { status: 400 });
        await expect(result.value!.__fetchNext()).rejects.toBeDefined();
      });

      expect(mockFetch.calls).toHaveLength(2);
    });
  });

  describe('custom', () => {
    it('client-level shouldRetry receives error, attempt and status', async () => {
      const seen: Array<[number, number | undefined]> = [];
      client.destroy();
      client = createClient((_error, attempt, status) => {
        seen.push([attempt, status]);
        return attempt < 1;
      });
      mockFetch.get('/users/1', { error: 'nope' }, { status: 404 });

      await runFailing();

      expect(mockFetch.calls).toHaveLength(2);
      expect(seen).toEqual([
        [0, 404],
        [1, 404],
      ]);
    });

    it('query-level shouldRetry overrides the client default', async () => {
      class GetUserRetry4xx extends RESTQuery {
        path = '/users/1';
        result = t.object({ id: t.string, name: t.string });
        config = { retry: { retries: 2, retryDelay: () => 1, shouldRetry: () => true } };
      }
      mockFetch.get('/users/1', { error: 'nope' }, { status: 400 });

      await runFailing(GetUserRetry4xx);

      expect(mockFetch.calls).toHaveLength(3);
    });

    it('query-level shouldRetry can stop retries the default would make', async () => {
      class GetUserNoRetry extends RESTQuery {
        path = '/users/1';
        result = t.object({ id: t.string, name: t.string });
        config = { retry: { retries: 3, retryDelay: () => 1, shouldRetry: () => false } };
      }
      mockFetch.get('/users/1', null, { error: new TypeError('Network request failed') });

      await runFailing(GetUserNoRetry);

      expect(mockFetch.calls).toHaveLength(1);
    });

    it('applies to mutations', async () => {
      class CreateUser extends RESTMutation {
        readonly path = '/users';
        readonly method = 'POST' as const;
        readonly params = { name: t.string };
        readonly body = { name: this.params.name };
        readonly result = { id: t.number };
        config = { retry: { retries: 2, retryDelay: () => 1 } };
      }
      mockFetch.post('/users', null, { error: httpError(422) });

      await testWithClient(client, async () => {
        const mut = getMutation(CreateUser);
        await expect(mut.run({ name: 'Test' })).rejects.toBeDefined();
      });

      expect(mockFetch.calls).toHaveLength(1);
    });
  });
});

describe('defaultShouldRetry', () => {
  it('classifies statuses', () => {
    const err = new Error('x');
    expect(defaultShouldRetry(err, 0, undefined)).toBe(true);
    expect(defaultShouldRetry(err, 0, 400)).toBe(false);
    expect(defaultShouldRetry(err, 0, 404)).toBe(false);
    expect(defaultShouldRetry(err, 0, 408)).toBe(true);
    expect(defaultShouldRetry(err, 0, 429)).toBe(true);
    expect(defaultShouldRetry(err, 0, 500)).toBe(true);
  });
});

describe('getErrorStatus', () => {
  it('reads status, statusCode and response.status', () => {
    expect(getErrorStatus({ status: 404 })).toBe(404);
    expect(getErrorStatus({ statusCode: 401 })).toBe(401);
    expect(getErrorStatus({ response: { status: 503 } })).toBe(503);
    expect(getErrorStatus({ response: null })).toBeUndefined();
    expect(getErrorStatus({ status: 'failed' })).toBeUndefined();
    expect(getErrorStatus(new Error('x'))).toBeUndefined();
    expect(getErrorStatus(undefined)).toBeUndefined();
  });
});
