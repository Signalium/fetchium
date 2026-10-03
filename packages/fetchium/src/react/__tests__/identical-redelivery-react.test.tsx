import { describe, it, expect, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider, component } from 'signalium/react';
import React from 'react';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { Entity } from '../../proxy.js';
import { fetchQuery } from '../../query.js';
import { sleep } from '../../__tests__/utils.js';
import { TopicQuery } from '../../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../../topic/TopicQueryAdapter.js';
import type { MutationEvent } from '../../types.js';
import { createRenderCounter } from './utils.js';

/**
 * A stream reconnect re-delivers every on-screen entity with the data it
 * already holds. Readers of those entities must not re-render for it; a real
 * change re-renders them once.
 */

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

class Owner extends Entity {
  __typename = t.typename('Owner');
  id = t.id;
  name = t.string;
}

class Token extends Entity {
  __typename = t.typename('Token');
  id = t.id;
  walletId = t.string;
  price = t.number;
  metadata = t.object({ logo: t.string, tags: t.array(t.string) });
  owner = t.entity(Owner);
}

class Wallet extends Entity {
  __typename = t.typename('Wallet');
  id = t.id;
  tokens = t.liveArray(Token, { constraints: { walletId: (this as unknown as { id: string }).id } });
}

class WalletTopic extends TopicQuery {
  static override adapter = MockTopicAdapter;
  topic = 'wallet:w-1';
  result = { wallet: t.entity(Wallet) };
}

function token(i: number, price = i) {
  return {
    __typename: 'Token',
    id: `tok-${i}`,
    walletId: 'w-1',
    price,
    metadata: { logo: `logo-${i}.png`, tags: ['defi'] },
    owner: { __typename: 'Owner', id: 'o-1', name: 'Ann' },
  };
}

type TokenProxy = { id: string; price: number; metadata: { logo: string }; owner: { name: string } };

describe('React readers on identical re-delivery', () => {
  let client: QueryClient;
  let adapter: MockTopicAdapter;

  beforeEach(() => {
    client?.destroy();
    adapter = new MockTopicAdapter();
    adapter.snapshots.set('wallet:w-1', {
      wallet: { __typename: 'Wallet', id: 'w-1', tokens: [token(0), token(1)] },
    });
    client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [adapter],
    } as never);
  });

  it('does not re-render entity readers when every entity is re-delivered unchanged', async () => {
    const Row = createRenderCounter(
      ({ token }: { token: TokenProxy }) => (
        <span data-testid={`row-${token.id}`}>
          {token.price}:{token.metadata.logo}:{token.owner.name}
        </span>
      ),
      component,
    );

    const ListCounter = createRenderCounter(() => {
      const result = fetchQuery(WalletTopic);
      if (!result.isReady) return <div>Loading...</div>;
      const tokens = result.value.wallet.tokens as unknown as TokenProxy[];
      return (
        <div>
          {tokens.map(tok => (
            <Row key={tok.id} token={tok} />
          ))}
        </div>
      );
    }, component);

    const { getByTestId } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <ListCounter />
      </ContextProvider>,
    );

    await expect.element(getByTestId('row-tok-1')).toHaveTextContent('1:logo-1.png:Ann');
    await sleep(20);
    const rowRendersBefore = Row.renderCount;
    const listRendersBefore = ListCounter.renderCount;

    // Reconnect: every entity re-delivered with the data the store holds.
    for (let pass = 0; pass < 3; pass++) {
      adapter.emit({ type: 'update', typename: 'Wallet', data: { id: 'w-1' } });
      adapter.emit({ type: 'update', typename: 'Token', data: token(0) });
      adapter.emit({ type: 'update', typename: 'Token', data: token(1) });
      adapter.emit({ type: 'update', typename: 'Owner', data: { id: 'o-1', name: 'Ann' } });
    }
    await sleep(50);

    expect(Row.renderCount).toBe(rowRendersBefore);
    expect(ListCounter.renderCount).toBe(listRendersBefore);

    // A real change re-renders the row that reads it, once. (The list re-renders
    // too: its constrained live array re-filters on any member change.)
    adapter.emit({ type: 'update', typename: 'Token', data: token(1, 99) });
    await expect.element(getByTestId('row-tok-1')).toHaveTextContent('99:logo-1.png:Ann');
    await sleep(50);

    expect(Row.renderCount).toBe(rowRendersBefore + 1);
  });
});
