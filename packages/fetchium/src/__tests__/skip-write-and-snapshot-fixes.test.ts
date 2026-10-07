import { describe, it, expect, vi, afterEach } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { hashValue, snapshot } from 'signalium/utils';
import { t, registerFormat } from '../typeDefs.js';
import { Mask } from '../types.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { AsyncQueryStore, type AsyncPersistentStore } from '../stores/async.js';
import { valueKeyFor, refIdsKeyFor, queueKeyFor, DEFAULT_MAX_COUNT } from '../stores/shared.js';
import { createMockFetch, setupTestClient, testWithClient, sleep } from './utils.js';

/**
 * Invariants the snapshot fast path, unchanged-apply skipping, single-write
 * events and store deletion reporting must keep.
 */

function getDoc(kv: MemoryPersistentStore, key: number): Record<string, unknown> | undefined {
  const value = kv.getString(valueKeyFor(key));
  return value ? (JSON.parse(value) as Record<string, unknown>) : undefined;
}

/** Holds a query active and exposes `useReactive`-style snapshots of it. */
function snapshotHarness<T>(client: QueryClient, start: () => T) {
  return withContexts([[QueryClientContext, client]], () => {
    const query = start();
    let prev: unknown;
    let computes = 0;
    const snapshots = watcher(() => {
      computes++;
      return (prev = snapshot(query, prev));
    });
    snapshots.addListener(() => {});
    return {
      query,
      read: () => (snapshots.value as { value: any }).value,
      computes: () => computes,
    };
  });
}

function holdQuery<T>(client: QueryClient, start: () => T): T {
  return withContexts([[QueryClientContext, client]], () => {
    const query = start();
    const w = watcher(() => (query as unknown as { value: unknown }).value);
    w.addListener(() => {});
    return query;
  });
}

function makeClient(store: SyncQueryStore | AsyncQueryStore, mockFetch: ReturnType<typeof createMockFetch>) {
  const warn = vi.fn();
  const client = new QueryClient({
    store,
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
    log: { warn, error: () => {} },
  } as never);
  return { client, warn };
}

// ======================================================
// Cache hydration must not re-parse an entity that is already in memory
// ======================================================

