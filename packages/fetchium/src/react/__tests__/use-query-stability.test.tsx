import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider } from 'signalium/react';
import React, { useState } from 'react';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { Entity } from '../../proxy.js';
import { sleep } from '../../__tests__/utils.js';
import { useQuery, __debug_thunkAllocations, __debug_resetThunkAllocations } from '../use-query.js';
import { TopicQuery } from '../../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../../topic/TopicQueryAdapter.js';

class MockStream {
  private _subs = new Map<string, (data: unknown) => void>();
  push(topic: string, data: unknown): void {
    this._subs.get(topic)?.(data);
  }
  subscribe(topic: string, onData: (data: unknown) => void): () => void {
    this._subs.set(topic, onData);
    return () => this._subs.delete(topic);
  }
}

class MockTopicAdapter extends TopicQueryAdapter {
  private _stream: MockStream;
  private _unsubs = new Map<string, () => void>();
  subscribeCalls = new Map<string, number>();
  unsubscribeCalls = new Map<string, number>();

  constructor(stream: MockStream) {
    super();
    this._stream = stream;
  }

  preload(topic: string, data: unknown): void {
    this.fulfillTopic(topic, data);
  }

  subscribe(topic: string): void {
    this.subscribeCalls.set(topic, (this.subscribeCalls.get(topic) ?? 0) + 1);
    const unsub = this._stream.subscribe(topic, data => this.fulfillTopic(topic, data));
    this._unsubs.set(topic, unsub);
  }

  unsubscribe(topic: string): void {
    this.unsubscribeCalls.set(topic, (this.unsubscribeCalls.get(topic) ?? 0) + 1);
    this._unsubs.get(topic)?.();
    this._unsubs.delete(topic);
    this.clearTopic(topic);
  }
}

class TopicPrice extends Entity {
  __typename = t.typename('TopicPrice');
  id = t.id;
  value = t.number;
}

describe('useQuery thunk identity', () => {
  let client: QueryClient;
  let stream: MockStream;

  beforeEach(() => {
    client?.destroy();
    stream = new MockStream();
    client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new MockTopicAdapter(stream)],
    } as any);
  });

  // Structural property the fix preserves.
  //
  // signalium's `useReactive` keys its `ReactiveDefinition` and signal on the
  // fn reference (WeakMap). A fresh fn per render produces a fresh signal per
  // render, and React's `useSyncExternalStore` unsubscribe/subscribe across
  // renders then touches different signals. Under React commit orderings where
  // the microtask flush straddles the unsubscribe and the subscribe (React 18
  // / React Native concurrent rendering), Signalium's `cancelDeactivate`
  // rescue can fail, the relay loses its sole watcher to a deactivate cascade,
  // and a consumer that is still mounted observes a spurious cleanup.
  //
  // `useQuery` stabilizes the thunk via `useMemo([QueryClass, hashValue(args)])`
  // so the same fn is passed to `useReactive` across renders with
  // deeply-equal args. This test asserts that property directly via a dev-only
  // allocation counter. Without the fix, the counter grows with each render.
  it('allocates a stable thunk across re-renders with deeply-equal args', async () => {
    class GetPrices extends TopicQuery {
      static override adapter = MockTopicAdapter;
      params = { walletId: t.string };
      topic = `balances:${this.params.walletId}`;
      result = { items: t.array(t.entity(TopicPrice)) };
    }

    __debug_resetThunkAllocations();
    let bump!: () => void;

    function Component(): React.ReactNode {
      // Fresh inline literal each render, deeply-equal across renders.
      const q = useQuery(GetPrices, { walletId: 'w1' });
      const [, setN] = useState(0);
      bump = () => setN(v => v + 1);
      return <div data-testid="probe">{q.isReady ? 'r' : 'l'}</div>;
    }

    render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Component />
      </ContextProvider>,
    );
    await sleep(20);

    const afterMount = __debug_thunkAllocations;

    for (let i = 0; i < 20; i++) {
      bump();
      await sleep(5);
    }
    await sleep(20);

    expect(__debug_thunkAllocations - afterMount).toBe(0);
  });

  it('re-allocates the thunk when args change structurally', async () => {
    class GetByWallet extends TopicQuery {
      static override adapter = MockTopicAdapter;
      params = { walletId: t.string };
      topic = `balances:${this.params.walletId}`;
      result = { items: t.array(t.entity(TopicPrice)) };
    }

    __debug_resetThunkAllocations();
    let setWalletId!: (id: string) => void;

    function Component(): React.ReactNode {
      const [walletId, setId] = useState('w1');
      setWalletId = setId;
      const q = useQuery(GetByWallet, { walletId });
      return <div data-testid="probe">{q.isReady ? 'r' : 'l'}</div>;
    }

    render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Component />
      </ContextProvider>,
    );
    await sleep(20);

    const afterMount = __debug_thunkAllocations;

    setWalletId('w2');
    await sleep(20);
    setWalletId('w3');
    await sleep(20);

    expect(__debug_thunkAllocations - afterMount).toBe(2);
  });

});
