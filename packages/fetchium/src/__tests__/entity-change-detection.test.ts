import { describe, it, expect, vi, afterEach } from 'vitest';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { EntityInstance } from '../EntityInstance.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, setupTestClient } from './utils.js';

/**
 * Entity Change Detection Tests
 *
 * A refetch or a poll that returns data the store already holds should be a
 * no-op: no consumer is notified and nothing is written. These tests pin that,
 * and the flip side — that a real change still notifies and still persists.
 */

/** Records `typename:id` for every entity that notifies while active. */
function recordNotifies() {
  const notified: string[] = [];
  const original = EntityInstance.prototype.notify;
  const spy = vi.spyOn(EntityInstance.prototype, 'notify').mockImplementation(function (this: EntityInstance) {
    notified.push(`${this.typename}:${this.id}`);
    original.call(this);
  });
  return { notified, restore: () => spy.mockRestore() };
}

class Token extends Entity {
  __typename = t.typename('Token');
  id = t.id;
  symbol = t.string;
  price = t.number;
  issued = t.format('date-time');
  metadata = t.object({ logo: t.string, tags: t.array(t.string) });
}

class GetPortfolio extends RESTQuery {
  path = '/portfolio';
  result = { tokens: t.array(t.entity(Token)) };
}

class Item extends Entity {
  __typename = t.typename('Item');
  id = t.id;
  listId = t.string;
  name = t.string;
}

class List extends Entity {
  __typename = t.typename('List');
  id = t.id;
  items = t.liveArray(Item, { constraints: { listId: (this as unknown as { id: string }).id } });
}

class GetList extends RESTQuery {
  path = '/list';
  result = { list: t.entity(List) };
}

/** A list whose members are named in order; `i-1`, `i-2`, ... */
function list(...names: string[]) {
  return {
    list: {
      __typename: 'List',
      id: 'l-1',
      items: names.map((name, i) => ({ __typename: 'Item', id: `i-${i + 1}`, listId: 'l-1', name })),
    },
  };
}

function token(i: number, price = i) {
  return {
    __typename: 'Token',
    id: `tok-${i}`,
    symbol: `SYM${i}`,
    price,
    issued: '2026-01-01T00:00:00.000Z',
    metadata: { logo: `logo-${i}.png`, tags: ['defi'] },
  };
}

function portfolio(count: number, price?: (i: number) => number) {
  return { tokens: Array.from({ length: count }, (_, i) => token(i, price?.(i) ?? i)) };
}

