import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reactive } from 'signalium';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { QueryClient } from '../QueryClient.js';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { fetchQuery } from '../query.js';
import { getMutation } from '../mutation.js';
import { RESTMutation } from '../rest/index.js';
import { reifyValue } from '../fieldRef.js';
import { createMockFetch, testWithClient, sleep, getEntityMapSize } from './utils.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import type { MutationEvent } from '../types.js';
import type { Query } from '../query.js';
import type { FetchNextConfig } from '../query-types.js';

// ============================================================
// MockStream — simulates a message bus (WebSocket, SSE, etc.)
// ============================================================

interface StreamSubscription {
  onData(data: unknown, meta?: { fetchNextUrl?: string }): void;
  onError(error: unknown): void;
  onEvent(event: MutationEvent): void;
}

class MockStream {
  private _bufferedData = new Map<string, { data: unknown; meta?: { fetchNextUrl?: string } }>();
  private _bufferedErrors = new Map<string, unknown>();
  private _subscriptions = new Map<string, StreamSubscription>();

  /** Push initial/replacement data for a topic. */
  pushTopicData(topic: string, data: unknown, meta?: { fetchNextUrl?: string }): void {
    const sub = this._subscriptions.get(topic);
    if (sub) {
      sub.onData(data, meta);
    } else {
      this._bufferedData.set(topic, { data, meta });
    }
  }

  /** Reject a topic with an error. */
  rejectTopic(topic: string, error: unknown): void {
    const sub = this._subscriptions.get(topic);
    if (sub) {
      sub.onError(error);
    } else {
      this._bufferedErrors.set(topic, error);
    }
  }

  /** Push a mutation event through the stream for a topic. */
  pushUpdate(topic: string, event: MutationEvent): void {
    this._subscriptions.get(topic)?.onEvent(event);
  }

  /**
   * Register a subscription for a topic.
   * If data or an error was buffered before subscribe, it's delivered immediately.
   * Returns an unsubscribe function.
   */
  subscribe(topic: string, callbacks: StreamSubscription): () => void {
    this._subscriptions.set(topic, callbacks);

    // Deliver buffered state
    const bufferedError = this._bufferedErrors.get(topic);
    if (bufferedError !== undefined) {
      this._bufferedErrors.delete(topic);
      callbacks.onError(bufferedError);
    } else {
      const buffered = this._bufferedData.get(topic);
      if (buffered !== undefined) {
        this._bufferedData.delete(topic);
        callbacks.onData(buffered.data, buffered.meta);
      }
    }

    return () => {
      this._subscriptions.delete(topic);
    };
  }
}

// ============================================================
// MockTopicQueryAdapter — bridges MockStream ↔ TopicQueryAdapter
// ============================================================

class MockTopicQueryAdapter extends TopicQueryAdapter {
  private _stream: MockStream;
  private _fetch: (url: string, init?: RequestInit) => Promise<Response>;
  private _unsubscribers = new Map<string, () => void>();
  private _topicMeta = new Map<string, { fetchNextUrl?: string }>();

  constructor(stream: MockStream, fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
    super();
    this._stream = stream;
    this._fetch = fetchFn;
  }

  subscribe(topic: string): void {
    const unsub = this._stream.subscribe(topic, {
      onData: (data, meta) => {
        if (meta) this._topicMeta.set(topic, meta);
        this.fulfillTopic(topic, data);
      },
      onError: error => {
        this.rejectTopic(topic, error);
      },
      onEvent: event => {
        this.sendMutationEvent(event);
      },
    });
    this._unsubscribers.set(topic, unsub);
  }

  unsubscribe(topic: string): void {
    this._unsubscribers.get(topic)?.();
    this._unsubscribers.delete(topic);
    this.clearTopic(topic);
  }

  // --- Pagination support ---

  private resolveFetchNext(ctx: TopicQuery): { url?: string; searchParams?: Record<string, unknown> } | undefined {
    const dynamicConfig = (ctx as any).getFetchNext ? (ctx as any).getFetchNext() : undefined;
    const fetchNextConfig: FetchNextConfig | undefined = dynamicConfig ?? ctx.rawFetchNext;
    if (fetchNextConfig === undefined) return undefined;

    const resolveRoot: Record<string, unknown> = {
      params: ctx.params ?? {},
      result: ctx.resultData,
    };

    return {
      url: fetchNextConfig.url !== undefined ? (reifyValue(fetchNextConfig.url, resolveRoot) as string) : undefined,
      searchParams:
        fetchNextConfig.searchParams !== undefined
          ? (reifyValue(fetchNextConfig.searchParams, resolveRoot) as Record<string, unknown>)
          : undefined,
    };
  }

  override hasNext(ctx: Query): boolean {
    const topicCtx = ctx as TopicQuery;
    const meta = this._topicMeta.get(topicCtx.topic);
    if (!meta?.fetchNextUrl) return false;

    const resolved = this.resolveFetchNext(topicCtx);
    if (resolved === undefined) return false;

    if (resolved.searchParams !== undefined) {
      for (const key of Object.keys(resolved.searchParams)) {
        if (resolved.searchParams[key] === undefined || resolved.searchParams[key] === null) return false;
      }
    }

    return true;
  }