describe('hydration of a cached query whose entity is already in memory', () => {
  const getClient = setupTestClient();
  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
    profile = t.object({ city: t.string, since: t.optional(t.format('date')) });
  }
  class GetA extends RESTQuery {
    path = '/a';
    result = { user: t.entity(User) };
    config = { staleTime: 60_000 };
  }
  class GetB extends RESTQuery {
    path = '/b';
    result = { user: t.entity(User), extra: t.string };
    config = { staleTime: 60_000 };
  }
  const payload = { __typename: 'User', id: 1, name: 'Alice', profile: { city: 'Rome', since: '2020-01-01' } };

  it('keeps nested formatted values, notifies nothing, and leaves every consumer consistent', async () => {
    const kv = new MemoryPersistentStore();
    const store = new SyncQueryStore(kv);
    const mockFetch = createMockFetch();
    mockFetch.get('/a', { user: payload });
    mockFetch.get('/b', { user: payload, extra: 'e' });

    // Session 1 persists both queries.
    const { client: first } = makeClient(store, mockFetch);
    await holdQuery(first, () => fetchQuery(GetA));
    await holdQuery(first, () => fetchQuery(GetB));
    first.destroy();

    // Session 2: the network is unreachable; A hydrates, then B hydrates the same entity.
    mockFetch.get('/a', { user: payload }, { delay: 10_000 });
    mockFetch.get('/b', { user: payload, extra: 'e' }, { delay: 10_000 });
    const { client, warn } = makeClient(store, mockFetch);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const hA = snapshotHarness(client, () => fetchQuery(GetA));
      await sleep(20);
      const a1 = hA.read();
      expect(a1.user.profile.since).toBeInstanceOf(Date);
      const computesBefore = hA.computes();

      const hB = snapshotHarness(client, () => fetchQuery(GetB));
      await sleep(20);

      // The in-memory data was not re-parsed: the proxy, the store record and
      // both consumers agree, and A's consumer had no reason to recompute.
      const instance = client.entityMap.getEntity(hashValue(['User', 1]))!;
      expect((instance.data.profile as { since: unknown }).since).toBeDefined();
      expect((hA.query.value as any).user.profile.since).toBeInstanceOf(Date);
      expect(hB.read().user.profile.since).toBeInstanceOf(Date);
      expect(hA.read().user.profile.since).toBe(a1.user.profile.since);
      expect(hA.computes()).toBe(computesBefore);
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      client.destroy();
    }
  });

  for (const absent of [false, true]) {
    it(
      absent
        ? 'rejects the cached query when the in-memory entity holds a field the query requires as absent'
        : 'serves the cached query when the in-memory entity lacks a field only another class declares',
      async () => {
        class Narrow extends Entity {
          __typename = t.typename('Doc');
          id = t.id;
          title = t.string;
        }
        // A response without the optional `body` is fresher than the cache.
        class NarrowWithBody extends Entity {
          __typename = t.typename('Doc');
          id = t.id;
          title = t.string;
          body = t.optional(t.object({ text: t.string }));
        }
        class Wide extends Entity {
          __typename = t.typename('Doc');
          id = t.id;
          title = t.string;
          body = t.object({ text: t.string });
        }
        class GetNarrow extends RESTQuery {
          path = '/narrow';
          result = { doc: t.entity(absent ? NarrowWithBody : Narrow) };
        }
        class GetWide extends RESTQuery {
          path = '/wide';
          result = { doc: t.entity(Wide) };
          config = { staleTime: 60_000 };
        }
        const kv = new MemoryPersistentStore();
        const store = new SyncQueryStore(kv);
        const mockFetch = createMockFetch();
        mockFetch.get('/wide', { doc: { __typename: 'Doc', id: 1, title: 'T', body: { text: 'B' } } });
        mockFetch.get('/narrow', { doc: { __typename: 'Doc', id: 1, title: 'T2' } });

        const { client: first } = makeClient(store, mockFetch);
        await holdQuery(first, () => fetchQuery(GetWide));
        first.destroy();

        // The narrow query fetches fresh, so Doc:1 is in memory without `body`.
        const { client, warn } = makeClient(store, mockFetch);
        await holdQuery(client, () => fetchQuery(GetNarrow));
        const docKey = hashValue(['Doc', 1]);
        mockFetch.get('/wide', { doc: { __typename: 'Doc', id: 1, title: 'T3', body: { text: 'B2' } } });
        const wide = holdQuery(client, () => fetchQuery(GetWide));
        await wide;
        if (absent) {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('query cache may be corrupted'), expect.anything());
          expect((wide.value as any).doc.body.text).toBe('B2');
        } else {
          expect(warn).not.toHaveBeenCalled();
          expect(mockFetch.calls.filter(c => c.url.endsWith('/wide'))).toHaveLength(1);
          expect((wide.value as any).doc.title).toBe('T2');
          expect((wide.value as any).doc.body.text).toBe('B');
          expect(getDoc(kv, docKey)).toEqual({ __typename: 'Doc', id: 1, title: 'T2', body: { text: 'B' } });
        }
        client.destroy();
      },
    );
  }

  it('rejects the cached query when the in-memory entity lacks a nested entity the query requires', async () => {
    class Org extends Entity {
      __typename = t.typename('Org');
      id = t.id;
      name = t.string;
    }
    class UserSummary extends Entity {
      __typename = t.typename('User');
      id = t.id;
      meta = t.object({ x: t.number });
    }
    class UserFull extends Entity {
      __typename = t.typename('User');
      id = t.id;
      meta = t.object({ x: t.number, owner: t.entity(Org) });
    }
    class GetSummary extends RESTQuery {
      path = '/summary';
      result = { user: t.entity(UserSummary) };
      config = { staleTime: 60_000 };
    }
    class GetFull extends RESTQuery {
      path = '/full';
      result = { user: t.entity(UserFull) };
      config = { staleTime: 60_000 };
    }
    const full = { __typename: 'User', id: 1, meta: { x: 1, owner: { __typename: 'Org', id: 'o1', name: 'Acme' } } };
    const kv = new MemoryPersistentStore();
    const store = new SyncQueryStore(kv);
    const mockFetch = createMockFetch();
    mockFetch.get('/summary', { user: { __typename: 'User', id: 1, meta: { x: 1 } } });
    mockFetch.get('/full', { user: full });

    const { client: first } = makeClient(store, mockFetch);
    await holdQuery(first, () => fetchQuery(GetSummary));
    await holdQuery(first, () => fetchQuery(GetFull));
    first.destroy();

    // Session 2: the summary hydrates User:1 without `meta.owner`; the full
    // query must not resolve from the cache with the owner missing.
    mockFetch.get('/full', { user: { ...full, meta: { ...full.meta, x: 2 } } }, { delay: 50 });
    const { client, warn } = makeClient(store, mockFetch);
    const summary = holdQuery(client, () => fetchQuery(GetSummary));
    await sleep(10);
    expect((summary.value as any).user.meta.x).toBe(1);

    const wide = holdQuery(client, () => fetchQuery(GetFull));
    await sleep(10);
    expect(wide.value).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('query cache may be corrupted'), expect.anything());
    await wide;
    expect((wide.value as any).user.meta.owner.name).toBe('Acme');
    expect((wide.value as any).user.meta.x).toBe(2);
    client.destroy();
  });

  for (const absent of [false, true]) {
    it(
      absent
        ? 'a cached list holding an in-memory entity the query cannot use is refetched whole, not served with a hole'
        : 'a cached list holding an in-memory entity that lacks a field only another class declares is served whole',
      async () => {
        class Narrow extends Entity {
          __typename = t.typename('Doc');
          id = t.id;
          title = t.string;
        }
        class NarrowWithBody extends Entity {
          __typename = t.typename('Doc');
          id = t.id;
          title = t.string;
          body = t.optional(t.object({ text: t.string }));
        }
        class Wide extends Entity {
          __typename = t.typename('Doc');
          id = t.id;
          title = t.string;
          body = t.object({ text: t.string });
        }
        class GetNarrow extends RESTQuery {
          params = { id: t.id };
          path = `/narrow/${this.params.id}`;
          result = { doc: t.entity(absent ? NarrowWithBody : Narrow) };
        }
        class GetDocs extends RESTQuery {
          path = '/docs';
          result = { docs: t.array(t.entity(Wide)) };
          config = { staleTime: 60_000 };
        }
        const kv = new MemoryPersistentStore();
        const store = new SyncQueryStore(kv);
        const mockFetch = createMockFetch();
        const docs = [
          { __typename: 'Doc', id: 1, title: 'T1', body: { text: 'B1' } },
          { __typename: 'Doc', id: 2, title: 'T2', body: { text: 'B2' } },
        ];
        mockFetch.get('/docs', { docs });
        mockFetch.get('/narrow/1', { doc: { __typename: 'Doc', id: 1, title: 'T1' } });

        const { client: first } = makeClient(store, mockFetch);
        await holdQuery(first, () => fetchQuery(GetDocs));
        first.destroy();

        // Doc:1 comes into memory through the narrow query, without `body`.
        const { client, warn } = makeClient(store, mockFetch);
        await holdQuery(client, () => fetchQuery(GetNarrow, { id: 1 }));
        mockFetch.get('/docs', { docs: docs.map(d => ({ ...d, body: { text: `${d.body.text}!` } })) });
        const list = holdQuery(client, () => fetchQuery(GetDocs));
        await list;
        if (absent) {
          expect(warn).toHaveBeenCalledWith(expect.stringContaining('query cache may be corrupted'), expect.anything());
          expect((list.value as any).docs.map((d: any) => d.body.text)).toEqual(['B1!', 'B2!']);
        } else {
          expect(warn).not.toHaveBeenCalled();
          expect((list.value as any).docs.map((d: any) => d.body.text)).toEqual(['B1', 'B2']);
        }
        client.destroy();
      },
    );
  }

  it('a member the query narrows out anyway does not reject the cached query', async () => {
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
      owner = t.entity(UserPreview);
      members = t.array(t.entity(UserFull));
    }
    class GetTeam extends RESTQuery {
      path = '/team';
      result = { team: t.entity(Team) };
      config = { staleTime: 60_000 };
    }
    class GetOwner extends RESTQuery {
      path = '/owner';
      result = { user: t.entity(UserPreview) };
    }
    const kv = new MemoryPersistentStore();
    const store = new SyncQueryStore(kv);
    const mockFetch = createMockFetch();
    mockFetch.get('/team', {
      team: {
        __typename: 'Team',
        id: 't-1',
        owner: { __typename: 'User', id: 'u-1', name: 'Alice' },
        members: [
          { __typename: 'User', id: 'u-1', name: 'Alice' },
          { __typename: 'User', id: 'u-2', name: 'Bob', email: 'b@x' },
        ],
      },
    });
    mockFetch.get('/owner', { user: { __typename: 'User', id: 'u-1', name: 'Alice' } });
    const { client: first } = makeClient(store, mockFetch);
    await holdQuery(first, () => fetchQuery(GetTeam));
    first.destroy();

    // u-1 is in memory without `email`; the members array narrows it out on
    // read, so the cached team is still usable as it is.
    const { client, warn } = makeClient(store, mockFetch);
    await holdQuery(client, () => fetchQuery(GetOwner));
    mockFetch.get(
      '/team',
      { team: { __typename: 'Team', id: 't-1', owner: { __typename: 'User', id: 'u-1', name: 'FRESH' }, members: [] } },
      { delay: 5000 },
    );
    const team = holdQuery(client, () => fetchQuery(GetTeam));
    await sleep(20);
    expect(warn).not.toHaveBeenCalled();
    expect((team.value as any).team.members.map((m: any) => m.id)).toEqual(['u-2']);
    expect((team.value as any).team.owner.name).toBe('Alice');
    client.destroy();
  });

  it('an entity built from events is completed from its record when a cached query hydrates it', async () => {
    class Post extends Entity {
      __typename = t.typename('Post');
      id = t.id;
      feedId = t.string;
      title = t.string;
      body = t.optional(t.string);
      tags = t.optional(t.array(t.string));
    }
    class GetPost extends RESTQuery {
      params = { id: t.id };
      path = `/post/${this.params.id}`;
      result = { post: t.entity(Post) };
      config = { staleTime: 60_000 };
    }
    class Feed extends Entity {
      __typename = t.typename('Feed');
      id = t.id;
      posts = t.liveArray(Post, { constraints: { feedId: (this as any).id } });
    }
    class GetFeed extends RESTQuery {
      params = { id: t.id };
      path = `/feed/${this.params.id}`;
      result = { feed: t.entity(Feed) };
    }
    const kv = new MemoryPersistentStore();
    const store = new SyncQueryStore(kv);
    const mockFetch = createMockFetch();
    mockFetch.get('/post/p1', {
      post: { __typename: 'Post', id: 'p1', feedId: 'f1', title: 'T', body: 'hello', tags: ['a', 'b'] },
    });
    mockFetch.get('/feed/f1', { feed: { __typename: 'Feed', id: 'f1', posts: [] } });
    const { client: first } = makeClient(store, mockFetch);
    await holdQuery(first, () => fetchQuery(GetPost, { id: 'p1' }));
    first.destroy();

    // The post comes into memory through an event routed into the feed:
    // title only. Then the cached post query hydrates the same entity.
    const { client, warn } = makeClient(store, mockFetch);
    const feed = holdQuery(client, () => fetchQuery(GetFeed, { id: 'f1' }));
    await feed;
    client.applyMutationEvent({
      type: 'create',
      typename: 'Post',
      data: { __typename: 'Post', id: 'p1', feedId: 'f1', title: 'T2' },
    });
    await sleep(5);
    expect((feed.value as any).feed.posts.map((p: any) => p.title)).toEqual(['T2']);
    const instance = client.entityMap.getEntity(hashValue(['Post', 'p1']))!;
    expect(instance._partial).toBe(true);
    expect(instance.data.body).toBeUndefined();

    mockFetch.get(
      '/post/p1',
      { post: { __typename: 'Post', id: 'p1', title: 'FRESH', body: 'fresh' } },
      { delay: 5000 },
    );
    const post = holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));
    await sleep(20);
    expect(warn).not.toHaveBeenCalled();
    // The event's title stays; the fields it did not carry come from the record.
    expect((post.value as any).post.title).toBe('T2');
    expect((post.value as any).post.body).toBe('hello');
    expect((post.value as any).post.tags).toEqual(['a', 'b']);
    expect((feed.value as any).feed.posts[0].body).toBe('hello');
    expect(instance._partial).toBe(false);
    client.destroy();
  });

  it('a frozen payload with undeclared nested values is applied without being written to', async () => {
    const { client, mockFetch } = getClient();
    class Doc extends Entity {
      __typename = t.typename('Doc');
      id = t.id;
      title = t.string;
      meta = t.object({ views: t.number });
    }
    class GetDoc extends RESTQuery {
      path = '/doc';
      result = { doc: t.entity(Doc) };
    }
    mockFetch.get('/doc', { doc: { __typename: 'Doc', id: 'd', title: 'T', meta: { views: 1, deep: { x: [1] } } } });
    const h = snapshotHarness(client, () => fetchQuery(GetDoc));
    await h.query;
    const snap = h.read().doc;
    const warn = vi.spyOn(client.getContext().log as { warn: (...args: unknown[]) => void }, 'warn');

    const frozen = Object.freeze({
      id: 'd',
      title: 'T2',
      meta: Object.freeze({ views: 2, deep: Object.freeze({ x: Object.freeze([2]) }) }),
    });
    client.applyMutationEvent({ type: 'update', typename: 'Doc', data: frozen });
    expect(warn).not.toHaveBeenCalled();
    expect(h.read().doc.title).toBe('T2');
    expect(h.read().doc.meta.views).toBe(2);
    expect(snap.meta.views).toBe(1);
  });

  it('a frozen fetch result is applied without being written to, and later merges reach its nested values', async () => {
    class DocNote extends Entity {
      __typename = t.typename('DocNote');
      id = t.id;
      docId = t.string;
    }
    class Doc extends Entity {
      __typename = t.typename('Doc');
      id = t.id;
      title = t.string;
      meta = t.object({ views: t.number, stats: t.object({ likes: t.number }) });
      counts = t.record(t.number);
      tags = t.array(t.string);
      notes = t.liveArray(DocNote, { constraints: { docId: (this as any).id } });
    }
    class GetDoc extends RESTQuery {
      path = '/doc';
      result = { doc: t.entity(Doc), note: t.object({ text: t.string }) };
    }
    const deepFreeze = <T>(value: T): T => {
      if (typeof value === 'object' && value !== null) {
        for (const v of Object.values(value)) deepFreeze(v);
        Object.freeze(value);
      }
      return value;
    };
    const body = deepFreeze({
      doc: {
        __typename: 'Doc',
        id: 'd',
        title: 'T',
        meta: { views: 1, stats: { likes: 3 } },
        counts: { a: 1 },
        tags: ['x'],
        notes: [],
      },
      note: { text: 'n' },
    });
    const before = JSON.stringify(body);
    // Hands out the same frozen object on every call, as an adapter that
    // keeps its last response may.
    const fetch = async () => ({ ok: true, status: 200, headers: new Headers(), json: async () => body });
    const { client, warn } = makeClient(
      new SyncQueryStore(new MemoryPersistentStore()),
      fetch as unknown as ReturnType<typeof createMockFetch>,
    );
    const h = snapshotHarness(client, () => fetchQuery(GetDoc));
    await h.query;
    expect(h.read().doc.meta.stats.likes).toBe(3);
    expect(h.read().note.text).toBe('n');

    client.applyMutationEvent({
      type: 'update',
      typename: 'Doc',
      data: { id: 'd', meta: { views: 2, stats: { likes: 4 } }, counts: { a: 2 } },
    });
    expect(warn).not.toHaveBeenCalled();
    expect(h.read().doc.meta.views).toBe(2);
    expect(h.read().doc.meta.stats.likes).toBe(4);
    expect(h.read().doc.counts.a).toBe(2);
    // The live array grows its own array, not the response's (empty, frozen) one.
    client.applyMutationEvent({
      type: 'create',
      typename: 'DocNote',
      data: { __typename: 'DocNote', id: 'n1', docId: 'd' },
    });
    expect(h.read().doc.notes.map((n: { id: string }) => n.id)).toEqual(['n1']);
    expect(h.read().doc.tags).toEqual(['x']);

    // A refetch of the same (frozen) response puts the old values back.
    await (h.query as any).value.__refetch();
    await sleep(5);
    expect(h.read().doc.meta.stats.likes).toBe(3);
    expect(h.read().doc.counts.a).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    expect(JSON.stringify(body)).toBe(before);
    client.destroy();
  });
});

