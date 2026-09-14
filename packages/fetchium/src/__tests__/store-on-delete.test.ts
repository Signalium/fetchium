import { describe, it, expect } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { hashValue } from 'signalium/utils';
import { AsyncQueryStore, type AsyncPersistentStore, type StoreMessage } from '../stores/async.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { valueKeyFor, refCountKeyFor, DEFAULT_MAX_COUNT } from '../stores/shared.js';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { createMockFetch, sleep } from './utils.js';

class MockAsyncPersistentStore implements AsyncPersistentStore {
  private readonly kv: Record<string, unknown> = Object.create(null);
  async has(key: string) {
    return key in this.kv;
  }
  async getString(key: string) {
    return this.kv[key] as string | undefined;
  }
  async setString(key: string, value: string) {
    this.kv[key] = value;
  }
  async getNumber(key: string) {
    return this.kv[key] as number | undefined;
  }
  async setNumber(key: string, value: number) {
    this.kv[key] = value;
  }
  async getBuffer(key: string) {
    return this.kv[key] as Uint32Array | undefined;
  }
  async setBuffer(key: string, value: Uint32Array) {
    this.kv[key] = value;
  }
  async delete(key: string) {
    delete this.kv[key];
  }
  async getAllKeys() {
    return Object.keys(this.kv);
  }
}

const queryDef = (id: string, maxCount: number) => ({ statics: { id, cache: { maxCount } } }) as any;

describe('QueryStore.onDelete', () => {
  it('SyncQueryStore reports every record it drops, including cascaded entities', () => {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const deleted: number[] = [];
    store.onDelete(key => deleted.push(key));

    const q1 = hashValue(['GET:/x', { id: '1' }]);
    const q2 = hashValue(['GET:/x', { id: '2' }]);
    const e1 = hashValue(['User', 1]);
    store.saveEntity(e1, { id: 1 });
    store.saveQuery(queryDef('GET:/x', 1), q1, { __entityRef: e1 }, Date.now(), new Set([e1]));
    expect(deleted).toEqual([]);

    // maxCount: 1 — q2 evicts q1, cascading to e1.
    store.saveQuery(queryDef('GET:/x', 1), q2, { __entityRef: 0 }, Date.now(), new Set());
    expect(deleted).toEqual([q1, e1]);
  });

  it('AsyncQueryStore writer reports drops once the writer processes them', async () => {
    const delegate = new MockAsyncPersistentStore();
    const writer = new AsyncQueryStore({
      isWriter: true,
      delegate,
      connect: (_handle: (msg: StoreMessage) => void) => ({ sendMessage: () => {} }),
    });
    const deleted: number[] = [];
    writer.onDelete(key => deleted.push(key));

    const q1 = hashValue(['GET:/y', { id: '1' }]);
    const e1 = hashValue(['User', 1]);
    writer.saveEntity(e1, { id: 1 });
    writer.saveQuery(queryDef('GET:/y', DEFAULT_MAX_COUNT), q1, { __entityRef: e1 }, Date.now(), new Set([e1]));
    await sleep(20);
    expect(deleted).toEqual([]);
    expect(await delegate.has(valueKeyFor(e1))).toBe(true);

    for (let i = 2; i <= DEFAULT_MAX_COUNT + 1; i++) {
      const q = hashValue(['GET:/y', { id: String(i) }]);
      writer.saveQuery(queryDef('GET:/y', DEFAULT_MAX_COUNT), q, { __entityRef: 0 }, Date.now(), new Set());
    }
    await sleep(100);
    expect(deleted).toEqual([q1, e1]);
    expect(await delegate.has(valueKeyFor(e1))).toBe(false);
    expect(await delegate.getNumber(refCountKeyFor(e1))).toBeUndefined();
  });

  it("AsyncQueryStore writer honors a query def's own cache.maxCount", async () => {
    const delegate = new MockAsyncPersistentStore();
    const writer = new AsyncQueryStore({
      isWriter: true,
      delegate,
      connect: (_handle: (msg: StoreMessage) => void) => ({ sendMessage: () => {} }),
    });
    const deleted: number[] = [];
    writer.onDelete(key => deleted.push(key));

    const q1 = hashValue(['GET:/z', { id: '1' }]);
    const q2 = hashValue(['GET:/z', { id: '2' }]);
    writer.saveQuery(queryDef('GET:/z', 1), q1, { __entityRef: 0 }, Date.now(), new Set());
    await sleep(20);
    expect(deleted).toEqual([]);

    // maxCount: 1 — the second key must evict the first, not wait for DEFAULT_MAX_COUNT.
    writer.saveQuery(queryDef('GET:/z', 1), q2, { __entityRef: 0 }, Date.now(), new Set());
    await sleep(20);
    expect(deleted).toEqual([q1]);
  });
});

describe('stores without onDelete', () => {
  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
  }
  class GetUser extends RESTQuery {
    path = '/user';
    result = { user: t.entity(User) };
  }

  it('fall back to writing every persisted apply, as before 0.6.0', async () => {
    // Implements QueryStore without onDelete.
    const inner = new SyncQueryStore(new MemoryPersistentStore());
    let entityWrites = 0;
    const store = {
      loadQuery: inner.loadQuery.bind(inner),
      saveQuery: inner.saveQuery.bind(inner),
      saveEntity: (...args: Parameters<SyncQueryStore['saveEntity']>) => {
        entityWrites++;
        inner.saveEntity(...args);
      },
      activateQuery: inner.activateQuery.bind(inner),
      deleteQuery: inner.deleteQuery.bind(inner),
    };

    const mockFetch = createMockFetch();
    mockFetch.get('/user', { user: { __typename: 'User', id: 1, name: 'Alice' } });
    const client = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
    } as any);

    const query = withContexts([[QueryClientContext, client]], () => {
      const q = fetchQuery(GetUser);
      watcher(() => (q as any).value).addListener(() => {});
      return q;
    });
    await query;
    const afterLoad = entityWrites;
    expect(afterLoad).toBeGreaterThan(0);

    await (query.value as any).__refetch();
    await sleep(5);
    // Identical data, but the store cannot vouch for the record.
    expect(entityWrites).toBe(afterLoad * 2);
    client.destroy();
  });
});
