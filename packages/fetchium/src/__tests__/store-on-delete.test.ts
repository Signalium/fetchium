import { describe, it, expect, vi } from 'vitest';
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

    // maxCount is 1, so q2 evicts q1 and cascades to e1.
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
    writer.onDelete!(key => deleted.push(key));

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
    writer.onDelete!(key => deleted.push(key));

    const q1 = hashValue(['GET:/z', { id: '1' }]);
    const q2 = hashValue(['GET:/z', { id: '2' }]);
    writer.saveQuery(queryDef('GET:/z', 1), q1, { __entityRef: 0 }, Date.now(), new Set());
    await sleep(20);
    expect(deleted).toEqual([]);

    // The def's maxCount of 1 applies, not DEFAULT_MAX_COUNT.
    writer.saveQuery(queryDef('GET:/z', 1), q2, { __entityRef: 0 }, Date.now(), new Set());
    await sleep(20);
    expect(deleted).toEqual([q1]);
  });

  it('SyncQueryStore still notifies the next listener when one unsubscribes during a deletion', () => {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const deleted: number[] = [];
    const unsubscribe = store.onDelete(() => unsubscribe());
    store.onDelete(key => deleted.push(key));

    const q1 = hashValue(['GET:/u', { id: '1' }]);
    store.saveQuery(queryDef('GET:/u', 10), q1, { __entityRef: 0 }, Date.now(), new Set());
    store.deleteQuery(q1);
    expect(deleted).toEqual([q1]);
  });

  it('AsyncQueryStore writer still notifies the next listener when one unsubscribes during a deletion', async () => {
    const writer = new AsyncQueryStore({
      isWriter: true,
      delegate: new MockAsyncPersistentStore(),
      connect: (_handle: (msg: StoreMessage) => void) => ({ sendMessage: () => {} }),
    });
    const deleted: number[] = [];
    const unsubscribe = writer.onDelete!(() => unsubscribe());
    writer.onDelete!(key => deleted.push(key));

    const q1 = hashValue(['GET:/v', { id: '1' }]);
    writer.saveQuery(queryDef('GET:/v', 10), q1, { __entityRef: 0 }, Date.now(), new Set());
    writer.deleteQuery(q1);
    await sleep(20);
    expect(deleted).toEqual([q1]);
  });

  it('SyncQueryStore finishes a cascade and notifies every listener when one throws', () => {
    const kv = new MemoryPersistentStore();
    const store = new SyncQueryStore(kv);
    const deleted: number[] = [];
    store.onDelete(() => {
      throw new Error('listener failed');
    });
    store.onDelete(key => deleted.push(key));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q1 = hashValue(['GET:/t', { id: '1' }]);
      const e1 = hashValue(['User', 1]);
      store.saveEntity(e1, { id: 1 });
      store.saveQuery(queryDef('GET:/t', 10), q1, { __entityRef: e1 }, Date.now(), new Set([e1]));
      store.deleteQuery(q1);
      expect(deleted).toEqual([q1, e1]);
      expect(kv.has(valueKeyFor(e1))).toBe(false);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('AsyncQueryStore writer finishes a cascade when a listener throws', async () => {
    const delegate = new MockAsyncPersistentStore();
    const writer = new AsyncQueryStore({
      isWriter: true,
      delegate,
      connect: (_handle: (msg: StoreMessage) => void) => ({ sendMessage: () => {} }),
    });
    const deleted: number[] = [];
    writer.onDelete!(() => {
      throw new Error('listener failed');
    });
    writer.onDelete!(key => deleted.push(key));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const q1 = hashValue(['GET:/w', { id: '1' }]);
      const e1 = hashValue(['User', 1]);
      writer.saveEntity(e1, { id: 1 });
      writer.saveQuery(queryDef('GET:/w', 10), q1, { __entityRef: e1 }, Date.now(), new Set([e1]));
      writer.deleteQuery(q1);
      await sleep(20);
      expect(deleted).toEqual([q1, e1]);
      expect(await delegate.has(valueKeyFor(e1))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('AsyncQueryStore writer keeps processing when a listener throws over a failed write', async () => {
    class FlakyStore extends MockAsyncPersistentStore {
      failNext: string | undefined;
      override async setString(key: string, value: string) {
        if (key === this.failNext) {
          this.failNext = undefined;
          throw new Error('injected failure');
        }
        return super.setString(key, value);
      }
    }
    const delegate = new FlakyStore();
    const writer = new AsyncQueryStore({
      isWriter: true,
      delegate,
      connect: (_handle: (msg: StoreMessage) => void) => ({ sendMessage: () => {} }),
    });
    const deleted: number[] = [];
    writer.onDelete!(() => {
      throw new Error('listener failed');
    });
    writer.onDelete!(key => deleted.push(key));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const e1 = hashValue(['User', 1]);
      const e2 = hashValue(['User', 2]);
      delegate.failNext = valueKeyFor(e1);
      writer.saveEntity(e1, { id: 1 });
      writer.saveEntity(e2, { id: 2 });
      await sleep(20);
      expect(deleted).toEqual([e1]);
      expect(await delegate.has(valueKeyFor(e2))).toBe(true);
      expect(writer.isSettled()).toBe(true);
    } finally {
      consoleError.mockRestore();
    }
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

  it('an AsyncQueryStore reader offers no onDelete, so its client writes every apply', async () => {
    const delegate = new MockAsyncPersistentStore();
    let writerHandle: ((msg: StoreMessage) => void) | undefined;
    const writer = new AsyncQueryStore({
      isWriter: true,
      delegate,
      connect: h => ((writerHandle = h), { sendMessage: () => {} }),
    });
    const reader = new AsyncQueryStore({
      isWriter: false,
      delegate,
      connect: () => ({ sendMessage: msg => writerHandle!(msg) }),
    });
    expect(writer.onDelete).toBeTypeOf('function');
    expect(reader.onDelete).toBeUndefined();

    const mockFetch = createMockFetch();
    mockFetch.get('/user', { user: { __typename: 'User', id: 1, name: 'Alice' } });
    const client = new QueryClient({
      store: reader,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
    } as any);
    const saveEntity = vi.spyOn(reader, 'saveEntity');

    const query = withContexts([[QueryClientContext, client]], () => {
      const q = fetchQuery(GetUser);
      watcher(() => (q as any).value).addListener(() => {});
      return q;
    });
    await query;
    const afterLoad = saveEntity.mock.calls.length;
    expect(afterLoad).toBeGreaterThan(0);

    await (query.value as any).__refetch();
    await sleep(5);
    // Deletions happen in the writer, so the reader cannot skip writes.
    expect(saveEntity.mock.calls.length).toBe(afterLoad * 2);
    client.destroy();
  });
});
