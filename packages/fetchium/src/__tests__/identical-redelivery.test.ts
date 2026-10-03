import { describe, it, expect, vi, afterEach } from 'vitest';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { EntityInstance } from '../EntityInstance.js';
import { LiveCollectionBinding } from '../LiveCollection.js';
import { QueryClient } from '../QueryClient.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import type { MutationEvent, QueryPromise } from '../types.js';
import { testWithClient, setupTestClient } from './utils.js';

/**
 * Identical Re-delivery
 *
 * A stream reconnect re-snapshots every topic, so every entity on screen is
 * re-delivered with the data the store already holds — as a query result, as a
 * mutation event, or as a topic event. None of those may notify an entity, bump
 * its version, write it, or notify a live collection. A real change still
 * notifies exactly once.
 */

/** Records `typename:id` for every entity notify. */
function recordNotifies() {
  const notified: string[] = [];
  const original = EntityInstance.prototype.notify;
  const spy = vi.spyOn(EntityInstance.prototype, 'notify').mockImplementation(function (this: EntityInstance) {
    notified.push(`${this.typename}:${this.id}`);
    original.call(this);
  });
  return { notified, restore: () => spy.mockRestore() };
}

function savesOf(spy: ReturnType<typeof vi.spyOn>, typename: string) {
  return spy.mock.calls.filter(([, value]) => (value as Record<string, unknown>)?.__typename === typename);
}

class Owner extends Entity {
  __typename = t.typename('Owner');
  id = t.id;
  name = t.string;
}

class Token extends Entity {
  __typename = t.typename('Token');
  id = t.id;
  walletId = t.string;
  symbol = t.string;
  price = t.number;
  issued = t.format('date-time');
  metadata = t.object({ logo: t.string, tags: t.array(t.string) });
  owner = t.entity(Owner);
}

class Wallet extends Entity {
  __typename = t.typename('Wallet');
  id = t.id;
  tokens = t.liveArray(Token, { constraints: { walletId: (this as unknown as { id: string }).id } });
  tokenCount = t.liveValue(t.number, Token, {
    constraints: { walletId: (this as unknown as { id: string }).id },
    onCreate: (v: number) => v + 1,
    onUpdate: (v: number) => v,
    onDelete: (v: number) => v - 1,
  });
}

function token(i: number, overrides: { price?: number; owner?: string } = {}) {
  return {
    __typename: 'Token',
    id: `tok-${i}`,
    walletId: 'w-1',
    symbol: `SYM${i}`,
    price: overrides.price ?? i,
    issued: '2026-01-01T00:00:00.000Z',
    metadata: { logo: `logo-${i}.png`, tags: ['defi', 'l1'] },
    owner: { __typename: 'Owner', id: 'o-1', name: overrides.owner ?? 'Ann' },
  };
}

function wallet(count: number, override?: (i: number) => { price?: number; owner?: string }) {
  return {
    wallet: {
      __typename: 'Wallet',
      id: 'w-1',
      tokenCount: count,
      tokens: Array.from({ length: count }, (_, i) => token(i, override?.(i))),
    },
  };
}

const tokenKey = (i: number) => hashValue(['Token', `tok-${i}`]);
const ownerKey = hashValue(['Owner', 'o-1']);
const walletKey = hashValue(['Wallet', 'w-1']);

function versions(client: QueryClient, keys: number[]) {
  return keys.map(k => client.entityMap.getEntity(k)!.version);
}

/** Spies on the notifiers of a wallet's live array and live value. */
function liveNotifies(client: QueryClient) {
  const data = client.entityMap.getEntity(walletKey)!.data;
  const tokens = data.tokens as LiveCollectionBinding;
  const count = data.tokenCount as LiveCollectionBinding;
  return {
    tokens: vi.spyOn((tokens.instance as unknown as { _notifier: { notify(): void } })._notifier, 'notify'),
    count: vi.spyOn((count.instance as unknown as { _notifier: { notify(): void } })._notifier, 'notify'),
  };
}

// ======================================================
// Query results
// ======================================================

class GetWallet extends RESTQuery {
  path = '/wallet';
  result = { wallet: t.entity(Wallet) };
}