// ======================================================
// Streamed events: what an event changes in an existing entity is written
// ======================================================

describe('mutation events and the store', () => {
  const getClient = setupTestClient();

  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
    karma = t.number;
    badge = t.optional(t.entity(Badge));
  }
  class Badge extends Entity {
    __typename = t.typename('Badge');
    id = t.id;
    label = t.string;
  }
  class Comment extends Entity {
    __typename = t.typename('Comment');
    id = t.id;
    postId = t.string;
    body = t.string;
    author = t.entity(User);
  }
  class Post extends Entity {
    __typename = t.typename('Post');
    id = t.id;
    title = t.string;
    comments = t.liveArray(Comment, { constraints: { postId: (this as any).id } });
  }
  class GetPost extends RESTQuery {
    params = { id: t.id };
    path = `/post/${this.params.id}`;
    result = { post: t.entity(Post) };
  }
  class GetUser extends RESTQuery {
    params = { id: t.id };
    path = `/user/${this.params.id}`;
    result = { user: t.entity(User) };
  }
  const u1Key = hashValue(['User', 'u1']);
  const badgeKey = hashValue(['Badge', 'b1']);

  async function seed(client: QueryClient, mockFetch: ReturnType<typeof createMockFetch>, withPost: boolean) {
    mockFetch.get('/user/u1', { user: { __typename: 'User', id: 'u1', name: 'Alice', karma: 10 } });
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments: [] } });
    const userQ = holdQuery(client, () => fetchQuery(GetUser, { id: 'u1' }));
    await userQ;
    const postQ = withPost ? holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' })) : undefined;
    if (postQ) await postQ;
    return { userQ, postQ };
  }

  const createEvent = (withBadge: boolean) => ({
    type: 'create' as const,
    typename: 'Comment',
    data: {
      __typename: 'Comment',
      id: 'c9',
      postId: 'p1',
      body: 'hi',
      author: {
        __typename: 'User',
        id: 'u1',
        name: 'Alice',
        karma: 11,
        ...(withBadge ? { badge: { __typename: 'Badge', id: 'b1', label: 'gold' } } : {}),
      },
    },
  });

  it('a create routed into a live array writes the existing author it changed, and the new badge under it', async () => {
    const { client, mockFetch, kv } = getClient();
    await seed(client, mockFetch, true);
    expect(getDoc(kv, u1Key)!.karma).toBe(10);

    client.applyMutationEvent(createEvent(true));
    await sleep(5);

    expect(getDoc(kv, u1Key)!.karma).toBe(11);
    expect(getDoc(kv, badgeKey)).toMatchObject({ label: 'gold' });
    expect(Array.from(kv.getBuffer(refIdsKeyFor(u1Key)) ?? [])).toEqual([badgeKey]);
    expect(getDoc(kv, hashValue(['Comment', 'c9']))).toMatchObject({ body: 'hi' });
  });

  it('a create nothing routes still writes the existing author it changed, and writes no orphan', async () => {
    const { client, mockFetch, kv } = getClient();
    await seed(client, mockFetch, true);

    // The post's live array is constrained to postId p1; this comment is for another post.
    const event = createEvent(false);
    client.applyMutationEvent({ ...event, data: { ...event.data, postId: 'p2' } });
    await sleep(5);

    expect(getDoc(kv, u1Key)!.karma).toBe(11);
    expect(getDoc(kv, hashValue(['Comment', 'c9']))).toBeUndefined();
    expect(client.entityMap.getEntity(hashValue(['Comment', 'c9']))).toBeUndefined();
  });

  it('a full-payload update for an entity on disk but not in memory refreshes its record', async () => {
    const { client, mockFetch, kv, store } = getClient();
    await seed(client, mockFetch, false);
    // Evict User u1 from memory while its record stays referenced by the cached query.
    client.entityMap.getEntity(u1Key)!.evict();
    expect(client.entityMap.getEntity(u1Key)).toBeUndefined();
    expect(getDoc(kv, u1Key)!.name).toBe('Alice');

    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u1', name: 'Alicia', karma: 12 },
    });
    await sleep(5);

    expect(client.entityMap.getEntity(u1Key)).toBeUndefined();
    expect(getDoc(kv, u1Key)).toMatchObject({ name: 'Alicia', karma: 12 });
    expect(store.hasEntity(u1Key)).toBe(true);

    // An update for an entity the store has never seen leaves nothing behind.
    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u404', name: 'Nobody', karma: 0 },
    });
    await sleep(5);
    expect(getDoc(kv, hashValue(['User', 'u404']))).toBeUndefined();
  });
});

