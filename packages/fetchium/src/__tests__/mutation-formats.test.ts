import { describe, it, expect, vi } from 'vitest';
import { hashValue } from 'signalium/utils';
import { t, registerFormat } from '../typeDefs.js';
import { Mask } from '../types.js';
import { Entity } from '../proxy.js';
import { getMutation } from '../mutation.js';
import { RESTMutation, RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { valueKeyFor } from '../stores/shared.js';
import { setupTestClient, testWithClient } from './utils.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace SignaliumQuery {
    interface FormatRegistry {
      'mutation-money': { amount: number };
      'mutation-lazy-money': { amount: number };
    }
  }
}

describe('Formatted mutation results', () => {
  const getClient = setupTestClient();

  it('returns dates from JSON in nested objects, collections, optional fields, and nullable fields', async () => {
    const { client, mockFetch } = getClient();
    const date = '2026-10-13';
    const timestamp = '2026-10-13T12:34:56.000Z';
    mockFetch.post('/enroll', {
      payout: { nextSettlementDate: date },
      dates: [date],
      events: { created: timestamp },
      nullable: null,
      optionalPresent: date,
      nullablePresent: date,
    });

    class Enroll extends RESTMutation {
      readonly path = '/enroll';
      readonly method = 'POST' as const;
      readonly result = {
        payout: t.object({ nextSettlementDate: t.format('date') }),
        dates: t.array(t.format('date')),
        events: t.record(t.format('date-time')),
        nullable: t.nullable(t.format('date')),
        optional: t.optional(t.format('date')),
        optionalPresent: t.optional(t.format('date')),
        nullablePresent: t.nullable(t.format('date')),
      };
    }

    await testWithClient(client, async () => {
      const mutation = getMutation(Enroll);
      const result = await mutation.run(undefined);
      const nextDate = result.payout.nextSettlementDate;

      expect(nextDate).toBeInstanceOf(Date);
      expect(nextDate.valueOf()).toBe(Date.UTC(2026, 9, 13));
      expect(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).format(nextDate)).toBe('10/13/2026');
      expect(result.dates[0]).toBeInstanceOf(Date);
      expect(result.dates[0].valueOf()).toBe(nextDate.valueOf());
      expect(result.events.created).toBeInstanceOf(Date);
      expect(result.events.created.toISOString()).toBe(timestamp);
      expect(result.nullable).toBeNull();
      expect(result.optional).toBeUndefined();
      expect(result.optionalPresent).toBeInstanceOf(Date);
      expect(result.nullablePresent).toBeInstanceOf(Date);
      expect(mutation.value).toBe(result);
      expect(mockFetch.calls).toHaveLength(1);
    });
  });

  it.each([true, false])('uses the registered custom parser (eager: %s)', async eager => {
    const { client, mockFetch } = getClient();
    const money = { amount: 125 };
    const parse = vi.fn(() => money);
    const format = eager ? 'mutation-money' : 'mutation-lazy-money';
    registerFormat(format, Mask.STRING, parse, value => String(value.amount), { eager });
    mockFetch.post('/money', { value: '125' });

    class GetMoney extends RESTMutation {
      readonly path = '/money';
      readonly method = 'POST' as const;
      readonly result = { value: t.format(format) };
    }

    await testWithClient(client, async () => {
      const mutation = getMutation(GetMoney);
      const result = await mutation.run(undefined);

      expect(result.value).toBe(money);
      expect(mutation.value?.value).toBe(money);
      expect(parse).toHaveBeenCalledExactlyOnceWith('125');
      expect(mockFetch.calls).toHaveLength(1);
    });
  });

  it.each([
    ['date', 'invalid-date', /Invalid date string/],
    ['date-time', 'invalid-date-time', /Invalid date-time string/],
    ['date', 123, /expected "date", got number/],
  ] as const)('rejects invalid %s value: %s', async (format, value, error) => {
    const { client, mockFetch } = getClient();
    mockFetch.post('/invalid', { value });

    class InvalidDate extends RESTMutation {
      readonly path = '/invalid';
      readonly method = 'POST' as const;
      readonly result = { value: t.format(format) };
    }

    await testWithClient(client, async () => {
      const mutation = getMutation(InvalidDate);
      await expect(mutation.run(undefined)).rejects.toThrow(error);
      expect(mutation.isRejected).toBe(true);
      expect(mockFetch.calls).toHaveLength(1);
    });
  });

  it('returns undefined for an invalid optional date', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.post('/optional', { value: 'invalid-date' });

    class OptionalDate extends RESTMutation {
      readonly path = '/optional';
      readonly method = 'POST' as const;
      readonly result = { value: t.optional(t.format('date')) };
    }

    await testWithClient(client, async () => {
      const result = await getMutation(OptionalDate).run(undefined);
      expect(result.value).toBeUndefined();
    });
  });

  it('updates the query and cached date without fetching again', async () => {
    const { client, mockFetch, kv } = getClient();
    class Payout extends Entity {
      __typename = t.typename('MutationFormatPayout');
      id = t.id;
      date = t.format('date');
    }

    class GetPayout extends RESTQuery {
      readonly path = '/payout';
      readonly result = { payout: t.entity(Payout) };
    }

    class UpdatePayout extends RESTMutation {
      readonly path = '/payout';
      readonly method = 'POST' as const;
      readonly result = {
        payout: t.object({ __typename: t.string, id: t.id, date: t.string }),
        settledAt: t.format('date-time'),
      };
      readonly effects = { updates: [[Payout, this.result.payout] as const] };
    }

    mockFetch.get('/payout', {
      payout: { __typename: 'MutationFormatPayout', id: '1', date: '2026-10-12' },
    });
    mockFetch.post('/payout', {
      payout: { __typename: 'MutationFormatPayout', id: '1', date: '2026-10-13' },
      settledAt: '2026-10-13T12:34:56.000Z',
    });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPayout);
      const { payout } = await query;
      const result = await getMutation(UpdatePayout).run(undefined);

      expect(result.settledAt).toBeInstanceOf(Date);
      expect(query.value?.payout).toBe(payout);
      expect(payout.date).toBeInstanceOf(Date);
      expect(payout.date.valueOf()).toBe(Date.UTC(2026, 9, 13));
      const stored = JSON.parse(kv.getString(valueKeyFor(hashValue(['MutationFormatPayout', '1'])))!);
      expect(stored.date).toBe('2026-10-13');
      expect(mockFetch.calls.map(call => call.options.method)).toEqual(['GET', 'POST']);
    });
  });
});