describe('Identical re-delivery', () => {
  const getClient = setupTestClient();
  let recorder: ReturnType<typeof recordNotifies> | undefined;

  afterEach(() => {
    recorder?.restore();
    recorder = undefined;
    vi.restoreAllMocks();
  });

  async function loadWallet(count: number) {
    const tc = getClient();
    tc.mockFetch.get('/wallet', wallet(count));
    let query!: QueryPromise<GetWallet>;
    await testWithClient(tc.client, async () => {
      query = fetchQuery(GetWallet);
      await query;
    });
    return { ...tc, query };
  }

  describe('(a) query result', () => {
    it('is a no-op when a refetch re-delivers identical data', async () => {
      const { client, mockFetch, store, query } = await loadWallet(3);
      const keys = [walletKey, ownerKey, tokenKey(0), tokenKey(1), tokenKey(2)];
      const before = versions(client, keys);

      const saveEntity = vi.spyOn(store, 'saveEntity');
      const live = liveNotifies(client);
      recorder = recordNotifies();

      await testWithClient(client, async () => {
        mockFetch.get('/wallet', wallet(3));
        (query.value as unknown as { __refetch(): void }).__refetch();
        await query;
      });

      expect(recorder.notified).toEqual([]);
      expect(versions(client, keys)).toEqual(before);
      expect(saveEntity).not.toHaveBeenCalled();
      expect(live.tokens).not.toHaveBeenCalled();
      expect(live.count).not.toHaveBeenCalled();
    });

    it('(d) notifies only the changed parent when its nested entity is unchanged', async () => {
      const { client, mockFetch, store, query } = await loadWallet(2);
      const [ownerBefore, tok0Before, tok1Before] = versions(client, [ownerKey, tokenKey(0), tokenKey(1)]);

      const saveEntity = vi.spyOn(store, 'saveEntity');
      const live = liveNotifies(client);
      recorder = recordNotifies();

      await testWithClient(client, async () => {
        mockFetch.get(
          '/wallet',
          wallet(2, i => (i === 1 ? { price: 99 } : {})),
        );
        (query.value as unknown as { __refetch(): void }).__refetch();
        await query;
      });

      expect(recorder.notified).toEqual(['Token:tok-1']);
      expect(versions(client, [ownerKey, tokenKey(0), tokenKey(1)])).toEqual([ownerBefore, tok0Before, tok1Before + 1]);
      expect(savesOf(saveEntity, 'Token')).toHaveLength(1);
      expect(savesOf(saveEntity, 'Owner')).toHaveLength(0);
      expect(savesOf(saveEntity, 'Wallet')).toHaveLength(0);
      expect(live.tokens).not.toHaveBeenCalled();
      expect(live.count).not.toHaveBeenCalled();
    });
  });

  // ======================================================
  // Mutation events
  // ======================================================

  describe('(b) mutation event', () => {
    it('is a no-op for a full update carrying identical data, nested values included', async () => {
      const { client, store } = await loadWallet(2);
      const keys = [walletKey, ownerKey, tokenKey(0), tokenKey(1)];
      const before = versions(client, keys);
      const metadata = client.entityMap.getEntity(tokenKey(0))!.data.metadata;

      const saveEntity = vi.spyOn(store, 'saveEntity');
      const live = liveNotifies(client);
      recorder = recordNotifies();

      client.applyMutationEvent({ type: 'update', typename: 'Token', data: token(0) });
      client.applyMutationEvent({ type: 'update', typename: 'Owner', data: { id: 'o-1', name: 'Ann' } });

      expect(recorder.notified).toEqual([]);
      expect(versions(client, keys)).toEqual(before);
      expect(saveEntity).not.toHaveBeenCalled();
      expect(live.tokens).not.toHaveBeenCalled();
      expect(live.count).not.toHaveBeenCalled();

      // A `create` for an entity the store already holds is the same no-op for
      // the entity and the live array. (The live value's `onCreate` reducer
      // still runs: it is told about a create, not about a change.)
      client.applyMutationEvent({ type: 'create', typename: 'Token', data: token(0) });
      client.applyMutationEvent({ type: 'create', typename: 'Owner', data: { id: 'o-1', name: 'Ann' } });

      expect(recorder.notified).toEqual([]);
      expect(versions(client, keys)).toEqual(before);
      expect(saveEntity).not.toHaveBeenCalled();
      expect(live.tokens).not.toHaveBeenCalled();
      // The unchanged nested object keeps its identity.
      expect(client.entityMap.getEntity(tokenKey(0))!.data.metadata).toBe(metadata);
    });

    it('notifies exactly once for a real field change', async () => {
      const { client, store } = await loadWallet(2);
      const [ownerBefore, tokBefore] = versions(client, [ownerKey, tokenKey(0)]);

      const saveEntity = vi.spyOn(store, 'saveEntity');
      recorder = recordNotifies();

      client.applyMutationEvent({ type: 'update', typename: 'Token', data: token(0, { price: 42 }) });

      expect(recorder.notified).toEqual(['Token:tok-0']);
      expect(versions(client, [ownerKey, tokenKey(0)])).toEqual([ownerBefore, tokBefore + 1]);
      expect(savesOf(saveEntity, 'Token')).toHaveLength(1);
      expect(savesOf(saveEntity, 'Owner')).toHaveLength(0);
      expect(client.entityMap.getEntity(tokenKey(0))!.data.price).toBe(42);
    });

    it('(d) notifies only the nested entity that changed inside an unchanged parent', async () => {
      const { client, store } = await loadWallet(2);
      const [ownerBefore, tokBefore] = versions(client, [ownerKey, tokenKey(0)]);

      const saveEntity = vi.spyOn(store, 'saveEntity');
      recorder = recordNotifies();

      client.applyMutationEvent({ type: 'update', typename: 'Token', data: token(0, { owner: 'Bea' }) });

      expect(recorder.notified).toEqual(['Owner:o-1']);
      expect(versions(client, [ownerKey, tokenKey(0)])).toEqual([ownerBefore + 1, tokBefore]);
      expect(savesOf(saveEntity, 'Owner')).toHaveLength(1);
      expect(savesOf(saveEntity, 'Token')).toHaveLength(0);
    });
  });
});