  override async sendNext(ctx: Query, signal: AbortSignal): Promise<unknown> {
    const topicCtx = ctx as TopicQuery;
    const meta = this._topicMeta.get(topicCtx.topic);

    if (!meta?.fetchNextUrl) {
      throw new Error('No fetchNextUrl available for topic');
    }

    const resolved = this.resolveFetchNext(topicCtx);
    if (resolved === undefined) {
      throw new Error('fetchNext is not configured for this query');
    }

    let url = meta.fetchNextUrl;

    if (resolved.searchParams) {
      const sp = new URLSearchParams();
      for (const key in resolved.searchParams) {
        const val = resolved.searchParams[key];
        if (val !== undefined && val !== null) {
          sp.append(key, String(val));
        }
      }
      const qs = sp.toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }

    const fetchResponse = await this._fetch(url, { signal });
    return fetchResponse.json();
  }
}

// ============================================================
// TopicNotFoundError
// ============================================================

class TopicNotFoundError extends Error {
  constructor(topic: string) {
    super(`Topic "${topic}" not found in subscription`);
    this.name = 'TopicNotFoundError';
  }
}

// ============================================================
// Concrete TopicQuery subclass that uses the mock adapter
// ============================================================

abstract class MockTopicQuery extends TopicQuery {
  static override adapter = MockTopicQueryAdapter;
}

// ============================================================
// Test entities
// ============================================================

class TopicBalance extends Entity {
  __typename = t.typename('TopicBalance');
  id = t.id;
  walletId = t.string;
  token = t.string;
  amount = t.number;
}

class TopicPrice extends Entity {
  __typename = t.typename('TopicPrice');
  id = t.id;
  token = t.string;
  value = t.number;
  change24h = t.number;
}

class TopicPosition extends Entity {
  __typename = t.typename('TopicPosition');
  id = t.id;
  walletId = t.string;
  token = t.string;
  size = t.number;
  entryPrice = t.number;
}

class TopicWallet extends Entity {
  __typename = t.typename('TopicWallet');
  id = t.id;
  name = t.string;
  totalValue = t.number;
}

// ============================================================
// Test helpers
// ============================================================

async function pushUpdateOutsideReactiveContext(
  stream: MockStream,
  topic: string,
  event: MutationEvent,
): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => {
      stream.pushUpdate(topic, event);
      resolve();
    }, 0);
  });
  await sleep(10);
}

async function applyEventOutsideReactiveContext(client: QueryClient, event: MutationEvent): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => {
      client.applyMutationEvent(event);
      resolve();
    }, 0);
  });
  await sleep(10);
}

// ============================================================
// Tests
// ============================================================

