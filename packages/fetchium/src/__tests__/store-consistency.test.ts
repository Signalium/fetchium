import { describe, it, expect, vi } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { valueKeyFor, refCountKeyFor } from '../stores/shared.js';
import { setupTestClient, testWithClient, sleep } from './utils.js';

/** A record the store drops on its own must be written again, or queries referencing it fail to hydrate. */

function getDocument(kv: any, key: number): unknown | undefined {
  const value = kv.getString(valueKeyFor(key));
  return value ? JSON.parse(value) : undefined;
}

/** Holds a query active without making the test body a consumer. */
function holdQuery<T>(client: QueryClient, start: () => T) {
  return withContexts([[QueryClientContext, client]], () => {
    const query = start();
    const w = watcher(() => (query as unknown as { value: unknown }).value);
    w.addListener(() => {});
    return query;
  });
}

describe('Store consistency: _persisted vs store cascade deletion', () => {
  const getClient = setupTestClient();

  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
  }

  class GetProfile extends RESTQuery {
    static cache = { maxCount: 1 };
    params = { id: t.id };
    path = `/user/profile/${this.params.id}`;
    result = { user: t.entity(User) };
  }

  it('re-persists an entity whose store record was cascade-deleted by LRU eviction', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/user/profile/1', { user: { __typename: 'User', id: 1, name: 'Alice' } });
    mockFetch.get('/user/profile/2', { user: { __typename: 'User', id: 2, name: 'Bob' } });
    const userKey = hashValue(['User', 1]);

    const relay1 = holdQuery(client, () => fetchQuery(GetProfile, { id: '1' }));
    await relay1;
    expect(getDocument(kv, userKey)).toBeDefined();

    // maxCount: 1 — the second key evicts Q1 and cascades to User 1.
    const relay2 = holdQuery(client, () => fetchQuery(GetProfile, { id: '2' }));
    await relay2;
    expect(getDocument(kv, userKey)).toBeUndefined();
    expect(kv.getNumber(refCountKeyFor(userKey))).toBeUndefined();

    // Q1, still mounted, refetches identical data.
    const saveEntity = vi.spyOn(store, 'saveEntity');
    await (relay1.value as unknown as { __refetch(): Promise<unknown> }).__refetch();
    await sleep(5);

    const instances = (client as any).queryInstances as Map<number, { storageKey: number }>;
    const q1 = [...instances.values()][0];
    expect(getDocument(kv, q1.storageKey)).toBeDefined();
    expect(kv.getNumber(refCountKeyFor(userKey))).toBeGreaterThan(0);
    // The re-saved query refs User 1, so its record must exist.
    expect(saveEntity).toHaveBeenCalled();
    expect(getDocument(kv, userKey)).toBeDefined();
  });

  it('cold start after the scenario above hydrates from cache instead of dropping it', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/user/profile/1', { user: { __typename: 'User', id: 1, name: 'Alice' } });
    mockFetch.get('/user/profile/2', { user: { __typename: 'User', id: 2, name: 'Bob' } });

    const relay1 = holdQuery(client, () => fetchQuery(GetProfile, { id: '1' }));
    await relay1;
    const relay2 = holdQuery(client, () => fetchQuery(GetProfile, { id: '2' }));
    await relay2;
    await (relay1.value as unknown as { __refetch(): Promise<unknown> }).__refetch();
    await sleep(5);
    client.destroy();

    const warn = vi.fn();
    mockFetch.reset();
    mockFetch.get('/user/profile/1', { user: { __typename: 'User', id: 1, name: 'Refetched' } }, { delay: 500 });
    const client2 = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn },
    } as any);

    await testWithClient(client2, async () => {
      const query = fetchQuery(GetProfile, { id: '1' });
      void query.value;
      await sleep(10);
      // The fetch is delayed, so only the cache can satisfy this.
      expect(warn).not.toHaveBeenCalled();
      expect((query.value as unknown as { user: { name: string } })?.user?.name).toBe('Alice');
    });
    client2.destroy();
  });
});

describe('Store consistency: entity-array narrowing follows entity data', () => {
  const getClient = setupTestClient();

  class UserPreview extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
  }

  class UserFull extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
    email = t.string;
  }

  class Team extends Entity {
    __typename = t.typename('Team');
    id = t.id;
    // Declared first: within one payload u-1 is parsed with the preview def.
    owner = t.entity(UserPreview);
    members = t.array(t.entity(UserFull));
  }

  class GetTeam extends RESTQuery {
    path = '/team';
    result = { team: t.entity(Team) };
  }

  class GetUser extends RESTQuery {
    params = { id: t.id };
    path = `/user/${this.params.id}`;
    result = { user: t.entity(UserFull) };
  }

  it('members narrowed by satisfiesDef recover once the entity gains the missing field', async () => {
    const { client, mockFetch } = getClient();
    const payload = {
      team: {
        __typename: 'Team',
        id: 't-1',
        owner: { __typename: 'User', id: 'u-1', name: 'Alice' },
        members: [
          { __typename: 'User', id: 'u-1', name: 'Alice', email: 'a@x' },
          { __typename: 'User', id: 'u-2', name: 'Bob', email: 'b@x' },
        ],
      },
    };
    mockFetch.get('/team', payload);
    mockFetch.get('/user/u-1', { user: { __typename: 'User', id: 'u-1', name: 'Alice', email: 'a@x' } });

    const team = holdQuery(client, () => fetchQuery(GetTeam));
    await team;
    const members = () => (team.value as any).team.members.map((m: any) => m.id);
    // u-1 lacks email under the preview def, so it is narrowed out.
    expect(members()).toEqual(['u-2']);

    const user = holdQuery(client, () => fetchQuery(GetUser, { id: 'u-1' }));
    await user;
    // u-1 now satisfies UserFull; the refetch returns an identical array.
    await (team.value as any).__refetch();
    await sleep(5);
    expect(members()).toEqual(['u-1', 'u-2']);
  });
});
