import { describe, it, expect } from 'vitest';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, sleep, setupTestClient } from './utils.js';
import type { MutationEvent } from '../types.js';

/**
 * An unconstrained liveArray in a query result must receive membership events
 * from that query's own `config.subscribe`.
 *
 * An unconstrained liveArray registers under the default constraint
 * `[[EVENT_SOURCE_FIELD, parent.key]]`, where parent is the query result's root
 * entity, so a query subscription has to stamp that same key as the event
 * source. Stamping the query key instead routes nowhere, which silently leaves
 * field updates working (they take the entity merge path) while inserts and
 * removals are dropped.
 */

class Balance extends Entity {
  __typename = t.typename('Balance');
  id = t.id;
  name = t.string;
  valueUsdString = t.string;
}

function compareValueUsdString(a: unknown, b: unknown) {
  const left = a as { id: string; valueUsdString: string };
  const right = b as { id: string; valueUsdString: string };

  return Number(right.valueUsdString) - Number(left.valueUsdString) || String(left.id).localeCompare(String(right.id));
}

const emitters = new Map<string, (event: MutationEvent) => void>();

class LiveBalances extends RESTQuery {
  params = { walletAddresses: t.array(t.string) };
  path = '/balances';
  searchParams = { walletAddresses: this.params.walletAddresses };
  result = {
    items: t.liveArray(Balance, { sort: compareValueUsdString }),
    cursor: t.optional(t.string),
  };

  getConfig() {
    return {
      staleTime: 60_000,
      subscribe: (onEvent: (event: MutationEvent) => void) => {
        const wallet = (this.params.walletAddresses as unknown as string[])[0];
        emitters.set(wallet, onEvent);
        return () => {
          emitters.delete(wallet);
        };
      },
    };
  }
}

/** Emit through the query's captured onEvent outside any reactive context. */
async function emit(wallet: string, event: MutationEvent): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => {
      const send = emitters.get(wallet);
      if (send === undefined) throw new Error(`no active subscription for ${wallet}`);
      send(event);
      resolve();
    }, 0);
  });
  await sleep(10);
}

function ids(relayValue: unknown): string[] {
  const value = relayValue as { items: Array<{ id: string }> };
  return value.items.map(item => String(item.id));
}

describe('live array event-source routing', () => {
  const getClient = setupTestClient();

  it('applies field updates and membership events from the query subscription', async () => {
    const { client, mockFetch } = getClient();

    mockFetch.get('/balances', {
      items: [
        { __typename: 'Balance', id: 'a', name: 'Alpha', valueUsdString: '300' },
        { __typename: 'Balance', id: 'b', name: 'Beta', valueUsdString: '100' },
      ],
    });

    await testWithClient(client, async () => {
      const relay = fetchQuery(LiveBalances, { walletAddresses: ['w1'] });
      await relay;

      expect(ids(relay.value)).toEqual(['a', 'b']);

      await emit('w1', {
        type: 'update',
        typename: 'Balance',
        data: { id: 'a', name: 'Alpha Renamed', valueUsdString: '300' },
      });
      const items = (relay.value as { items: Array<{ name: string }> }).items;
      expect(items[0].name).toBe('Alpha Renamed');

      // An update for an id the array has not seen inserts it.
      await emit('w1', {
        type: 'update',
        typename: 'Balance',
        data: { id: 'c', name: 'Gamma', valueUsdString: '200' },
      });
      expect(ids(relay.value)).toEqual(['a', 'c', 'b']);

      await emit('w1', {
        type: 'create',
        typename: 'Balance',
        data: { id: 'k', name: 'Kappa', valueUsdString: '250' },
      });
      expect(ids(relay.value)).toEqual(['a', 'k', 'c', 'b']);

      await emit('w1', {
        type: 'delete',
        typename: 'Balance',
        id: 'b',
        data: 'b',
      } as MutationEvent);
      expect(ids(relay.value)).toEqual(['a', 'k', 'c']);

      await emit('w1', {
        type: 'update',
        typename: 'Balance',
        data: { id: 'a', valueUsdString: '50' },
      });
      expect(ids(relay.value)).toEqual(['k', 'c', 'a']);
    });
  });

  it('scopes membership events to the emitting query', async () => {
    const { client, mockFetch } = getClient();

    mockFetch.get('/balances', {
      items: [{ __typename: 'Balance', id: 'a', name: 'Alpha', valueUsdString: '300' }],
    });

    await testWithClient(client, async () => {
      // Distinct wallets per test: `emitters` is module scope, and a prior
      // test's teardown would otherwise delete a key registered here.
      const first = fetchQuery(LiveBalances, { walletAddresses: ['w3'] });
      const second = fetchQuery(LiveBalances, { walletAddresses: ['w4'] });
      await first;
      await second;

      await emit('w3', {
        type: 'create',
        typename: 'Balance',
        data: { id: 'c', name: 'Gamma', valueUsdString: '200' },
      });

      expect(ids(first.value)).toEqual(['a', 'c']);
      expect(ids(second.value)).toEqual(['a']);
    });
  });
});