// ======================================================
// `_persisted` is only trusted while the store agrees
// ======================================================

describe('write skipping stays consistent with the store', () => {
  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
  }
  class GetUser extends RESTQuery {
    path = '/user';
    result = { user: t.entity(User) };
  }
  const userKey = hashValue(['User', 1]);

  it('a store write that throws is retried by the next unchanged apply', async () => {
    const kv = new MemoryPersistentStore();
    const store = new SyncQueryStore(kv);
    const mockFetch = createMockFetch();
    mockFetch.get('/user', { user: { __typename: 'User', id: 1, name: 'Alice' } });
    const { client } = makeClient(store, mockFetch);

    const relay = holdQuery(client, () => fetchQuery(GetUser));
    await relay;
    expect(getDoc(kv, userKey)).toMatchObject({ name: 'Alice' });

    // The next refetch changes the name, and the store rejects that write.
    const setString = kv.setString.bind(kv);
    let failing = true;
    vi.spyOn(kv, 'setString').mockImplementation((key, value) => {
      if (failing && key === valueKeyFor(userKey)) throw new Error('quota exceeded');
      setString(key, value);
    });
    mockFetch.get('/user', { user: { __typename: 'User', id: 1, name: 'Alicia' } });
    await expect((relay.value as any).__refetch()).rejects.toThrow('quota exceeded');
    expect((relay.value as any)?.user?.name ?? client.entityMap.getEntity(userKey)!.data.name).toBe('Alicia');
    expect(getDoc(kv, userKey)).toMatchObject({ name: 'Alice' });

    // The store recovers; the refetch returns the same data the entity already
    // holds, so nothing changed in memory, yet the record must be rewritten.
    failing = false;
    await withContexts([[QueryClientContext, client]], () => fetchQuery(GetUser).value ?? undefined);
    await (client as any).queryInstances.values().next().value.refetch();
    await sleep(20);
    expect(getDoc(kv, userKey)).toMatchObject({ name: 'Alicia' });
    client.destroy();
  });

  it('QueryClient.destroy() removes its store listeners', () => {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const listeners = () => (store as unknown as { deleteListeners: unknown[] }).deleteListeners.length;
    const clients = Array.from({ length: 5 }, () => new QueryClient({ store }));
    expect(listeners()).toBe(5);
    for (const client of clients) client.destroy();
    expect(listeners()).toBe(0);
  });
});

