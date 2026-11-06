import { describe, it, expect, vi } from 'vitest';
import { t, registerFormat } from '../typeDefs.js';
import { Mask } from '../types.js';
import { Entity } from '../proxy.js';
import { RESTQuery, RESTMutation } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { getMutation } from '../mutation.js';
import { setupTestClient, testWithClient } from './utils.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace SignaliumQuery {
    interface FormatRegistry {
      'effect-price': number;
    }
  }
}

describe('Mutation effect format inputs', () => {
  const getClient = setupTestClient();

  it.each(['effects', 'getEffects'] as const)('accepts raw date strings through %s', async mode => {
    const { client, mockFetch } = getClient();
    class Payout extends Entity {
      __typename = t.typename('RawEffectPayout');
      id = t.id;
      date = t.format('date');
    }

    class GetPayout extends RESTQuery {
      readonly path = '/payout';
      readonly result = { payout: t.entity(Payout) };
    }

    class UpdatePayout extends RESTMutation {
      readonly path = '/payout';
      readonly result = { payout: t.object({ __typename: t.string, id: t.id, date: t.string }) };
      readonly effects = { updates: [[Payout, this.result.payout] as const] };
    }

    class UpdatePayoutWithComputedEffects extends UpdatePayout {
      getEffects() {
        return { updates: [[Payout, this.result.payout] as const] };
      }
    }

    mockFetch.get('/payout', { payout: { id: '1', date: '2026-10-12' } });
    mockFetch.post('/payout', { payout: { __typename: 'RawEffectPayout', id: '1', date: '2026-10-13' } });

    await testWithClient(client, async () => {
      const { payout } = await fetchQuery(GetPayout);
      await getMutation(mode === 'getEffects' ? UpdatePayoutWithComputedEffects : UpdatePayout).run(undefined);
      expect(payout.date.toISOString()).toBe('2026-10-13T00:00:00.000Z');
      expect(mockFetch.calls).toHaveLength(2);
    });
  });

  it.each([
    { source: 'params', mode: 'effects' },
    { source: 'params', mode: 'getEffects' },
    { source: 'result', mode: 'effects' },
    { source: 'result', mode: 'getEffects' },
  ])('accepts raw numbers from $source through $mode', async ({ source, mode }) => {
    const { client, mockFetch } = getClient();
    registerFormat(
      'effect-price',
      Mask.NUMBER,
      value => value / 100,
      value => value * 100,
    );
    class Price extends Entity {
      __typename = t.typename('RawEffectPrice');
      id = t.id;
      amount = t.format('effect-price');
    }

    class GetPrice extends RESTQuery {
      readonly path = '/price';
      readonly result = { price: t.entity(Price) };
    }

    class UpdatePrice extends RESTMutation {
      readonly params = { amount: t.number };
      readonly path = '/price';
      readonly result = { price: t.object({ id: t.id, amount: t.number }) };
      readonly effects = {
        updates: [[Price, source === 'params' ? { id: '1', amount: this.params.amount } : this.result.price] as const],
      };
    }

    class UpdatePriceWithComputedEffects extends UpdatePrice {
      getEffects() {
        return {
          updates: [
            [Price, source === 'params' ? { id: '1', amount: this.params.amount } : this.result.price] as const,
          ],
        };
      }
    }

    mockFetch.get('/price', { price: { id: '1', amount: 125 } });
    mockFetch.post('/price', { price: { id: '1', amount: 250 } });

    await testWithClient(client, async () => {
      const { price } = await fetchQuery(GetPrice);
      await getMutation(mode === 'getEffects' ? UpdatePriceWithComputedEffects : UpdatePrice).run({ amount: 250 });
      expect(price.amount).toBe(2.5);
      expect(mockFetch.calls).toHaveLength(2);
    });
  });

  it('returns a Date in a successful t.result field', async () => {
    const { client, mockFetch } = getClient();

    class GetDate extends RESTMutation {
      readonly path = '/date';
      readonly result = { at: t.result(t.format('date')) };
    }

    mockFetch.post('/date', { at: '2026-10-13' });
    await testWithClient(client, async () => {
      const result = await getMutation(GetDate).run(undefined);
      expect(result.at.success).toBe(true);
      if (result.at.success) {
        expect(result.at.value).toBeInstanceOf(Date);
        expect(result.at.value.valueOf()).toBe(Date.UTC(2026, 9, 13));
      }
    });
  });

  it('uses formatted values in query invalidation params', async () => {
    const { client, mockFetch } = getClient();
    const invalidate = vi.spyOn(client, 'invalidateQueries');

    class GetDate extends RESTQuery {
      readonly params = { at: t.format('date') };
      readonly path = '/date';
      readonly result = { at: t.format('date') };
    }

    class UpdateDate extends RESTMutation {
      readonly path = '/date';
      readonly result = { at: t.format('date') };
      readonly effects = { invalidates: [[GetDate, { at: this.result.at }] as const] };
    }

    mockFetch.post('/date', { at: '2026-10-13' });
    await testWithClient(client, async () => {
      const result = await getMutation(UpdateDate).run(undefined);
      expect(invalidate).toHaveBeenCalledExactlyOnceWith([[GetDate, { at: result.at }]]);
    });
  });

  it.each(['date', 'object'] as const)('preserves the %s branch of a formatted union in effects', async branch => {
    const { client, mockFetch } = getClient();
    class Item extends Entity {
      __typename = t.typename('UnionEffectItem');
      id = t.id;
      value = t.union(t.format('date'), t.object({ __typename: t.typename('OtherValue'), text: t.string }));
    }

    class GetItem extends RESTQuery {
      readonly path = '/item';
      readonly result = { item: t.entity(Item) };
    }

    class UpdateItem extends RESTMutation {
      readonly path = '/item';
      readonly result = { item: t.entity(Item) };
      readonly effects = { updates: [[Item, this.result.item] as const] };
    }

    const value = branch === 'date' ? '2026-10-13' : { __typename: 'OtherValue', text: 'after' };
    const expected = branch === 'date' ? new Date('2026-10-13T00:00:00.000Z') : value;
    mockFetch.get('/item', { item: { id: '1', value: { __typename: 'OtherValue', text: 'before' } } });
    mockFetch.post('/item', { item: { id: '1', value } });

    await testWithClient(client, async () => {
      const { item } = await fetchQuery(GetItem);
      const result = await getMutation(UpdateItem).run(undefined);
      expect(result.item.value).toEqual(expected);
      expect(item.value).toEqual(expected);
      expect(mockFetch.calls).toHaveLength(2);
    });
  });
});
