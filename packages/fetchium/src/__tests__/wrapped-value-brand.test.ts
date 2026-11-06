import { describe, it, expect, vi } from 'vitest';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, setupTestClient } from './utils.js';

describe('Formatted values', () => {
  const getClient = setupTestClient();

  // Hermes walks every WeakSet entry on each young GC, and a list of formatted fields makes one value per field.
  it('read through without registering each value in a WeakSet', async () => {
    const { client, mockFetch } = getClient();
    class Event extends Entity {
      __typename = t.typename('Event');
      id = t.id;
      day = t.format('date');
    }
    mockFetch.get('/events', {
      events: Array.from({ length: 5 }, (_, id) => ({ __typename: 'Event', id, day: `2024-01-1${id}` })),
    });

    const add = vi.spyOn(WeakSet.prototype, 'add');
    try {
      await testWithClient(client, async () => {
        class GetEvents extends RESTQuery {
          path = '/events';
          result = { events: t.array(t.entity(Event)) };
        }
        const relay = fetchQuery(GetEvents);
        await relay;
        expect(relay.value!.events.map(event => event.day.getUTCDate())).toEqual([10, 11, 12, 13, 14]);
      });
      expect(add.mock.calls.filter(([value]) => value?.constructor?.name === 'FormattedValue')).toHaveLength(0);
    } finally {
      add.mockRestore();
    }
  });
});