// ======================================================
// AsyncQueryStore writer
// ======================================================

class AsyncDelegate implements AsyncPersistentStore {
  readonly kv: Record<string, unknown> = Object.create(null);
  failNextSetString: string | undefined;
  private async tick(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  async has(key: string) {
    await this.tick();
    return key in this.kv;
  }
  async getString(key: string) {
    await this.tick();
    return this.kv[key] as string | undefined;
  }
  async setString(key: string, value: string) {
    await this.tick();
    if (this.failNextSetString === key) {
      this.failNextSetString = undefined;
      throw new Error('injected failure');
    }
    this.kv[key] = value;
  }
  async getNumber(key: string) {
    await this.tick();
    return this.kv[key] as number | undefined;
  }
  async setNumber(key: string, value: number) {
    await this.tick();
    this.kv[key] = value;
  }
  async getBuffer(key: string) {
    await this.tick();
    return this.kv[key] as Uint32Array | undefined;
  }
  async setBuffer(key: string, value: Uint32Array) {
    await this.tick();
    this.kv[key] = value;
  }
  async delete(key: string) {
    await this.tick();
    delete this.kv[key];
  }
  async getAllKeys() {
    await this.tick();
    return Object.keys(this.kv);
  }
}

function writerStore(delegate: AsyncPersistentStore): AsyncQueryStore {
  return new AsyncQueryStore({
    isWriter: true,
    delegate,
    connect: handleMessage => ({ sendMessage: msg => handleMessage(msg) }),
  });
}

async function drain(store: AsyncQueryStore): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (store.isSettled()) return;
    await sleep(2);
  }
  throw new Error('writer queue did not drain');
}