describe('TopicQuery', () => {
  let client: QueryClient;
  let mockFetch: ReturnType<typeof createMockFetch>;
  let mockStream: MockStream;

  beforeEach(() => {
    const kv = new MemoryPersistentStore();
    const store = new SyncQueryStore(kv);
    mockFetch = createMockFetch();
    mockStream = new MockStream();
    client = new QueryClient({
      store: store,
      adapters: [
        new MockTopicQueryAdapter(mockStream, mockFetch as any),
        new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' }),
      ],
    } as any);
  });

  afterEach(() => {
    client?.destroy();
  });

  // ============================================================
  // Section 1: Basic Topic Loading
  // ============================================================

  describe('Basic Topic Loading', () => {
    it('should be pending before stream pushes data', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        expect(relay.isPending).toBe(true);

        mockStream.pushTopicData('prices:live', {
          items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
        });

        await relay;
        expect(relay.isResolved).toBe(true);
      });
    });

    it('should resolve when stream delivers topic data', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      mockStream.pushTopicData('prices:live', {
        items: [
          { __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 },
          { __typename: 'TopicPrice', id: '2', token: 'ETH', value: 3000, change24h: -1.2 },
        ],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        expect(relay.isResolved).toBe(true);
        expect(relay.value!.items).toHaveLength(2);
        expect(relay.value!.items[0].token).toBe('BTC');
        expect(relay.value!.items[0].value).toBe(50000);
        expect(relay.value!.items[1].token).toBe('ETH');
      });
    });

    it('should reject when stream rejects topic', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      mockStream.rejectTopic('prices:live', new TopicNotFoundError('prices:live'));

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);

        try {
          await relay;
        } catch {
          // Expected rejection
        }

        expect(relay.isRejected).toBe(true);
        expect(relay.error).toBeInstanceOf(TopicNotFoundError);
        expect((relay.error as Error).message).toContain('prices:live');
      });
    });

    it('should stay pending until stream delivers data', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        expect(relay.isPending).toBe(true);

        await sleep(20);
        expect(relay.isPending).toBe(true);

        mockStream.pushTopicData('prices:live', {
          items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
        });

        await relay;
        expect(relay.isResolved).toBe(true);
      });
    });

    it('should resolve multiple topic queries for different topics independently', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      class GetBalances extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = {
          items: t.array(t.entity(TopicBalance)),
        };
      }

      mockStream.pushTopicData('prices:live', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });
      mockStream.pushTopicData('balances:wallet-1', {
        items: [{ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 }],
      });

      await testWithClient(client, async () => {
        const pricesRelay = fetchQuery(GetPrices);
        const balancesRelay = fetchQuery(GetBalances);

        await Promise.all([pricesRelay, balancesRelay]);

        expect(pricesRelay.value!.items).toHaveLength(1);
        expect(pricesRelay.value!.items[0].token).toBe('BTC');

        expect(balancesRelay.value!.items).toHaveLength(1);
        expect(balancesRelay.value!.items[0].amount).toBe(1.5);
      });
    });

    it('should support parameterized topics', async () => {
      class GetBalances extends MockTopicQuery {
        params = { walletId: t.string };
        topic = `balances:${this.params.walletId}`;
        result = {
          items: t.array(t.entity(TopicBalance)),
        };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        items: [{ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 }],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalances, { walletId: 'wallet-1' });
        await relay;

        expect(relay.value!.items).toHaveLength(1);
        expect(relay.value!.items[0].walletId).toBe('wallet-1');
      });
    });

    it('should resolve with single entity result', async () => {
      class GetWallet extends MockTopicQuery {
        topic = 'wallet:main';
        result = t.entity(TopicWallet);
      }

      mockStream.pushTopicData('wallet:main', {
        __typename: 'TopicWallet',
        id: 'w1',
        name: 'My Wallet',
        totalValue: 100000,
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetWallet);
        await relay;

        expect(relay.value!.name).toBe('My Wallet');
        expect(relay.value!.totalValue).toBe(100000);
      });
    });

    it('should resolve with nested entities in result', async () => {
      class GetPositionDetail extends MockTopicQuery {
        topic = 'position:detail';
        result = {
          position: t.entity(TopicPosition),
          wallet: t.entity(TopicWallet),
        };
      }

      mockStream.pushTopicData('position:detail', {
        position: {
          __typename: 'TopicPosition',
          id: 'p1',
          walletId: 'w1',
          token: 'BTC',
          size: 2.0,
          entryPrice: 45000,
        },
        wallet: {
          __typename: 'TopicWallet',
          id: 'w1',
          name: 'My Wallet',
          totalValue: 90000,
        },
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPositionDetail);
        await relay;

        expect(relay.value!.position.token).toBe('BTC');
        expect(relay.value!.position.size).toBe(2.0);
        expect(relay.value!.wallet.name).toBe('My Wallet');
      });
    });

    it('should resolve when data is pre-pushed before query activates', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      mockStream.pushTopicData('prices:live', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        expect(relay.isResolved).toBe(true);
        expect(relay.value!.items[0].value).toBe(50000);
      });
    });

    it('should maintain entity identity across queries sharing entities', async () => {
      class GetPricesA extends MockTopicQuery {
        topic = 'prices:a';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      class GetPricesB extends MockTopicQuery {
        topic = 'prices:b';
        result = {
          items: t.array(t.entity(TopicPrice)),
        };
      }

      mockStream.pushTopicData('prices:a', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });
      mockStream.pushTopicData('prices:b', {
        items: [
          { __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 },
          { __typename: 'TopicPrice', id: '2', token: 'ETH', value: 3000, change24h: -1.2 },
        ],
      });

      await testWithClient(client, async () => {
        const relayA = fetchQuery(GetPricesA);
        const relayB = fetchQuery(GetPricesB);

        await Promise.all([relayA, relayB]);

        const priceFromA = relayA.value!.items[0];
        const priceFromB = relayB.value!.items[0];

        expect(priceFromA.token).toBe('BTC');
        expect(priceFromB.token).toBe('BTC');

        await applyEventOutsideReactiveContext(client, {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '1', value: 51000 },
        });

        expect(priceFromA.value).toBe(51000);
        expect(priceFromB.value).toBe(51000);
      });
    });

    it('should handle result with plain object fields', async () => {
      class GetSnapshot extends MockTopicQuery {
        topic = 'snapshot:daily';
        result = {
          total: t.number,
          currency: t.string,
          updatedAt: t.number,
        };
      }

      mockStream.pushTopicData('snapshot:daily', {
        total: 150000,
        currency: 'USD',
        updatedAt: 1711000000000,
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetSnapshot);
        await relay;

        expect(relay.value!.total).toBe(150000);
        expect(relay.value!.currency).toBe('USD');
        expect(relay.value!.updatedAt).toBe(1711000000000);
      });
    });

    it('should reject only the specific query whose topic is rejected', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      class GetBalances extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { items: t.array(t.entity(TopicBalance)) };
      }

      mockStream.rejectTopic('prices:live', new TopicNotFoundError('prices:live'));
      mockStream.pushTopicData('balances:wallet-1', {
        items: [{ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 }],
      });

      await testWithClient(client, async () => {
        const pricesRelay = fetchQuery(GetPrices);
        const balancesRelay = fetchQuery(GetBalances);

        await balancesRelay;

        try {
          await pricesRelay;
        } catch {
          // Expected rejection
        }

        expect(balancesRelay.isResolved).toBe(true);
        expect(balancesRelay.value!.items[0].token).toBe('BTC');

        expect(pricesRelay.isRejected).toBe(true);
      });
    });
  });

  // ============================================================
  // Section 2: Stream Update Events
  // ============================================================

  describe('Stream Update Events', () => {
    it('should update existing entity field via stream event', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      mockStream.pushTopicData('prices:live', {
        items: [
          { __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 },
          { __typename: 'TopicPrice', id: '2', token: 'ETH', value: 3000, change24h: -1.2 },
        ],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        expect(relay.value!.items[0].value).toBe(50000);

        await pushUpdateOutsideReactiveContext(mockStream, 'prices:live', {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '1', value: 51000 },
        });

        expect(relay.value!.items[0].value).toBe(51000);
        expect(relay.value!.items[0].token).toBe('BTC');
      });
    });

    it('should preserve untouched fields on partial update', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      mockStream.pushTopicData('prices:live', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        await pushUpdateOutsideReactiveContext(mockStream, 'prices:live', {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '1', change24h: 5.0 },
        });

        expect(relay.value!.items[0].value).toBe(50000);
        expect(relay.value!.items[0].change24h).toBe(5.0);
        expect(relay.value!.items[0].token).toBe('BTC');
      });
    });

    it('should add entity to live array via create event with constraints', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [{ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 }],
        },
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(1);

        await pushUpdateOutsideReactiveContext(mockStream, 'balances:wallet-1', {
          type: 'create',
          typename: 'TopicBalance',
          data: { __typename: 'TopicBalance', id: '2', walletId: 'wallet-1', token: 'ETH', amount: 10.0 },
        });

        expect(items()).toHaveLength(2);
        expect(items()[1].token).toBe('ETH');
        expect(items()[1].amount).toBe(10.0);
      });
    });

    it('should remove entity from live array via delete event', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [
            { __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 },
            { __typename: 'TopicBalance', id: '2', walletId: 'wallet-1', token: 'ETH', amount: 10.0 },
          ],
        },
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(2);

        await pushUpdateOutsideReactiveContext(mockStream, 'balances:wallet-1', {
          type: 'delete',
          typename: 'TopicBalance',
          data: { __typename: 'TopicBalance', id: '1', walletId: 'wallet-1' },
        });

        expect(items()).toHaveLength(1);
        expect(items()[0].token).toBe('ETH');
      });
    });

    it('should handle delete event with string id', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [{ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 }],
        },
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(1);

        await pushUpdateOutsideReactiveContext(mockStream, 'balances:wallet-1', {
          type: 'delete',
          typename: 'TopicBalance',
          data: '1',
        });

        expect(items()).toHaveLength(0);
      });
    });

    it('should update nested entity through parent', async () => {
      class GetPositionDetail extends MockTopicQuery {
        topic = 'position:detail';
        result = {
          position: t.entity(TopicPosition),
          wallet: t.entity(TopicWallet),
        };
      }

      mockStream.pushTopicData('position:detail', {
        position: {
          __typename: 'TopicPosition',
          id: 'p1',
          walletId: 'w1',
          token: 'BTC',
          size: 2.0,
          entryPrice: 45000,
        },
        wallet: {
          __typename: 'TopicWallet',
          id: 'w1',
          name: 'Main Wallet',
          totalValue: 90000,
        },
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPositionDetail);
        await relay;

        expect(relay.value!.wallet.totalValue).toBe(90000);

        await pushUpdateOutsideReactiveContext(mockStream, 'position:detail', {
          type: 'update',
          typename: 'TopicWallet',
          data: { id: 'w1', totalValue: 95000 },
        });

        expect(relay.value!.wallet.totalValue).toBe(95000);
        expect(relay.value!.wallet.name).toBe('Main Wallet');
      });
    });

    it('should handle multiple rapid successive events', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      mockStream.pushTopicData('prices:live', {
        items: [
          { __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 },
          { __typename: 'TopicPrice', id: '2', token: 'ETH', value: 3000, change24h: -1.2 },
        ],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        await pushUpdateOutsideReactiveContext(mockStream, 'prices:live', {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '1', value: 51000 },
        });
        await pushUpdateOutsideReactiveContext(mockStream, 'prices:live', {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '2', value: 3100 },
        });
        await pushUpdateOutsideReactiveContext(mockStream, 'prices:live', {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '1', value: 52000 },
        });

        expect(relay.value!.items[0].value).toBe(52000);
        expect(relay.value!.items[1].value).toBe(3100);
      });
    });

    it('should be a no-op for events with unregistered typename', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      mockStream.pushTopicData('prices:live', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        const sizeBefore = getEntityMapSize(client);

        await pushUpdateOutsideReactiveContext(mockStream, 'prices:live', {
          type: 'create',
          typename: 'CompletelyUnknownType',
          data: { id: '1', name: 'Unknown' },
        });

        expect(getEntityMapSize(client)).toBe(sizeBefore);
        expect(relay.value!.items[0].value).toBe(50000);
      });
    });

    it('should also update entities via direct applyMutationEvent', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      mockStream.pushTopicData('prices:live', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        await applyEventOutsideReactiveContext(client, {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '1', value: 55000 },
        });

        expect(relay.value!.items[0].value).toBe(55000);
      });
    });

    it('should not affect unrelated query entities', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      class GetBalances extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { items: t.array(t.entity(TopicBalance)) };
      }

      mockStream.pushTopicData('prices:live', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });
      mockStream.pushTopicData('balances:wallet-1', {
        items: [{ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 }],
      });

      await testWithClient(client, async () => {
        const pricesRelay = fetchQuery(GetPrices);
        const balancesRelay = fetchQuery(GetBalances);
        await Promise.all([pricesRelay, balancesRelay]);

        await pushUpdateOutsideReactiveContext(mockStream, 'prices:live', {
          type: 'update',
          typename: 'TopicPrice',
          data: { id: '1', value: 55000 },
        });

        expect(pricesRelay.value!.items[0].value).toBe(55000);
        expect(balancesRelay.value!.items[0].amount).toBe(1.5);
      });
    });
  });

  // ============================================================
  // Section 3: Mutations with TopicQuery
  // ============================================================

  describe('Mutations with TopicQuery', () => {
    it('should add to live array via mutation create effect', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      class AddBalance extends RESTMutation {
        params = { __typename: t.string, id: t.id, walletId: t.string, token: t.string, amount: t.number };
        path = '/balances';
        method = 'POST' as const;
        result = { ok: t.boolean };
        effects = {
          creates: [[TopicBalance, this.params] as const],
        };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [{ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 }],
        },
      });

      mockFetch.post('/balances', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(1);

        const mut = getMutation(AddBalance);
        await mut.run({
          __typename: 'TopicBalance',
          id: '2',
          walletId: 'wallet-1',
          token: 'ETH',
          amount: 10.0,
        });
        await sleep(10);

        expect(items()).toHaveLength(2);
        expect(items()[1].token).toBe('ETH');
      });
    });

    it('should update entity via mutation update effect', async () => {
      class GetPrices extends MockTopicQuery {
        topic = 'prices:live';
        result = { items: t.array(t.entity(TopicPrice)) };
      }

      class UpdatePrice extends RESTMutation {
        params = { id: t.id, value: t.number };
        path = '/prices/update';
        method = 'PUT' as const;
        result = { ok: t.boolean };
        effects = {
          updates: [[TopicPrice, this.params] as const],
        };
      }

      mockStream.pushTopicData('prices:live', {
        items: [{ __typename: 'TopicPrice', id: '1', token: 'BTC', value: 50000, change24h: 2.5 }],
      });

      mockFetch.put('/prices/update', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetPrices);
        await relay;

        expect(relay.value!.items[0].value).toBe(50000);

        const mut = getMutation(UpdatePrice);
        await mut.run({ id: '1', value: 55000 });
        await sleep(10);

        expect(relay.value!.items[0].value).toBe(55000);
        expect(relay.value!.items[0].token).toBe('BTC');
      });
    });

    it('should remove from live array via mutation delete effect', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      class RemoveBalance extends RESTMutation {
        params = { id: t.id };
        path = `/balances/${this.params.id}`;
        method = 'DELETE' as const;
        result = { ok: t.boolean };
        effects = {
          deletes: [[TopicBalance, this.params.id] as const],
        };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [
            { __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 },
            { __typename: 'TopicBalance', id: '2', walletId: 'wallet-1', token: 'ETH', amount: 10.0 },
          ],
        },
      });

      mockFetch.delete('/balances/[id]', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(2);

        const mut = getMutation(RemoveBalance);
        await mut.run({ id: '1' });
        await sleep(10);

        expect(items()).toHaveLength(1);
        expect(items()[0].token).toBe('ETH');
      });
    });

    it('should support getEffects() dynamic effects', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      class TransferBalance extends RESTMutation {
        params = { fromId: t.string, toId: t.string, newFromAmount: t.number, newToAmount: t.number };
        path = '/balances/transfer';
        method = 'POST' as const;
        result = { ok: t.boolean };

        getEffects() {
          return {
            updates: [
              [TopicBalance, { id: this.params.fromId, amount: this.params.newFromAmount }] as const,
              [TopicBalance, { id: this.params.toId, amount: this.params.newToAmount }] as const,
            ],
          };
        }
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [
            { __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 },
            { __typename: 'TopicBalance', id: '2', walletId: 'wallet-1', token: 'ETH', amount: 10.0 },
          ],
        },
      });

      mockFetch.post('/balances/transfer', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()[0].amount).toBe(1.5);
        expect(items()[1].amount).toBe(10.0);

        const mut = getMutation(TransferBalance);
        await mut.run({ fromId: '1', toId: '2', newFromAmount: 0.5, newToAmount: 11.0 });
        await sleep(10);

        expect(items()[0].amount).toBe(0.5);
        expect(items()[1].amount).toBe(11.0);
      });
    });

    it('should handle multiple mutations in sequence', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      class AddBalance extends RESTMutation {
        params = { __typename: t.string, id: t.id, walletId: t.string, token: t.string, amount: t.number };
        path = '/balances';
        method = 'POST' as const;
        result = { ok: t.boolean };
        effects = {
          creates: [[TopicBalance, this.params] as const],
        };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [],
        },
      });

      mockFetch.post('/balances', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(0);

        const mut = getMutation(AddBalance);
        await mut.run({ __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.0 });
        await sleep(10);
        expect(items()).toHaveLength(1);

        await mut.run({ __typename: 'TopicBalance', id: '2', walletId: 'wallet-1', token: 'ETH', amount: 5.0 });
        await sleep(10);
        expect(items()).toHaveLength(2);

        await mut.run({ __typename: 'TopicBalance', id: '3', walletId: 'wallet-1', token: 'SOL', amount: 100.0 });
        await sleep(10);
        expect(items()).toHaveLength(3);

        expect(items()[0].token).toBe('BTC');
        expect(items()[1].token).toBe('ETH');
        expect(items()[2].token).toBe('SOL');
      });
    });

    it('should create entity matching live array constraint', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [],
        },
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(0);

        await applyEventOutsideReactiveContext(client, {
          type: 'create',
          typename: 'TopicBalance',
          data: { __typename: 'TopicBalance', id: '1', walletId: 'wallet-1', token: 'BTC', amount: 1.5 },
        });

        expect(items()).toHaveLength(1);
        expect(items()[0].token).toBe('BTC');
      });
    });

    it('should not add entity to live array when constraint does not match', async () => {
      class TopicBalanceList extends Entity {
        __typename = t.typename('TopicBalanceList');
        id = t.id;
        walletId = t.string;
        items = t.liveArray(TopicBalance, { constraints: { walletId: (this as any).id } });
      }

      class GetBalanceList extends MockTopicQuery {
        topic = 'balances:wallet-1';
        result = { list: t.entity(TopicBalanceList) };
      }

      mockStream.pushTopicData('balances:wallet-1', {
        list: {
          __typename: 'TopicBalanceList',
          id: 'wallet-1',
          walletId: 'wallet-1',
          items: [],
        },
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetBalanceList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(0);

        await applyEventOutsideReactiveContext(client, {
          type: 'create',
          typename: 'TopicBalance',
          data: { __typename: 'TopicBalance', id: '1', walletId: 'wallet-999', token: 'BTC', amount: 1.5 },
        });

        expect(items()).toHaveLength(0);
      });
    });
  });

  // ============================================================
  // Section 4: fetchNext with TopicQuery
  // ============================================================

  describe('fetchNext with TopicQuery', () => {
    class TopicItem extends Entity {
      __typename = t.typename('TopicItem');
      id = t.id;
      name = t.string;
    }

    it('should fetch next page using fetchNextUrl and cursor', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.liveArray(TopicItem),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: {
            cursor: this.result.cursor,
          },
        };
      }

      mockStream.pushTopicData(
        'items:list',
        {
          items: [
            { __typename: 'TopicItem', id: '1', name: 'first' },
            { __typename: 'TopicItem', id: '2', name: 'second' },
          ],
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/items/next' },
      );

      mockFetch.get('/api/items/next', {
        items: [{ __typename: 'TopicItem', id: '3', name: 'third' }],
        cursor: 'c2',
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.items).toHaveLength(2);
        expect(relay.value!.cursor).toBe('c1');

        await relay.value!.__fetchNext();

        const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
        expect(lastCall.url).toContain('/api/items/next');
        expect(lastCall.url).toContain('cursor=c1');

        expect(relay.value!.items).toHaveLength(3);
        expect(relay.value!.items[2].name).toBe('third');
        expect(relay.value!.cursor).toBe('c2');
      });
    });

    it('should accumulate live array items across fetchNext calls', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.liveArray(TopicItem),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'items:list',
        {
          items: [{ __typename: 'TopicItem', id: '1', name: 'first' }],
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/items/next' },
      );

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;
        expect(relay.value!.items).toHaveLength(1);

        mockFetch.get('/api/items/next', {
          items: [{ __typename: 'TopicItem', id: '2', name: 'second' }],
          cursor: 'c2',
        });
        await relay.value!.__fetchNext();
        expect(relay.value!.items).toHaveLength(2);

        mockFetch.get('/api/items/next', {
          items: [
            { __typename: 'TopicItem', id: '3', name: 'third' },
            { __typename: 'TopicItem', id: '4', name: 'fourth' },
          ],
          cursor: undefined,
        });
        await relay.value!.__fetchNext();
        expect(relay.value!.items).toHaveLength(4);
        expect(relay.value!.items[0].name).toBe('first');
        expect(relay.value!.items[3].name).toBe('fourth');
      });
    });

    it('should advance cursor with each fetchNext response', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.liveArray(TopicItem),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'items:list',
        {
          items: [{ __typename: 'TopicItem', id: '1', name: 'first' }],
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/items/next' },
      );

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        mockFetch.get('/api/items/next', {
          items: [{ __typename: 'TopicItem', id: '2', name: 'second' }],
          cursor: 'c2',
        });
        await relay.value!.__fetchNext();
        expect(mockFetch.calls[0].url).toContain('cursor=c1');

        mockFetch.get('/api/items/next', {
          items: [{ __typename: 'TopicItem', id: '3', name: 'third' }],
          cursor: 'c3',
        });
        await relay.value!.__fetchNext();
        expect(mockFetch.calls[1].url).toContain('cursor=c2');
      });
    });

    it('should deduplicate entities in live array on fetchNext', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.liveArray(TopicItem),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'items:list',
        {
          items: [
            { __typename: 'TopicItem', id: '1', name: 'first' },
            { __typename: 'TopicItem', id: '2', name: 'second' },
          ],
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/items/next' },
      );

      mockFetch.get('/api/items/next', {
        items: [
          { __typename: 'TopicItem', id: '2', name: 'second-updated' },
          { __typename: 'TopicItem', id: '3', name: 'third' },
        ],
        cursor: 'c2',
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        await relay.value!.__fetchNext();

        expect(relay.value!.items).toHaveLength(3);
        expect(relay.value!.items[1].name).toBe('second-updated');
        expect(relay.value!.items[2].name).toBe('third');
      });
    });

    it('should reflect __hasNext based on cursor value', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.liveArray(TopicItem),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'items:list',
        {
          items: [{ __typename: 'TopicItem', id: '1', name: 'first' }],
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/items/next' },
      );

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__hasNext).toBe(true);

        mockFetch.get('/api/items/next', {
          items: [{ __typename: 'TopicItem', id: '2', name: 'second' }],
        });
        await relay.value!.__fetchNext();

        expect(relay.value!.__hasNext).toBe(false);
      });
    });

    it('should show correct __isFetchingNext states', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.liveArray(TopicItem),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'items:list',
        {
          items: [{ __typename: 'TopicItem', id: '1', name: 'first' }],
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/items/next' },
      );

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__isFetchingNext).toBe(false);

        mockFetch.get('/api/items/next', {
          items: [{ __typename: 'TopicItem', id: '2', name: 'second' }],
          cursor: undefined,
        });
        await relay.value!.__fetchNext();

        expect(relay.value!.__isFetchingNext).toBe(false);
      });
    });

    it('should preserve prior state on fetchNext error', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.liveArray(TopicItem),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'items:list',
        {
          items: [
            { __typename: 'TopicItem', id: '1', name: 'first' },
            { __typename: 'TopicItem', id: '2', name: 'second' },
          ],
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/items/next' },
      );

      mockFetch.get('/api/items/next', null, { error: new Error('Network error') });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.items).toHaveLength(2);

        await expect(relay.value!.__fetchNext()).rejects.toThrow('Network error');

        expect(relay.value!.items).toHaveLength(2);
        expect(relay.value!.cursor).toBe('c1');
      });
    });

    it('should return false for __hasNext when no fetchNext is configured', async () => {
      class GetItems extends MockTopicQuery {
        topic = 'items:list';
        result = {
          items: t.array(t.entity(TopicItem)),
        };
      }

      mockStream.pushTopicData('items:list', {
        items: [{ __typename: 'TopicItem', id: '1', name: 'first' }],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__hasNext).toBe(false);
      });
    });
  });

  // ============================================================
  // Section 5: Combined / Integration Scenarios
  // ============================================================

  describe('Combined Scenarios', () => {
    class TopicItem extends Entity {
      __typename = t.typename('TopicCombinedItem');
      id = t.id;
      listId = t.string;
      name = t.string;
    }

    class TopicCombinedList extends Entity {
      __typename = t.typename('TopicCombinedList');
      id = t.id;
      items = t.liveArray(TopicItem, { constraints: { listId: (this as any).id } });
    }

    it('should reflect both fetchNext and stream update in final state', async () => {
      class GetList extends MockTopicQuery {
        topic = 'list:main';
        result = {
          list: t.entity(TopicCombinedList),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'list:main',
        {
          list: {
            __typename: 'TopicCombinedList',
            id: 'main',
            items: [{ __typename: 'TopicCombinedItem', id: '1', listId: 'main', name: 'A' }],
          },
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/list/next' },
      );

      mockFetch.get('/api/list/next', {
        list: {
          __typename: 'TopicCombinedList',
          id: 'main',
          items: [{ __typename: 'TopicCombinedItem', id: '2', listId: 'main', name: 'B' }],
        },
        cursor: undefined,
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetList);
        await relay;

        expect(relay.value!.list.items).toHaveLength(1);

        await relay.value!.__fetchNext();
        expect(relay.value!.list.items).toHaveLength(2);

        await applyEventOutsideReactiveContext(client, {
          type: 'update',
          typename: 'TopicCombinedItem',
          data: { id: '1', name: 'A-updated' },
        });

        expect(relay.value!.list.items).toHaveLength(2);
        expect(relay.value!.list.items[0].name).toBe('A-updated');
        expect(relay.value!.list.items[1].name).toBe('B');
      });
    });

    it('should handle stream update then fetchNext correctly', async () => {
      class GetList extends MockTopicQuery {
        topic = 'list:main';
        result = {
          list: t.entity(TopicCombinedList),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'list:main',
        {
          list: {
            __typename: 'TopicCombinedList',
            id: 'main',
            items: [{ __typename: 'TopicCombinedItem', id: '1', listId: 'main', name: 'A' }],
          },
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/list/next' },
      );

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetList);
        await relay;

        const items = reactive(() => relay.value!.list.items);

        await pushUpdateOutsideReactiveContext(mockStream, 'list:main', {
          type: 'create',
          typename: 'TopicCombinedItem',
          data: { __typename: 'TopicCombinedItem', id: '10', listId: 'main', name: 'Stream-Created' },
        });

        expect(items()).toHaveLength(2);

        mockFetch.get('/api/list/next', {
          list: {
            __typename: 'TopicCombinedList',
            id: 'main',
            items: [{ __typename: 'TopicCombinedItem', id: '2', listId: 'main', name: 'B' }],
          },
          cursor: undefined,
        });

        await relay.value!.__fetchNext();

        expect(items()).toHaveLength(3);
      });
    });

    it('should handle mutation effect then stream update without duplicates', async () => {
      class GetList extends MockTopicQuery {
        topic = 'list:main';
        result = { list: t.entity(TopicCombinedList) };
      }

      class AddItem extends RESTMutation {
        params = { __typename: t.string, id: t.id, listId: t.string, name: t.string };
        path = '/items';
        method = 'POST' as const;
        result = { ok: t.boolean };
        effects = {
          creates: [[TopicItem, this.params] as const],
        };
      }

      mockStream.pushTopicData('list:main', {
        list: {
          __typename: 'TopicCombinedList',
          id: 'main',
          items: [{ __typename: 'TopicCombinedItem', id: '1', listId: 'main', name: 'A' }],
        },
      });

      mockFetch.post('/items', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetList);
        await relay;

        const items = reactive(() => relay.value!.list.items);

        const mut = getMutation(AddItem);
        await mut.run({ __typename: 'TopicCombinedItem', id: '2', listId: 'main', name: 'B' });
        await sleep(10);
        expect(items()).toHaveLength(2);

        await pushUpdateOutsideReactiveContext(mockStream, 'list:main', {
          type: 'update',
          typename: 'TopicCombinedItem',
          data: { id: '2', name: 'B-updated' },
        });

        expect(items()).toHaveLength(2);
        expect(items()[1].name).toBe('B-updated');
      });
    });

    it('should handle fetchNext + mutation + stream update in sequence', async () => {
      class GetList extends MockTopicQuery {
        topic = 'list:main';
        result = {
          list: t.entity(TopicCombinedList),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      class AddItem extends RESTMutation {
        params = { __typename: t.string, id: t.id, listId: t.string, name: t.string };
        path = '/items';
        method = 'POST' as const;
        result = { ok: t.boolean };
        effects = {
          creates: [[TopicItem, this.params] as const],
        };
      }

      mockStream.pushTopicData(
        'list:main',
        {
          list: {
            __typename: 'TopicCombinedList',
            id: 'main',
            items: [{ __typename: 'TopicCombinedItem', id: '1', listId: 'main', name: 'A' }],
          },
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/list/next' },
      );

      mockFetch.get('/api/list/next', {
        list: {
          __typename: 'TopicCombinedList',
          id: 'main',
          items: [{ __typename: 'TopicCombinedItem', id: '2', listId: 'main', name: 'B' }],
        },
        cursor: undefined,
      });
      mockFetch.post('/items', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetList);
        await relay;

        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(1);

        await relay.value!.__fetchNext();
        expect(items()).toHaveLength(2);

        const mut = getMutation(AddItem);
        await mut.run({ __typename: 'TopicCombinedItem', id: '3', listId: 'main', name: 'C' });
        await sleep(10);
        expect(items()).toHaveLength(3);

        await applyEventOutsideReactiveContext(client, {
          type: 'update',
          typename: 'TopicCombinedItem',
          data: { id: '1', name: 'A-final' },
        });

        expect(items()).toHaveLength(3);
        expect(items()[0].name).toBe('A-final');
        expect(items()[1].name).toBe('B');
        expect(items()[2].name).toBe('C');
      });
    });

    it('should deduplicate when stream creates entity then fetchNext returns it', async () => {
      class GetList extends MockTopicQuery {
        topic = 'list:main';
        result = {
          list: t.entity(TopicCombinedList),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      mockStream.pushTopicData(
        'list:main',
        {
          list: {
            __typename: 'TopicCombinedList',
            id: 'main',
            items: [{ __typename: 'TopicCombinedItem', id: '1', listId: 'main', name: 'A' }],
          },
          cursor: 'c1',
        },
        { fetchNextUrl: '/api/list/next' },
      );

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetList);
        await relay;

        const items = reactive(() => relay.value!.list.items);

        await pushUpdateOutsideReactiveContext(mockStream, 'list:main', {
          type: 'create',
          typename: 'TopicCombinedItem',
          data: { __typename: 'TopicCombinedItem', id: '2', listId: 'main', name: 'B' },
        });

        expect(items()).toHaveLength(2);

        mockFetch.get('/api/list/next', {
          list: {
            __typename: 'TopicCombinedList',
            id: 'main',
            items: [{ __typename: 'TopicCombinedItem', id: '2', listId: 'main', name: 'B-server' }],
          },
          cursor: undefined,
        });

        await relay.value!.__fetchNext();

        expect(items()).toHaveLength(2);
        expect(items()[1].name).toBe('B-server');
      });
    });

    it('full lifecycle: subscribe → data → fetchNext → stream updates → mutation', async () => {
      class GetList extends MockTopicQuery {
        topic = 'list:full';
        result = {
          list: t.entity(TopicCombinedList),
          cursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      class RemoveItem extends RESTMutation {
        params = { id: t.id };
        path = `/items/${this.params.id}`;
        method = 'DELETE' as const;
        result = { ok: t.boolean };
        effects = {
          deletes: [[TopicItem, this.params.id] as const],
        };
      }

      mockFetch.delete('/items/[id]', { ok: true });

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetList);
        expect(relay.isPending).toBe(true);

        await sleep(10);
        expect(relay.isPending).toBe(true);

        mockStream.pushTopicData(
          'list:full',
          {
            list: {
              __typename: 'TopicCombinedList',
              id: 'full',
              items: [
                { __typename: 'TopicCombinedItem', id: '1', listId: 'full', name: 'Alpha' },
                { __typename: 'TopicCombinedItem', id: '2', listId: 'full', name: 'Beta' },
              ],
            },
            cursor: 'page-2',
          },
          { fetchNextUrl: '/api/list/next' },
        );

        await relay;
        expect(relay.isResolved).toBe(true);
        const items = reactive(() => relay.value!.list.items);
        expect(items()).toHaveLength(2);

        mockFetch.get('/api/list/next', {
          list: {
            __typename: 'TopicCombinedList',
            id: 'full',
            items: [{ __typename: 'TopicCombinedItem', id: '3', listId: 'full', name: 'Gamma' }],
          },
          cursor: undefined,
        });

        await relay.value!.__fetchNext();
        expect(items()).toHaveLength(3);
        expect(items()[2].name).toBe('Gamma');

        await pushUpdateOutsideReactiveContext(mockStream, 'list:full', {
          type: 'update',
          typename: 'TopicCombinedItem',
          data: { id: '1', name: 'Alpha-Updated' },
        });

        expect(items()[0].name).toBe('Alpha-Updated');

        await pushUpdateOutsideReactiveContext(mockStream, 'list:full', {
          type: 'create',
          typename: 'TopicCombinedItem',
          data: { __typename: 'TopicCombinedItem', id: '4', listId: 'full', name: 'Delta' },
        });

        expect(items()).toHaveLength(4);

        const mut = getMutation(RemoveItem);
        await mut.run({ id: '2' });
        await sleep(10);

        expect(items()).toHaveLength(3);
        expect(items().map((i: any) => i.name)).toEqual(['Alpha-Updated', 'Gamma', 'Delta']);
      });
    });
  });
});
