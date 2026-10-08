import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QueryClient } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { RESTQuery, RESTMutation } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { getMutation } from '../mutation.js';
import { NetworkManager } from '../NetworkManager.js';
import { getErrorStatus, type ShouldRetry } from '../retry.js';
import { createMockFetch, testWithClient } from './utils.js';
import { t } from '../typeDefs.js';

const user = { id: '1', name: 'Alice' };

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

  class CreateUser extends RESTMutation {
    readonly path = '/users';
    readonly method = 'POST' as const;
    readonly params = { name: t.string };
    readonly body = { name: this.params.name };
    readonly result = { id: t.number };
    config = { retry: { retries: 2, retryDelay: () => 1 } };
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
    for (const status of [400, 401, 403, 404, 408, 422, 429, 500, 503]) {
      it(`retries a ${status} response whose body fails validation`, async () => {
        mockFetch.get('/users/1', { error: 'nope' }, { status });

        const error = await runFailing();

        expect(error).toBeDefined();
        expect(mockFetch.calls).toHaveLength(4);
      });
    }

    it('retries an error that carries a 4xx status', async () => {
      mockFetch.get('/users/1', null, { error: httpError(401) });

      const error = await runFailing();

      expect(error).toMatchObject({ response: { status: 401 } });
      expect(mockFetch.calls).toHaveLength(4);
    });

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

    it('retries a 4xx page in fetchNext', async () => {
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

      expect(mockFetch.calls).toHaveLength(5);
    });

    it('retries a mutation that enables retries, whatever the status', async () => {
      mockFetch.post('/users', null, { error: httpError(422) });

      await testWithClient(client, async () => {
        const mut = getMutation(CreateUser);
        await expect(mut.run({ name: 'Test' })).rejects.toBeDefined();
      });

      expect(mockFetch.calls).toHaveLength(3);
    });
  });

  describe('custom', () => {
    const skipClientErrors: ShouldRetry = (_error, _attempt, status) =>
      status === undefined || status < 400 || status >= 500 || status === 408 || status === 429;

    function useSkipClientErrors(): void {
      client.destroy();
      client = createClient(skipClientErrors);
    }

    it('client-level shouldRetry receives error, attempt and status', async () => {
      const seen: Array<[unknown, number, number | undefined]> = [];
      client.destroy();
      client = createClient((error, attempt, status) => {
        seen.push([error, attempt, status]);
        return attempt < 1;
      });
      mockFetch.get('/users/1', { error: 'nope' }, { status: 404 });

      const error = await runFailing();

      expect(mockFetch.calls).toHaveLength(2);
      expect(seen.map(([, attempt, status]) => [attempt, status])).toEqual([
        [0, 404],
        [1, 404],
      ]);
      expect(seen[1][0]).toBe(error);
    });

    it('passes the status carried by the error', async () => {
      const statuses: Array<number | undefined> = [];
      client.destroy();
      client = createClient((_error, _attempt, status) => {
        statuses.push(status);
        return true;
      });
      mockFetch.get('/users/1', null, { error: httpError(401) });

      await runFailing();

      expect(statuses).toEqual([401, 401, 401]);
    });

    for (const status of [400, 401, 404, 422]) {
      it(`client-level shouldRetry returning false for ${status} makes one attempt`, async () => {
        useSkipClientErrors();
        mockFetch.get('/users/1', { error: 'nope' }, { status });

        await runFailing();

        expect(mockFetch.calls).toHaveLength(1);
      });
    }

    it('client-level shouldRetry returning false for a 4xx error makes one attempt', async () => {
      useSkipClientErrors();
      mockFetch.get('/users/1', null, { error: httpError(401) });

      const error = await runFailing();

      expect(error).toMatchObject({ response: { status: 401 } });
      expect(mockFetch.calls).toHaveLength(1);
    });

    for (const status of [408, 429, 503]) {
      it(`client-level shouldRetry still retries what it allows (${status})`, async () => {
        useSkipClientErrors();
        mockFetch.get('/users/1', { error: 'busy' }, { status });

        await runFailing();

        expect(mockFetch.calls).toHaveLength(4);
      });
    }

    it('query-level shouldRetry returning false for 4xx makes one attempt', async () => {
      class GetUserSkip4xx extends RESTQuery {
        path = '/users/1';
        result = t.object({ id: t.string, name: t.string });
        config = { retry: { retries: 3, retryDelay: () => 1, shouldRetry: skipClientErrors } };
      }
      mockFetch.get('/users/1', { error: 'nope' }, { status: 404 });

      await runFailing(GetUserSkip4xx);

      expect(mockFetch.calls).toHaveLength(1);
    });

    it('query-level shouldRetry overrides the client-level one', async () => {
      useSkipClientErrors();
      class GetUserRetry4xx extends RESTQuery {
        path = '/users/1';
        result = t.object({ id: t.string, name: t.string });
        config = { retry: { retries: 2, retryDelay: () => 1, shouldRetry: () => true } };
      }
      mockFetch.get('/users/1', { error: 'nope' }, { status: 400 });

      await runFailing(GetUserRetry4xx);

      expect(mockFetch.calls).toHaveLength(3);
    });

    it('query-level shouldRetry can stop retries of a network error', async () => {
      class GetUserNoRetry extends RESTQuery {
        path = '/users/1';
        result = t.object({ id: t.string, name: t.string });
        config = { retry: { retries: 3, retryDelay: () => 1, shouldRetry: () => false } };
      }
      mockFetch.get('/users/1', null, { error: new TypeError('Network request failed') });

      await runFailing(GetUserNoRetry);

      expect(mockFetch.calls).toHaveLength(1);
    });

    it('does not pass an earlier response status for a later network error', async () => {
      // Attempt 0 gets a 404, every later attempt a network error.
      const statuses: Array<number | undefined> = [];
      client.destroy();
      client = createClient((_error, _attempt, status) => {
        statuses.push(status);
        return true;
      });
      mockFetch.get('/users/1', { error: 'nope' }, { status: 404 });
      mockFetch.get('/users/1', null, { error: new TypeError('Network request failed') });

      await runFailing();

      expect(mockFetch.calls).toHaveLength(4);
      expect(statuses).toEqual([404, undefined, undefined]);
    });

    it('does not pass the status of an earlier fetch for a refetch network error', async () => {
      const statuses: Array<number | undefined> = [];
      client.destroy();
      client = createClient((_error, _attempt, status) => {
        statuses.push(status);
        return true;
      });
      mockFetch.get('/users/1', user);
      mockFetch.get('/users/1', null, { error: new TypeError('Network request failed') });

      await testWithClient(client, async () => {
        const result = fetchQuery(GetUser);
        await result;
        await result.value!.__refetch().catch(() => {});
      });

      expect(mockFetch.calls).toHaveLength(5);
      expect(statuses).toEqual([undefined, undefined, undefined]);
    });

    it('client-level shouldRetry returning false for a 4xx page in fetchNext makes one attempt', async () => {
      useSkipClientErrors();
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

    it('applies to mutations', async () => {
      useSkipClientErrors();
      mockFetch.post('/users', null, { error: httpError(422) });

      await testWithClient(client, async () => {
        const mut = getMutation(CreateUser);
        await expect(mut.run({ name: 'Test' })).rejects.toBeDefined();
      });

      expect(mockFetch.calls).toHaveLength(1);
    });

    it('passes the status of a mutation 4xx whose body is not JSON', async () => {
      const statuses: Array<number | undefined> = [];
      client.destroy();
      client = createClient((error, attempt, status) => {
        statuses.push(status);
        return skipClientErrors(error, attempt, status);
      });
      mockFetch.post('/users', null, { status: 422, jsonError: new SyntaxError('Unexpected token <') });

      await testWithClient(client, async () => {
        const mut = getMutation(CreateUser);
        await expect(mut.run({ name: 'Test' })).rejects.toBeInstanceOf(SyntaxError);
      });

      expect(mockFetch.calls).toHaveLength(1);
      expect(statuses).toEqual([422]);
    });
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
