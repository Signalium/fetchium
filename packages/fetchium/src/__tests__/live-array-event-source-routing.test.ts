import { describe, it, expect } from 'vitest';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, sleep, setupTestClient } from './utils.js';
import type { MutationEvent } from '../types.js';

/**
 * Repro: an UNCONSTRAINED liveArray in a query result never receives
 * membership events from that query's own `config.subscribe`.
 *
 * The pattern under test is a "live list": a REST list query whose result is
 * a sorted, unconstrained liveArray, with `getConfig().subscribe` pushing
 * `update` events for upserted rows and `delete` events (`{ id, data: id }`)
 * for removals.
 *
 * Current behavior, pinned by this test:
 *
 * - Field updates to rows already in the array work (entity merge path),
 *   including re-sorting when a sort field changes.
 * - Membership changes never apply: `create` and `update` for unseen ids do
 *   not insert, and `delete` does not remove.
 *
 * Mechanism: an unconstrained liveArray registers under the default
 * constraint `[[EVENT_SOURCE_FIELD, parent.key]]` where parent is the query
 * result's ROOT ENTITY (`createLiveCollection` in LiveCollection.ts), but
 * query subscriptions stamp events with `__eventSource = queryKey`
 * (`reconcileSubscription` in QueryResult.ts). The two keys never agree, so
 * `ConstraintMatcher.routeEvent` never delivers membership events to the
 * binding. Same behavior in the published 0.2.1 dist and current source.
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

  it('applies field updates and re-sorts, but never applies membership events', async () => {
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

      // Field update to an existing row works (entity merge path).
      await emit('w1', {
        type: 'update',
        typename: 'Balance',
        data: { id: 'a', name: 'Alpha Renamed', valueUsdString: '300' },
      });
      const items = (relay.value as { items: Array<{ name: string }> }).items;
      expect(items[0].name).toBe('Alpha Renamed');

      // BROKEN: update for an unseen id does not insert. Expected: live
      // arrays add entities they have not seen when the update matches.
      await emit('w1', {
        type: 'update',
        typename: 'Balance',
        data: { id: 'c', name: 'Gamma', valueUsdString: '200' },
      });
      expect(ids(relay.value)).toEqual(['a', 'b']);

      // BROKEN: create for an unseen id does not insert either.
      await emit('w1', {
        type: 'create',
        typename: 'Balance',
        data: { id: 'k', name: 'Kappa', valueUsdString: '250' },
      });
      expect(ids(relay.value)).toEqual(['a', 'b']);

      // BROKEN: delete does not remove the row.
      await emit('w1', {
        type: 'delete',
        typename: 'Balance',
        id: 'b',
        data: 'b',
      } as MutationEvent);
      expect(ids(relay.value)).toEqual(['a', 'b']);

      // Sort-field update to an existing row re-sorts (reactive output).
      await emit('w1', {
        type: 'update',
        typename: 'Balance',
        data: { id: 'a', valueUsdString: '50' },
      });
      expect(ids(relay.value)).toEqual(['b', 'a']);
    });
  });
});
