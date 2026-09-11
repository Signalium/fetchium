import { bench, describe } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { hashValue, snapshot } from 'signalium/utils';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { RESTQuery } from '../rest/index.js';
import { Entity } from '../proxy.js';
import { fetchQuery } from '../query.js';
import { t } from '../typeDefs.js';

/**
 * What `useQuery` costs per render: `useReactive` deep-snapshots the query
 * result on every dependency change, so this is the price of one re-render of
 * a list consumer, without React's own reconciliation.
 *
 * Run with `npm run bench`. Benchmarks build with `IS_DEV: false` so the
 * dev-only snapshot invariant check doesn't skew the numbers.
 */

class Token extends Entity {
  __typename = t.typename('Token');
  id = t.id;
  symbol = t.string;
  name = t.string;
  decimals = t.number;
  price = t.number;
  balance = t.string;
  chain = t.string;
  verified = t.boolean;
  metadata = t.object({ logo: t.string, website: t.string, tags: t.array(t.string) });
}

class GetPortfolio extends RESTQuery {
  params = { count: t.number };
  path = `/portfolio/${this.params.count}`;
  result = { tokens: t.array(t.entity(Token)), updatedAt: t.number };
  getConfig() {
    return { retry: 0, gcTime: Infinity };
  }
}

function portfolio(count: number) {
  return {
    tokens: Array.from({ length: count }, (_, i) => ({
      __typename: 'Token',
      id: `tok-${i}`,
      symbol: `SYM${i}`,
      name: `Token Number ${i}`,
      decimals: 9,
      price: 100 + i,
      balance: `${i * 1000}`,
      chain: 'solana',
      verified: true,
      metadata: { logo: `logo-${i}.png`, website: `t${i}.example.com`, tags: ['defi'] },
    })),
    updatedAt: 1,
  };
}

async function setup(count: number) {
  const client = new QueryClient({
    store: new SyncQueryStore(new MemoryPersistentStore()),
    adapters: [
      new RESTQueryAdapter({
        fetch: (async () =>
          new Response(JSON.stringify(portfolio(count)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })) as unknown as typeof fetch,
        baseUrl: 'http://localhost',
      }),
    ],
  });

  // The listener is what activates the relay, exactly as a mounted consumer
  // does; an unwatched signal never fetches and `await query` never settles.
  const { query, pull } = withContexts([[QueryClientContext, client]], () => {
    const q = fetchQuery(GetPortfolio, { count });
    let prev: unknown;
    const snapshots = watcher(() => (prev = snapshot(q, prev)));
    snapshots.addListener(() => {});
    return { query: q, pull: () => snapshots.value };
  });

  await query;
  pull();
  return { client, pull };
}

/**
 * One fixture per size, built once. The measured body is only the work a
 * streamed event triggers: apply the event, then pull the snapshot the way a
 * mounted consumer would.
 */
const fixtures = await Promise.all([100, 1000].map(async count => ({ count, ...(await setup(count)) })));

for (const { count, client, pull } of fixtures) {
  describe(`${count} entities`, () => {
    let price = 1_000_000;
    let i = 0;

    bench('re-snapshot after one field changes', () => {
      client.applyMutationEvent({
        type: 'update',
        typename: 'Token',
        data: { id: `tok-${i++ % count}`, price: price++ },
      });
      pull();
    });

    bench('re-snapshot after an identical event', () => {
      const key = hashValue(['Token', 'tok-0']);
      const current = client.entityMap.getEntity(key)!.data.price;
      client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-0', price: current } });
      pull();
    });
  });
}

// Whole cold path — client construction, fetch, parse, apply, first snapshot.
// The snapshot is a small part of it, and the samples are noisy (±10-20% rme),
// so don't read a snapshot change off this.
describe('cold query, first snapshot included', () => {
  for (const count of [100, 1000]) {
    bench(`${count} entities`, async () => {
      const { client } = await setup(count);
      client.destroy();
    });
  }
});