// ======================================================
// Topic events
// ======================================================

class MockTopicAdapter extends TopicQueryAdapter {
  snapshots = new Map<string, unknown>();

  subscribe(topic: string): void {
    this.fulfillTopic(topic, this.snapshots.get(topic));
  }

  unsubscribe(topic: string): void {
    this.clearTopic(topic);
  }

  emit(event: MutationEvent): void {
    this.sendMutationEvent(event);
  }
}

class WalletTopic extends TopicQuery {
  static override adapter = MockTopicAdapter;
  topic = 'wallet:w-1';
  result = { wallet: t.entity(Wallet) };
}

describe('(c) topic events', () => {
  let client: QueryClient;
  let adapter: MockTopicAdapter;
  let store: SyncQueryStore;
  let recorder: ReturnType<typeof recordNotifies> | undefined;

  afterEach(() => {
    recorder?.restore();
    recorder = undefined;
    vi.restoreAllMocks();
    client?.destroy();
  });

  async function loadTopic(count: number) {
    store = new SyncQueryStore(new MemoryPersistentStore());
    adapter = new MockTopicAdapter();
    adapter.snapshots.set('wallet:w-1', wallet(count));
    client = new QueryClient({ store, adapters: [adapter] } as never);
    await testWithClient(client, async () => {
      const query = fetchQuery(WalletTopic);
      await query;
      expect((query.value as unknown as { wallet: { tokens: unknown[] } }).wallet.tokens).toHaveLength(count);
    });
  }

  it('is a no-op when a reconnect re-snapshots every entity as topic events', async () => {
    await loadTopic(3);
    const keys = [walletKey, ownerKey, tokenKey(0), tokenKey(1), tokenKey(2)];
    const before = versions(client, keys);

    const saveEntity = vi.spyOn(store, 'saveEntity');
    const live = liveNotifies(client);
    recorder = recordNotifies();

    for (let i = 0; i < 3; i++) adapter.emit({ type: 'update', typename: 'Token', data: token(i) });
    adapter.emit({ type: 'update', typename: 'Wallet', data: { id: 'w-1' } });

    expect(recorder.notified).toEqual([]);
    expect(versions(client, keys)).toEqual(before);
    expect(saveEntity).not.toHaveBeenCalled();
    expect(live.tokens).not.toHaveBeenCalled();
    expect(live.count).not.toHaveBeenCalled();
  });

  it('notifies exactly once for a topic event that changes a field', async () => {
    await loadTopic(2);
    const [walletBefore, tokBefore] = versions(client, [walletKey, tokenKey(1)]);

    const saveEntity = vi.spyOn(store, 'saveEntity');
    const live = liveNotifies(client);
    recorder = recordNotifies();

    adapter.emit({ type: 'update', typename: 'Token', data: { id: 'tok-1', price: 7 } });

    expect(recorder.notified).toEqual(['Token:tok-1']);
    expect(versions(client, [walletKey, tokenKey(1)])).toEqual([walletBefore, tokBefore + 1]);
    expect(savesOf(saveEntity, 'Token')).toHaveLength(1);
    expect(live.tokens).not.toHaveBeenCalled();
    expect(client.entityMap.getEntity(tokenKey(1))!.data.price).toBe(7);
  });
});