describe('Entity Change Detection', () => {
  const getClient = setupTestClient();
  let recorder: ReturnType<typeof recordNotifies> | undefined;

  afterEach(() => {
    recorder?.restore();
    recorder = undefined;
  });

  function tokenSaves(spy: ReturnType<typeof vi.spyOn>) {
    return spy.mock.calls.filter(([, value]) => (value as Record<string, unknown>).__typename === 'Token');
  }

  it('notifies nothing and writes nothing when a refetch returns identical data', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/portfolio', portfolio(3));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;

      const saveEntity = vi.spyOn(store, 'saveEntity');
      const saveQuery = vi.spyOn(store, 'saveQuery');
      recorder = recordNotifies();

      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toEqual([]);
      expect(tokenSaves(saveEntity)).toHaveLength(0);
      // The query's own freshness bookkeeping still has to be written, or the
      // query would look stale forever and refetch on every read.
      expect(saveQuery).toHaveBeenCalled();
    });
  });

  it('notifies and writes only the entities a refetch actually changed', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/portfolio', portfolio(3));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;

      const saveEntity = vi.spyOn(store, 'saveEntity');
      recorder = recordNotifies();

      mockFetch.get(
        '/portfolio',
        portfolio(3, i => (i === 1 ? 99 : i)),
      );
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toEqual(['Token:tok-1']);
      expect(tokenSaves(saveEntity)).toHaveLength(1);
      expect((query.value as unknown as { tokens: { price: number }[] }).tokens[1].price).toBe(99);
    });
  });

  it('treats a change inside a nested object as a change', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(2));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;

      recorder = recordNotifies();

      const changed = portfolio(2);
      changed.tokens[0].metadata.logo = 'new-logo.png';
      mockFetch.get('/portfolio', changed);
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toEqual(['Token:tok-0']);
      expect((query.value as unknown as { tokens: { metadata: { logo: string } }[] }).tokens[0].metadata.logo).toBe(
        'new-logo.png',
      );
    });
  });

  it('keeps an unchanged nested object and its arrays identical across a refetch', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(2));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;

      type Result = { tokens: { metadata: { tags: string[] } }[] };
      const before = (query.value as unknown as Result).tokens[0].metadata;
      const beforeTags = before.tags;

      mockFetch.get(
        '/portfolio',
        portfolio(2, i => i + 100),
      );
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      const after = (query.value as unknown as Result).tokens[0].metadata;
      expect(after).toBe(before);
      expect(after.tags).toBe(beforeTags);
    });
  });

  it('does not treat a formatted value rebuilt from the same input as a change', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(1));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;
      const before = (query.value as unknown as { tokens: { issued: Date }[] }).tokens[0].issued;

      recorder = recordNotifies();

      mockFetch.get('/portfolio', portfolio(1));
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toEqual([]);
      const after = (query.value as unknown as { tokens: { issued: Date }[] }).tokens[0].issued;
      expect(after).toBe(before);
    });
  });

  it('notifies when a formatted value is rebuilt from different input', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(1));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;

      recorder = recordNotifies();

      const changed = portfolio(1);
      changed.tokens[0].issued = '2026-06-01T00:00:00.000Z';
      mockFetch.get('/portfolio', changed);
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toEqual(['Token:tok-0']);
      expect((query.value as unknown as { tokens: { issued: Date }[] }).tokens[0].issued.toISOString()).toBe(
        '2026-06-01T00:00:00.000Z',
      );
    });
  });

  it('notifies nothing when a refetch returns identical live-array membership', async () => {
    const { client, mockFetch } = getClient();

    const response = list('A', 'B');
    mockFetch.get('/list', response);

    await testWithClient(client, async () => {
      const query = fetchQuery(GetList);
      await query;
      const items = (query.value as unknown as { list: { items: { name: string }[] } }).list.items;
      expect(items.map(i => i.name)).toEqual(['A', 'B']);

      recorder = recordNotifies();

      mockFetch.get('/list', response);
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toEqual([]);
      expect((query.value as unknown as { list: { items: { name: string }[] } }).list.items.map(i => i.name)).toEqual([
        'A',
        'B',
      ]);
    });
  });

  it('notifies when a live array gains a member on refetch', async () => {
    const { client, mockFetch } = getClient();

    mockFetch.get('/list', list('A'));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetList);
      await query;

      recorder = recordNotifies();

      mockFetch.get('/list', list('A', 'B'));
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toContain('List:l-1');
      expect((query.value as unknown as { list: { items: { name: string }[] } }).list.items.map(i => i.name)).toEqual([
        'A',
        'B',
      ]);
    });
  });

  it("notifies the changed member, not the list, when a live-array member's own field changes", async () => {
    const { client, mockFetch } = getClient();

    mockFetch.get('/list', list('A', 'B'));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetList);
      await query;

      recorder = recordNotifies();

      // Membership is unchanged, so the list stays quiet.
      mockFetch.get('/list', list('A', 'B2'));
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(recorder.notified).toEqual(['Item:i-2']);
      expect((query.value as unknown as { list: { items: { name: string }[] } }).list.items.map(i => i.name)).toEqual([
        'A',
        'B2',
      ]);
    });
  });

  it('notifies nothing for a mutation event that carries only unchanged fields', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(2));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;
    });

    recorder = recordNotifies();
    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-0', price: 0 } });
    expect(recorder.notified).toEqual([]);

    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-0', price: 7 } });
    expect(recorder.notified).toEqual(['Token:tok-0']);
  });

  it('notifies only the nested entity a mutation event actually changes', async () => {
    const { client, mockFetch } = getClient();

    class Owner extends Entity {
      __typename = t.typename('Owner');
      id = t.id;
      name = t.string;
    }
    class Doc extends Entity {
      __typename = t.typename('Doc');
      id = t.id;
      title = t.string;
      owner = t.entity(Owner);
    }
    class GetDoc extends RESTQuery {
      path = '/doc';
      result = { doc: t.entity(Doc) };
    }

    const doc = (owner: string) => ({
      id: 'd-1',
      title: 'T',
      owner: { __typename: 'Owner', id: 'o-1', name: owner },
    });
    mockFetch.get('/doc', { doc: { __typename: 'Doc', ...doc('Ann') } });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetDoc);
      await query;
    });

    const owner = client.entityMap.getEntity(hashValue(['Owner', 'o-1']))!;
    recorder = recordNotifies();

    // Skipping the notify must not skip the merge, so assert the value either way.
    client.applyMutationEvent({ type: 'update', typename: 'Doc', data: doc('Ann') });
    expect(recorder.notified).toEqual([]);
    expect(owner.data.name).toBe('Ann');

    // The parent's own fields and its ref set are unchanged, so it stays quiet.
    client.applyMutationEvent({ type: 'update', typename: 'Doc', data: doc('Bea') });
    expect(recorder.notified).toEqual(['Owner:o-1']);
    expect(owner.data.name).toBe('Bea');
  });

  it('applies a key removed from a shapeless record', async () => {
    const { client, mockFetch } = getClient();

    class Config extends Entity {
      __typename = t.typename('Config');
      id = t.id;
      attrs = t.record(t.string);
    }
    class GetConfig extends RESTQuery {
      path = '/config';
      result = { config: t.entity(Config) };
    }

    mockFetch.get('/config', { config: { __typename: 'Config', id: 'c-1', attrs: { a: '1', b: '2' } } });

    await testWithClient(client, async () => {
      const query = fetchQuery(GetConfig);
      await query;
      type Result = { config: { attrs: Record<string, string> } };
      expect((query.value as unknown as Result).config.attrs).toEqual({ a: '1', b: '2' });

      recorder = recordNotifies();

      mockFetch.get('/config', { config: { __typename: 'Config', id: 'c-1', attrs: { a: '1' } } });
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      // Copying key by key never applied a removal, so `b` used to survive.
      expect((query.value as unknown as Result).config.attrs).toEqual({ a: '1' });
      expect(recorder.notified).toEqual(['Config:c-1']);
    });
  });

  it('writes an entity that has never been persisted, even when nothing changed', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/portfolio', portfolio(1));

    await testWithClient(client, async () => {
      const query = fetchQuery(GetPortfolio);
      await query;

      const key = hashValue(['Token', 'tok-0']);
      const instance = client.entityMap.getEntity(key)!;
      expect(instance._persisted).toBe(true);

      // An entity applied with persist: false has nothing in the store to
      // skip, so the next apply must write it whether or not data changed.
      instance._persisted = false;
      const saveEntity = vi.spyOn(store, 'saveEntity');
      (query.value as unknown as { __refetch(): void }).__refetch();
      await query;

      expect(tokenSaves(saveEntity)).toHaveLength(1);
    });
  });
});