describe('AsyncQueryStore writer used in-process', () => {
  const clients: QueryClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
  });

  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
  }
  class GetProfile extends RESTQuery {
    static cache = { maxCount: 2 };
    params = { id: t.id };
    path = `/user/profile/${this.params.id}`;
    result = { user: t.entity(User) };
  }
  const userKey = (id: string | number) => hashValue(['User', id]);

  it('an unchanged refetch racing a queued eviction still leaves the query hydratable', async () => {
    const delegate = new AsyncDelegate();
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    for (const id of ['1', '2', '3']) {
      mockFetch.get(`/user/profile/${id}`, { user: { __typename: 'User', id, name: `User ${id}` } });
    }
    const { client, warn } = makeClient(store, mockFetch);
    clients.push(client);

    const q1 = holdQuery(client, () => fetchQuery(GetProfile, { id: '1' }));
    await q1;
    await holdQuery(client, () => fetchQuery(GetProfile, { id: '2' }));
    await drain(store);
    expect(delegate.kv[valueKeyFor(userKey('1'))]).toBeDefined();

    // Q3's SaveQuery will evict Q1 and cascade to User 1 once processed. Before
    // the writer gets there, Q1 refetches identical data.
    await holdQuery(client, () => fetchQuery(GetProfile, { id: '3' }));
    expect(store.isSettled()).toBe(false);
    await (q1.value as any).__refetch();
    await drain(store);

    expect(delegate.kv[valueKeyFor(userKey('1'))]).toBeDefined();
    expect(warn).not.toHaveBeenCalled();

    // Cold start on the same store: Q1 hydrates from cache.
    client.destroy();
    clients.pop();
    mockFetch.reset();
    mockFetch.get('/user/profile/1', { user: { __typename: 'User', id: '1', name: 'Refetched' } }, { delay: 2000 });
    const cold = makeClient(store, mockFetch);
    clients.push(cold.client);
    const relay = holdQuery(cold.client, () => fetchQuery(GetProfile, { id: '1' }));
    await sleep(150);
    expect(cold.warn).not.toHaveBeenCalled();
    expect((relay.value as any)?.user?.name).toBe('User 1');
  });

  it('a SaveEntity the delegate rejected is written again by the next unchanged apply', async () => {
    const delegate = new AsyncDelegate();
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    mockFetch.get('/user/profile/1', { user: { __typename: 'User', id: '1', name: 'Alice' } });
    const { client } = makeClient(store, mockFetch);
    clients.push(client);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      delegate.failNextSetString = valueKeyFor(userKey('1'));
      const q1 = holdQuery(client, () => fetchQuery(GetProfile, { id: '1' }));
      await q1;
      await drain(store);
      expect(delegate.kv[valueKeyFor(userKey('1'))]).toBeUndefined();

      await (q1.value as any).__refetch();
      await drain(store);
      expect(delegate.kv[valueKeyFor(userKey('1'))]).toBeDefined();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('a rejected SaveEntity over an existing record still treats the record as held', async () => {
    const delegate = new AsyncDelegate();
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    mockFetch.get('/user/profile/1', { user: { __typename: 'User', id: '1', name: 'Alice' } });
    const { client } = makeClient(store, mockFetch);
    clients.push(client);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const name = () => JSON.parse(delegate.kv[valueKeyFor(userKey('1'))] as string).name;
    const update = (newName: string) =>
      client.applyMutationEvent({
        type: 'update',
        typename: 'User',
        data: { __typename: 'User', id: '1', name: newName },
      });
    try {
      await holdQuery(client, () => fetchQuery(GetProfile, { id: '1' }));
      await drain(store);

      delegate.failNextSetString = valueKeyFor(userKey('1'));
      update('Bob');
      await drain(store);
      expect(name()).toBe('Alice');
      expect(store.hasEntity!(userKey('1'))).toBe(true);

      // With the entity out of memory, the next update must still reach the record.
      client.entityMap.getEntity(userKey('1'))!.evict();
      update('Carol');
      await drain(store);
      expect(name()).toBe('Carol');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('resizes a persisted LRU queue in both directions and defaults a missing maxCount', async () => {
    const delegate = new AsyncDelegate();
    const store = writerStore(delegate);
    const defId = 'upgrade-def';
    const def = (maxCount: number) => ({ statics: { id: defId, cache: { maxCount } } }) as never;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // A 4-slot queue from an older install, fully populated, with records behind each key.
      const old = new Uint32Array([4, 3, 2, 1]);
      delegate.kv[queueKeyFor(defId)] = old;
      for (const key of old) {
        delegate.kv[valueKeyFor(key)] = JSON.stringify({ __entityRef: key });
        delegate.kv[`sq:doc:updatedAt:${key}`] = 1;
      }
      delegate.kv[valueKeyFor(9)] = JSON.stringify({ __entityRef: 9 });

      // Grow: the buffer is reallocated, the order kept, nothing evicted.
      store.activateQuery(def(6), 9);
      await drain(store);
      let queue = delegate.kv[queueKeyFor(defId)] as Uint32Array;
      expect(Array.from(queue)).toEqual([9, 4, 3, 2, 1, 0]);
      expect(consoleError).not.toHaveBeenCalled();

      // Shrink (after a restart, so the in-memory queue is not cached): the
      // keys that no longer fit are evicted, not stranded.
      const restarted = writerStore(delegate);
      restarted.activateQuery(def(3), 9);
      await drain(restarted);
      queue = delegate.kv[queueKeyFor(defId)] as Uint32Array;
      expect(Array.from(queue)).toEqual([9, 4, 3]);
      expect(delegate.kv[valueKeyFor(2)]).toBeUndefined();
      expect(delegate.kv[valueKeyFor(1)]).toBeUndefined();
      expect(delegate.kv[valueKeyFor(4)]).toBeDefined();

      // A message from a reader that predates `maxCount` uses the default size.
      const fresh = new AsyncDelegate();
      const freshStore = writerStore(fresh);
      fresh.kv[valueKeyFor(7)] = JSON.stringify({ __entityRef: 7 });
      (freshStore as unknown as { handleMessage(msg: unknown): void }).handleMessage({
        type: 2,
        queryDefId: 'legacy-def',
        queryKey: 7,
        cacheTime: 1440,
      });
      await drain(freshStore);
      const legacyQueue = fresh.kv[queueKeyFor('legacy-def')] as Uint32Array;
      expect(legacyQueue.length).toBe(DEFAULT_MAX_COUNT);
      expect(legacyQueue[0]).toBe(7);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});

// ======================================================
// Snapshot fast path
// ======================================================

describe('snapshot fast path follow-ups', () => {
  const getClient = setupTestClient();

  it('a NaN in a static field neither reports drift nor churns snapshot identity', async () => {
    const { client, mockFetch } = getClient();
    // JSON cannot carry NaN; a lenient string-to-number format can.
    registerFormat(
      'loose-number',
      Mask.STRING,
      (value: string) => Number(value),
      (value: number) => String(value),
    );
    class Stat extends Entity {
      __typename = t.typename('Stat');
      id = t.id;
      label = t.string;
      ratio = t.format('loose-number' as never);
      series = t.array(t.format('loose-number' as never));
    }
    class GetStats extends RESTQuery {
      path = '/stats';
      result = { stats: t.array(t.entity(Stat)) };
    }
    mockFetch.get('/stats', {
      stats: [
        { __typename: 'Stat', id: 's', label: 'a', ratio: 'N/A', series: ['1', 'N/A'] },
        { __typename: 'Stat', id: 'other', label: 'b', ratio: '1', series: [] },
      ],
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const h = snapshotHarness(client, () => fetchQuery(GetStats));
      await h.query;
      const first = h.read().stats[0];
      client.applyMutationEvent({ type: 'update', typename: 'Stat', data: { id: 'other', label: 'c' } });
      const second = h.read().stats[0];
      expect(Number.isNaN(second.ratio)).toBe(true);
      expect(second).toBe(first);
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('two classes sharing a typename: a child entity under a field the other class declares entity-free still reaches the consumer', async () => {
    const { client, mockFetch } = getClient();
    class Org extends Entity {
      __typename = t.typename('Org');
      id = t.id;
      name = t.string;
    }
    class UserSummary extends Entity {
      __typename = t.typename('User');
      id = t.id;
      name = t.string;
      meta = t.object({ x: t.number });
    }
    class UserFull extends Entity {
      __typename = t.typename('User');
      id = t.id;
      name = t.string;
      meta = t.object({ x: t.number, owner: t.entity(Org) });
    }
    class GetSummary extends RESTQuery {
      path = '/summary';
      result = { user: t.entity(UserSummary) };
    }
    class GetFull extends RESTQuery {
      path = '/full';
      result = { user: t.entity(UserFull) };
    }
    mockFetch.get('/summary', { user: { __typename: 'User', id: 1, name: 'Alice', meta: { x: 1 } } });
    mockFetch.get('/full', {
      user: {
        __typename: 'User',
        id: 1,
        name: 'Alice',
        meta: { x: 1, owner: { __typename: 'Org', id: 7, name: 'ACME' } },
      },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const summary = snapshotHarness(client, () => fetchQuery(GetSummary));
      await summary.query;
      const full = snapshotHarness(client, () => fetchQuery(GetFull));
      await full.query;
      expect(summary.read().user.meta.owner.name).toBe('ACME');

      client.applyMutationEvent({ type: 'update', typename: 'Org', data: { id: 7, name: 'NEW' } });
      expect(summary.read().user.meta.owner.name).toBe('NEW');
      client.applyMutationEvent({ type: 'update', typename: 'Org', data: { id: 7, name: 'NEWER' } });
      expect(summary.read().user.meta.owner.name).toBe('NEWER');
      // Served by the fast path's own bookkeeping, not by the dev guard's re-read.
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('a reactive consumer of a narrowed entity array learns when a member becomes eligible', async () => {
    const { client, mockFetch } = getClient();
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
    mockFetch.get('/team', {
      team: {
        __typename: 'Team',
        id: 't-1',
        owner: { __typename: 'User', id: 'u-1', name: 'Alice' },
        members: [
          { __typename: 'User', id: 'u-1', name: 'Alice', email: 'a@x' },
          { __typename: 'User', id: 'u-2', name: 'Bob', email: 'b@x' },
        ],
      },
    });
    mockFetch.get('/user/u-1', { user: { __typename: 'User', id: 'u-1', name: 'Alice', email: 'a@x' } });

    await testWithClient(client, async () => {
      const team = fetchQuery(GetTeam);
      await team;
      const ids = watcher(() => (team.value as any).team.members.map((m: any) => m.id).join(','));
      ids.addListener(() => {});
      // u-1 was parsed with the preview def first, so it is narrowed out.
      expect(ids.value).toBe('u-2');

      await fetchQuery(GetUser, { id: 'u-1' });
      await sleep(5);
      expect(ids.value).toBe('u-1,u-2');
    });
  });

  it('query extras attached to a shared entity reach the query itself without re-running its other consumers', async () => {
    const { client, mockFetch } = getClient();
    class Profile extends Entity {
      __typename = t.typename('Profile');
      id = t.id;
      name = t.string;
    }
    class GetWrapped extends RESTQuery {
      path = '/wrapped';
      result = { profile: t.entity(Profile) };
    }
    class GetRoot extends RESTQuery {
      path = '/root';
      result = t.entity(Profile);
    }
    const profile = { __typename: 'Profile', id: 1, name: 'Alice' };
    mockFetch.get('/wrapped', { profile });
    mockFetch.get('/root', profile);
    mockFetch.get('/wrapped', { profile: { ...profile, name: 'Alicia' } });

    const wrapped = snapshotHarness(client, () => fetchQuery(GetWrapped));
    await wrapped.query;
    const before = wrapped.read();
    const computesBefore = wrapped.computes();
    expect('__refetch' in before.profile).toBe(false);

    // The entity-rooted query applies identical data. Its own consumer sees
    // the extras, but the wrapped query's consumer is not re-run for them.
    const root = snapshotHarness(client, () => fetchQuery(GetRoot));
    await root.query;
    await sleep(5);
    expect(typeof root.read().__refetch).toBe('function');
    expect(wrapped.read()).toBe(before);
    expect(wrapped.computes()).toBe(computesBefore);

    // Its next recompute (here, a change to the entity) picks them up.
    await (wrapped.query as any).value.__refetch();
    await sleep(5);
    expect(wrapped.read().profile.name).toBe('Alicia');
    expect(typeof wrapped.read().profile.__refetch).toBe('function');
  });

  it('a length-only consumer of a narrowed entity array does not recompute when a member it holds changes', async () => {
    const { client, mockFetch } = getClient();
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
      owner = t.entity(UserPreview);
      members = t.array(t.entity(UserFull));
    }
    class GetTeam extends RESTQuery {
      path = '/team';
      result = { team: t.entity(Team) };
    }
    mockFetch.get('/team', {
      team: {
        __typename: 'Team',
        id: 't-1',
        owner: { __typename: 'User', id: 'u-1', name: 'Alice' },
        members: [
          { __typename: 'User', id: 'u-1', name: 'Alice', email: 'a@x' },
          { __typename: 'User', id: 'u-2', name: 'Bob', email: 'b@x' },
        ],
      },
    });

    const team = holdQuery(client, () => fetchQuery(GetTeam));
    await team;
    let computes = 0;
    const count = withContexts([[QueryClientContext, client]], () => {
      const w = watcher(() => {
        computes++;
        return (team.value as any).team.members.length;
      });
      w.addListener(() => {});
      return w;
    });
    await sleep(5);
    expect(count.value).toBe(1);
    const base = computes;

    // A member the array holds changes a field the consumer never read.
    client.applyMutationEvent({ type: 'update', typename: 'User', data: { id: 'u-2', name: 'Robert' } });
    await sleep(5);
    expect((team.value as any).team.members[0].name).toBe('Robert');
    expect(count.value).toBe(1);
    expect(computes).toBe(base);

    // A member the array left out becomes eligible: that is a change of the array.
    client.applyMutationEvent({ type: 'update', typename: 'User', data: { id: 'u-1', email: 'alice@x' } });
    await sleep(5);
    expect(count.value).toBe(2);
    expect(computes).toBe(base + 1);
  });

  it('applies -0 over 0 and keeps NaN, at every level', async () => {
    const { client, mockFetch } = getClient();
    class Quote extends Entity {
      __typename = t.typename('Quote');
      id = t.id;
      price = t.number;
      history = t.array(t.number);
    }
    class GetQuote extends RESTQuery {
      path = '/quote';
      result = { quote: t.entity(Quote) };
    }
    mockFetch.get('/quote', { quote: { __typename: 'Quote', id: 'q', price: 0, history: [0, 1] } });
    const h = snapshotHarness(client, () => fetchQuery(GetQuote));
    await h.query;
    const before = h.computes();

    client.applyMutationEvent({ type: 'update', typename: 'Quote', data: { id: 'q', price: -0, history: [-0, 1] } });
    expect(Object.is((h.query.value as any).quote.price, -0)).toBe(true);
    expect(Object.is(h.read().quote.price, -0)).toBe(true);
    expect(Object.is(h.read().quote.history[0], -0)).toBe(true);
    expect(h.computes()).toBe(before + 1);

    // The same data again is not a change.
    client.applyMutationEvent({ type: 'update', typename: 'Quote', data: { id: 'q', price: -0, history: [-0, 1] } });
    expect(h.computes()).toBe(before + 1);
  });

  it('a snapshot handed back to the parser is read, not written to', async () => {
    const { client, mockFetch } = getClient();
    class Doc extends Entity {
      __typename = t.typename('Doc');
      id = t.id;
      title = t.string;
      meta = t.object({ views: t.number, tags: t.array(t.string) });
      extra = t.record(t.number);
    }
    class GetDoc extends RESTQuery {
      path = '/doc';
      result = { doc: t.entity(Doc) };
    }
    mockFetch.get('/doc', {
      doc: { __typename: 'Doc', id: 'd', title: 'T', meta: { views: 1, tags: ['a'] }, extra: { k: 1 } },
    });
    const h = snapshotHarness(client, () => fetchQuery(GetDoc));
    await h.query;
    const snap = h.read().doc;
    expect(Object.isFrozen(snap.meta)).toBe(true);
    const warn = vi.spyOn(client.getContext().log as { warn: (...args: unknown[]) => void }, 'warn');

    // An app forwards part of a snapshot as an event payload (or a mutation's
    // `effects.updates`); the parser must not write parsed values into it.
    client.applyMutationEvent({
      type: 'update',
      typename: 'Doc',
      data: { id: 'd', title: 'T2', meta: { ...snap.meta, views: 2 }, extra: snap.extra },
    });
    const meta = { views: 3, tags: snap.meta.tags };
    client.applyMutationEvent({ type: 'update', typename: 'Doc', data: { id: 'd', meta, extra: snap.extra } });

    expect(warn).not.toHaveBeenCalled();
    expect(h.read().doc.title).toBe('T2');
    expect(h.read().doc.meta.views).toBe(3);
    expect(h.read().doc.extra.k).toBe(1);
    expect(snap.meta.views).toBe(1);
    expect(Object.isFrozen(h.read().doc.meta)).toBe(true);
  });

  it('two events sharing one nested object do not alias entity data', async () => {
    const { client, mockFetch } = getClient();
    class Token extends Entity {
      __typename = t.typename('Token');
      id = t.id;
      walletId = t.string;
      metadata = t.object({ image: t.string });
    }
    class Wallet extends Entity {
      __typename = t.typename('Wallet');
      id = t.id;
      tokens = t.liveArray(Token, { constraints: { walletId: (this as any).id } });
    }
    class GetWallet extends RESTQuery {
      path = '/wallet';
      result = { wallet: t.entity(Wallet) };
    }
    mockFetch.get('/wallet', { wallet: { __typename: 'Wallet', id: 'w', tokens: [] } });
    const h = snapshotHarness(client, () => fetchQuery(GetWallet));
    await h.query;
    await sleep(5);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const shared = { image: 'shared.png' };
      client.applyMutationEvent({
        type: 'create',
        typename: 'Token',
        data: { __typename: 'Token', id: 'tok-0', walletId: 'w', metadata: shared },
      });
      client.applyMutationEvent({
        type: 'create',
        typename: 'Token',
        data: { __typename: 'Token', id: 'tok-1', walletId: 'w', metadata: shared },
      });
      await sleep(5);
      const tokens = () => h.read().wallet.tokens;
      expect(tokens()).toHaveLength(2);
      const tok1 = tokens()[1];
      client.applyMutationEvent({
        type: 'update',
        typename: 'Token',
        data: { id: 'tok-0', metadata: { image: 'new.png' } },
      });
      await sleep(5);

      expect(tokens()[0].metadata.image).toBe('new.png');
      expect(tokens()[1].metadata.image).toBe('shared.png');
      expect(tokens()[1]).toBe(tok1);
      expect((h.query.value as any).wallet.tokens[1].metadata.image).toBe('shared.png');
      expect(shared.image).toBe('shared.png');
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  it('a Set-valued format with many object members is verified in linear time', async () => {
    const { client, mockFetch } = getClient();
    registerFormat(
      'id-set',
      Mask.STRING,
      (value: string) => new Set(value.split(',').map(id => ({ id: Number(id) }))),
      (value: Set<{ id: number }>) => [...value].map(item => item.id).join(','),
    );
    class Roster extends Entity {
      __typename = t.typename('Roster');
      id = t.id;
      label = t.string;
      members = t.format('id-set' as never);
    }
    class GetRoster extends RESTQuery {
      path = '/roster';
      result = { roster: t.entity(Roster), other: t.entity(Roster) };
    }
    const ids = Array.from({ length: 3000 }, (_, i) => i).join(',');
    mockFetch.get('/roster', {
      roster: { __typename: 'Roster', id: 'r', label: 'a', members: ids },
      other: { __typename: 'Roster', id: 'o', label: 'b', members: '0' },
    });
    const h = snapshotHarness(client, () => fetchQuery(GetRoster));
    await h.query;
    expect(h.read().roster.members.size).toBe(3000);

    // Each event recomputes the snapshot at an unchanged version of `roster`,
    // so the dev guard compares the rebuilt Set with the previous one.
    const started = performance.now();
    for (let i = 0; i < 20; i++) {
      client.applyMutationEvent({ type: 'update', typename: 'Roster', data: { id: 'o', label: `b${i}` } });
      expect(h.read().roster.members.size).toBe(3000);
    }
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
