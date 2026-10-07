import { describe, it, expect, vi, afterEach } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { hashValue } from 'signalium/utils';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { fetchQuery } from '../query.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { AsyncQueryStore, type AsyncPersistentStore } from '../stores/async.js';
import { valueKeyFor, refCountKeyFor, refIdsKeyFor, queueKeyFor, updatedAtKeyFor } from '../stores/shared.js';
import { createMockFetch, setupTestClient, sleep } from './utils.js';

/**
 * What a streamed event leaves in the store: which records are written, which
 * are not, and whether every reference on disk points at a record that exists.
 * Complements `skip-write-and-snapshot-fixes.test.ts`.
 */

function getDoc(kv: MemoryPersistentStore, key: number): Record<string, unknown> | undefined {
  const value = kv.getString(valueKeyFor(key));
  return value ? (JSON.parse(value) as Record<string, unknown>) : undefined;
}
function refIds(kv: MemoryPersistentStore, key: number): number[] {
  return Array.from(kv.getBuffer(refIdsKeyFor(key)) ?? []);
}

/**
 * Every record must be referenced (a refcount) unless it is a query, and every
 * reference must point at a record that exists.
 */
function audit(kv: MemoryPersistentStore): { orphans: number[]; dangling: string[] } {
  const ids = new Set<number>();
  for (const k of kv.getAllKeys()) {
    const m = /^sq:doc:(value|refCount|refIds|updatedAt):(\d+)$/.exec(k);
    if (m) ids.add(Number(m[2]));
  }
  const orphans: number[] = [];
  const dangling: string[] = [];
  for (const id of ids) {
    const hasValue = kv.getString(valueKeyFor(id)) !== undefined;
    const isQuery = kv.getNumber(updatedAtKeyFor(id)) !== undefined;
    if (hasValue && !isQuery && kv.getNumber(refCountKeyFor(id)) === undefined) orphans.push(id);
    for (const ref of kv.getBuffer(refIdsKeyFor(id)) ?? []) {
      if (kv.getString(valueKeyFor(ref)) === undefined) dangling.push(`${id} -> ${ref}`);
    }
  }
  return { orphans, dangling };
}

function holdQuery<T>(client: QueryClient, start: () => T): T {
  return withContexts([[QueryClientContext, client]], () => {
    const query = start();
    const w = watcher(() => (query as unknown as { value: unknown }).value);
    w.addListener(() => {});
    return query;
  });
}

const K = (typename: string, id: string | number) => hashValue([typename, id]);

/** The keys of every entity write, whichever store method carried it. */
function spyWrites(store: SyncQueryStore): () => number[] {
  const saves = vi.spyOn(store, 'saveEntity');
  const merges = vi.spyOn(store, 'mergeEntity');
  return () => [...saves.mock.calls.map(c => c[0]), ...merges.mock.calls.map(c => c[0])];
}

/** Makes every write of the given key throw, whichever store method carries it. */
function failWritesOf(store: SyncQueryStore, key: number, shouldFail: () => boolean = () => true): void {
  const save = store.saveEntity.bind(store);
  const merge = store.mergeEntity.bind(store);
  vi.spyOn(store, 'saveEntity').mockImplementation((k, value, refs) => {
    if (shouldFail() && k === key) throw new Error('quota exceeded');
    save(k, value, refs);
  });
  vi.spyOn(store, 'mergeEntity').mockImplementation((k, fields, refs) => {
    if (shouldFail() && k === key) throw new Error('quota exceeded');
    merge(k, fields, refs);
  });
}

// ======================================================
// Which records an event writes
// ======================================================

describe('records a streamed event writes', () => {
  class Badge extends Entity {
    __typename = t.typename('Badge');
    id = t.id;
    label = t.string;
  }
  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
    karma = t.number;
    badge = t.optional(t.entity(Badge));
  }
  class Comment extends Entity {
    __typename = t.typename('Comment');
    id = t.id;
    postId = t.string;
    body = t.string;
    author = t.entity(User);
    mentions = t.optional(t.array(t.entity(User)));
  }
  class Post extends Entity {
    __typename = t.typename('Post');
    id = t.id;
    title = t.string;
    comments = t.liveArray(Comment, { constraints: { postId: (this as any).id } });
    commentCount = t.liveValue(t.number, Comment, {
      constraints: { postId: (this as any).id },
      onCreate: (count: number) => count + 1,
      onUpdate: (count: number) => count,
      onDelete: (count: number) => count - 1,
    });
  }
  class Thread extends Entity {
    __typename = t.typename('Thread');
    id = t.id;
    latest = t.liveValue(t.optional(t.string), Comment, {
      constraints: { postId: (this as any).id },
      onCreate: (_prev: string | undefined, comment: Comment) => comment.body,
      onUpdate: (prev: string | undefined) => prev,
      onDelete: (prev: string | undefined) => prev,
    });
  }
  class GetPost extends RESTQuery {
    params = { id: t.id };
    path = `/post/${this.params.id}`;
    result = { post: t.entity(Post) };
  }
  class GetThread extends RESTQuery {
    params = { id: t.id };
    path = `/thread/${this.params.id}`;
    result = { thread: t.entity(Thread) };
  }
  class GetUser extends RESTQuery {
    params = { id: t.id };
    path = `/user/${this.params.id}`;
    result = { user: t.entity(User) };
  }

  const getClient = setupTestClient();
  const newAuthor = () => ({
    __typename: 'User',
    id: 'u7',
    name: 'Newbie',
    karma: 1,
    badge: { __typename: 'Badge', id: 'b7', label: 'new' },
  });

  it('the same new entity twice in one payload is referenced, counted and written once', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments: [], commentCount: 0 } });
    const postQ = holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));
    await postQ;
    const writes = spyWrites(store);

    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c9', postId: 'p1', body: 'hi', author: newAuthor(), mentions: [newAuthor()] },
    });
    await sleep(5);

    const u7 = client.entityMap.getEntity(K('User', 'u7'))!;
    // The comment references u7 twice (author and mentions[0]) and u7 keeps its badge.
    expect(client.entityMap.getEntity(K('Comment', 'c9'))!.entityRefs!.get(u7)).toBe(2);
    expect([...u7.entityRefs!.keys()].map(e => e.key)).toEqual([K('Badge', 'b7')]);
    expect(writes().filter(k => k === K('User', 'u7'))).toHaveLength(1);
    expect(refIds(kv, K('User', 'u7'))).toEqual([K('Badge', 'b7')]);
    expect(getDoc(kv, K('Badge', 'b7'))).toMatchObject({ label: 'new' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
    expect((postQ.value as any).post.comments[0].mentions[0].badge.label).toBe('new');
  });

  it('the same entity twice in a fetched payload keeps its child references', async () => {
    const { client, mockFetch, kv } = getClient();
    class GetComments extends RESTQuery {
      path = '/comments';
      result = { comments: t.array(t.entity(Comment)) };
    }
    const author = () => ({
      __typename: 'User',
      id: 'u1',
      name: 'Alice',
      karma: 3,
      badge: { __typename: 'Badge', id: 'b1', label: 'gold' },
    });
    const payload = () => ({
      comments: [
        { __typename: 'Comment', id: 'c1', postId: 'p1', body: 'a', author: author() },
        { __typename: 'Comment', id: 'c2', postId: 'p1', body: 'b', author: author() },
      ],
    });
    mockFetch.get('/comments', payload());
    const q = holdQuery(client, () => fetchQuery(GetComments));
    await q;

    const u1 = client.entityMap.getEntity(K('User', 'u1'))!;
    expect(u1.refCount).toBe(2);
    expect([...u1.entityRefs!.keys()].map(e => e.key)).toEqual([K('Badge', 'b1')]);
    expect(client.entityMap.getEntity(K('Badge', 'b1'))!.refCount).toBe(1);
    expect(refIds(kv, K('User', 'u1'))).toEqual([K('Badge', 'b1')]);
    expect(getDoc(kv, K('Badge', 'b1'))).toMatchObject({ label: 'gold' });
    expect((q.value as any).comments.map((c: any) => c.author.badge.label)).toEqual(['gold', 'gold']);

    // A refetch with the same payload changes nothing.
    mockFetch.get('/comments', payload());
    await (q.value as any).__refetch();
    expect(u1.refCount).toBe(2);
    expect(client.entityMap.getEntity(K('Badge', 'b1'))!.refCount).toBe(1);
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('a create matched only by a liveValue reducer writes nothing, so no orphan record is left', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/thread/p1', { thread: { __typename: 'Thread', id: 'p1', latest: null } });
    const threadQ = holdQuery(client, () => fetchQuery(GetThread, { id: 'p1' }));
    await threadQ;
    const writes = spyWrites(store);

    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c9', postId: 'p1', body: 'newest', author: newAuthor() },
    });
    await sleep(5);

    expect((threadQ.value as any).thread.latest).toBe('newest');
    expect(writes()).toEqual([]);
    expect(getDoc(kv, K('User', 'u7'))).toBeUndefined();
    expect(getDoc(kv, K('Badge', 'b7'))).toBeUndefined();
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('a partial update for an entity on disk but not in memory merges into its record', async () => {
    const { client, mockFetch, kv } = getClient();
    mockFetch.get('/user/u1', {
      user: {
        __typename: 'User',
        id: 'u1',
        name: 'Alice',
        karma: 10,
        badge: { __typename: 'Badge', id: 'b1', label: 'gold' },
      },
    });
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u1' }));
    client.entityMap.getEntity(K('User', 'u1'))!.evict();
    expect(client.entityMap.getEntity(K('User', 'u1'))).toBeUndefined();

    // The payload carries the required fields (an event for an entity that is
    // not in memory is parsed as a full record) but not the optional badge.
    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u1', name: 'Alicia', karma: 10 },
    });
    await sleep(5);

    // The badge reference the event did not carry survives.
    expect(getDoc(kv, K('User', 'u1'))).toMatchObject({ name: 'Alicia', karma: 10 });
    expect(refIds(kv, K('User', 'u1'))).toEqual([K('Badge', 'b1')]);
    expect(getDoc(kv, K('Badge', 'b1'))).toMatchObject({ label: 'gold' });
    expect(kv.getNumber(refCountKeyFor(K('Badge', 'b1')))).toBe(1);
    expect(client.entityMap.getEntity(K('User', 'u1'))).toBeUndefined();

    // A replaced child is written and the old one released.
    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: {
        __typename: 'User',
        id: 'u1',
        name: 'Alicia',
        karma: 10,
        badge: { __typename: 'Badge', id: 'b9', label: 'platinum' },
      },
    });
    await sleep(5);
    expect(getDoc(kv, K('User', 'u1'))).toMatchObject({ name: 'Alicia', karma: 10 });
    expect(refIds(kv, K('User', 'u1'))).toEqual([K('Badge', 'b9')]);
    expect(getDoc(kv, K('Badge', 'b9'))).toMatchObject({ label: 'platinum' });
    expect(getDoc(kv, K('Badge', 'b1'))).toBeUndefined();
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });

    // The next session hydrates the merged record.
    client.destroy();
    const warn = vi.fn();
    const second = new QueryClient({
      store: new SyncQueryStore(kv),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn, error: () => {} },
    } as never);
    mockFetch.get('/user/u1', { user: { __typename: 'User', id: 'u1', name: 'FRESH', karma: 0 } }, { delay: 5000 });
    const q = holdQuery(second, () => fetchQuery(GetUser, { id: 'u1' }));
    await sleep(10);
    expect((q.value as any).user.name).toBe('Alicia');
    expect((q.value as any).user.karma).toBe(10);
    expect((q.value as any).user.badge.label).toBe('platinum');
    expect(warn).not.toHaveBeenCalled();
    second.destroy();
  });

  it('a store write that fails after routing is reverted, and the failure is logged rather than thrown', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments: [], commentCount: 0 } });
    const postQ = holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));
    await postQ;
    const warn = vi
      .spyOn(client.getContext().log as { warn: (...args: unknown[]) => void }, 'warn')
      .mockImplementation(() => {});
    failWritesOf(store, K('Comment', 'c9'));

    expect(() =>
      client.applyMutationEvent({
        type: 'create',
        typename: 'Comment',
        data: { __typename: 'Comment', id: 'c9', postId: 'p1', body: 'hi', author: newAuthor() },
      }),
    ).not.toThrow();
    await sleep(5);

    expect(warn).toHaveBeenCalledWith('Failed to apply mutation event', expect.any(Error));
    // Memory and the store agree: the comment is in neither, and no record
    // references it. The author written before the failing write stays behind
    // unreferenced, as with any write that fails mid-walk.
    expect((postQ.value as any).post.comments).toEqual([]);
    expect((postQ.value as any).post.commentCount).toBe(0);
    expect(client.entityMap.getEntity(K('Comment', 'c9'))).toBeUndefined();
    expect(refIds(kv, K('Post', 'p1'))).toEqual([]);
    expect(getDoc(kv, K('Comment', 'c9'))).toBeUndefined();
    expect(audit(kv).dangling).toEqual([]);
  });

  it('a store write that fails for an unrouted root does not leak the root', async () => {
    const { client, mockFetch, store } = getClient();
    mockFetch.get('/user/u1', { user: { __typename: 'User', id: 'u1', name: 'Alice', karma: 10 } });
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u1' }));
    client.entityMap.getEntity(K('User', 'u1'))!.evict();
    const warn = vi
      .spyOn(client.getContext().log as { warn: (...args: unknown[]) => void }, 'warn')
      .mockImplementation(() => {});
    failWritesOf(store, K('User', 'u1'));

    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u1', name: 'Alicia', karma: 10 },
    });
    await sleep(5);

    expect(warn).toHaveBeenCalledWith('Failed to apply mutation event', expect.any(Error));
    expect(client.entityMap.getEntity(K('User', 'u1'))).toBeUndefined();
  });

  it('a failed create delivered again is routed once: the array and the reducer agree', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments: [], commentCount: 0 } });
    const postQ = holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));
    await postQ;
    vi.spyOn(client.getContext().log as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => {});
    let fail = true;
    failWritesOf(store, K('Comment', 'c9'), () => fail);
    const event = () => ({
      type: 'create' as const,
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c9', postId: 'p1', body: 'hi', author: newAuthor() },
    });

    client.applyMutationEvent(event());
    await sleep(5);
    expect((postQ.value as any).post.comments).toEqual([]);
    expect((postQ.value as any).post.commentCount).toBe(0);

    // The transport retries once the store works again.
    fail = false;
    client.applyMutationEvent(event());
    await sleep(5);
    expect((postQ.value as any).post.comments.map((c: any) => c.id)).toEqual(['c9']);
    expect((postQ.value as any).post.commentCount).toBe(1);
    expect(getDoc(kv, K('Comment', 'c9'))).toMatchObject({ body: 'hi' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('an update matched only by a liveValue reducer refreshes the record of an entity on disk but not in memory', async () => {
    const { client, mockFetch, kv } = getClient();
    class GetComments extends RESTQuery {
      path = '/comments';
      result = { comments: t.array(t.entity(Comment)) };
    }
    mockFetch.get('/thread/p1', { thread: { __typename: 'Thread', id: 'p1', latest: null } });
    mockFetch.get('/comments', {
      comments: [
        {
          __typename: 'Comment',
          id: 'c1',
          postId: 'p1',
          body: 'orig',
          author: { __typename: 'User', id: 'u1', name: 'Alice', karma: 1 },
        },
      ],
    });
    const threadQ = holdQuery(client, () => fetchQuery(GetThread, { id: 'p1' }));
    await threadQ;
    await holdQuery(client, () => fetchQuery(GetComments));
    // The comments query is collected from memory; its record stays on disk.
    client.entityMap.getEntity(K('Comment', 'c1'))!.evict();

    client.applyMutationEvent({
      type: 'update',
      typename: 'Comment',
      data: {
        __typename: 'Comment',
        id: 'c1',
        postId: 'p1',
        body: 'edited',
        author: { __typename: 'User', id: 'u1', name: 'Alice', karma: 1 },
      },
    });
    await sleep(5);

    expect((threadQ.value as any).thread.latest).toBeUndefined();
    expect(getDoc(kv, K('Comment', 'c1'))).toMatchObject({ body: 'edited' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('a create adopted by an existing entity in its own payload is kept and written, even when nothing routes it', async () => {
    const { client, mockFetch, kv } = getClient();
    class Note extends Entity {
      __typename = t.typename('Note');
      id = t.id;
      body = t.string;
      article = t.optional(t.entity(ArticleRef));
    }
    class NoteRef extends Entity {
      __typename = t.typename('Note');
      id = t.id;
      body = t.string;
    }
    class ArticleRef extends Entity {
      __typename = t.typename('Article');
      id = t.id;
      latestNote = t.optional(t.entity(NoteRef));
    }
    class Article extends Entity {
      __typename = t.typename('Article');
      id = t.id;
      title = t.string;
      latestNote = t.optional(t.entity(NoteRef));
      notes = t.array(t.entity(Note));
    }
    class GetArticle extends RESTQuery {
      params = { id: t.id };
      path = `/article/${this.params.id}`;
      result = { article: t.entity(Article) };
    }
    mockFetch.get('/article/a1', {
      article: {
        __typename: 'Article',
        id: 'a1',
        title: 'A',
        notes: [{ __typename: 'Note', id: 'n1', body: 'first' }],
      },
    });
    const artQ = holdQuery(client, () => fetchQuery(GetArticle, { id: 'a1' }));
    await artQ;

    // No live collection routes notes; the payload's article points back at the note.
    client.applyMutationEvent({
      type: 'create',
      typename: 'Note',
      data: {
        __typename: 'Note',
        id: 'n9',
        body: 'hi',
        article: { __typename: 'Article', id: 'a1', latestNote: { __typename: 'Note', id: 'n9', body: 'hi' } },
      },
    });
    await sleep(5);

    const n9 = client.entityMap.getEntity(K('Note', 'n9'))!;
    expect(n9).toBeDefined();
    expect(n9.refCount).toBe(1);
    expect((artQ.value as any).article.latestNote.body).toBe('hi');
    expect(refIds(kv, K('Article', 'a1')).sort()).toEqual([K('Note', 'n1'), K('Note', 'n9')].sort());
    expect(getDoc(kv, K('Note', 'n9'))).toMatchObject({ body: 'hi' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });

    // A later event for the note reaches the article's consumer.
    client.applyMutationEvent({ type: 'update', typename: 'Note', data: { id: 'n9', body: 'edited' } });
    expect((artQ.value as any).article.latestNote.body).toBe('edited');
    expect(getDoc(kv, K('Note', 'n9'))).toMatchObject({ body: 'edited' });

    client.destroy();
    const second = new QueryClient({
      store: new SyncQueryStore(kv),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn: () => {}, error: () => {} },
    } as never);
    mockFetch.get(
      '/article/a1',
      { article: { __typename: 'Article', id: 'a1', title: 'FRESH', notes: [] } },
      { delay: 5000 },
    );
    const q = holdQuery(second, () => fetchQuery(GetArticle, { id: 'a1' }));
    await sleep(10);
    expect((q.value as any).article.latestNote.body).toBe('edited');
    second.destroy();
  });

  it('created entities that only reference each other are evicted with the unrouted root', async () => {
    const { client, mockFetch, kv } = getClient();
    class Author extends Entity {
      __typename = t.typename('User');
      id = t.id;
      name = t.string;
      karma = t.number;
      bestComment = t.optional(t.entity(CommentRef));
    }
    class CommentRef extends Entity {
      __typename = t.typename('Comment');
      id = t.id;
      body = t.string;
    }
    class Remark extends Entity {
      __typename = t.typename('Comment');
      id = t.id;
      postId = t.string;
      body = t.string;
      author = t.entity(Author);
    }
    class GetRemark extends RESTQuery {
      params = { id: t.id };
      path = `/remark/${this.params.id}`;
      result = { remark: t.entity(Remark) };
    }
    mockFetch.get('/remark/c0', {
      remark: {
        __typename: 'Comment',
        id: 'c0',
        postId: 'p0',
        body: 'seed',
        author: { __typename: 'User', id: 'u0', name: 'Zero', karma: 0 },
      },
    });
    await holdQuery(client, () => fetchQuery(GetRemark, { id: 'c0' }));

    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: {
        __typename: 'Comment',
        id: 'c9',
        postId: 'nowhere',
        body: 'hi',
        author: {
          __typename: 'User',
          id: 'u7',
          name: 'Newbie',
          karma: 1,
          bestComment: { __typename: 'Comment', id: 'c9', body: 'hi' },
        },
      },
    });
    await sleep(5);

    expect(client.entityMap.getEntity(K('Comment', 'c9'))).toBeUndefined();
    expect(client.entityMap.getEntity(K('User', 'u7'))).toBeUndefined();
    expect(getDoc(kv, K('Comment', 'c9'))).toBeUndefined();
    expect(getDoc(kv, K('User', 'u7'))).toBeUndefined();
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('a root write that fails while an existing entity adopted the root leaves no dangling reference', async () => {
    const { client, mockFetch, kv, store } = getClient();
    class PostRef extends Entity {
      __typename = t.typename('Post');
      id = t.id;
      latestComment = t.optional(t.entity(CommentRef));
    }
    class CommentRef extends Entity {
      __typename = t.typename('Comment');
      id = t.id;
      body = t.string;
    }
    class Reply extends Entity {
      __typename = t.typename('Comment');
      id = t.id;
      postId = t.string;
      body = t.string;
      author = t.entity(User);
      post = t.optional(t.entity(PostRef));
    }
    class Topic extends Entity {
      __typename = t.typename('Post');
      id = t.id;
      title = t.string;
      latestComment = t.optional(t.entity(CommentRef));
      replies = t.liveArray(Reply, { constraints: { postId: (this as any).id } });
    }
    class GetTopic extends RESTQuery {
      params = { id: t.id };
      path = `/topic/${this.params.id}`;
      result = { topic: t.entity(Topic) };
    }
    mockFetch.get('/topic/t1', { topic: { __typename: 'Post', id: 't1', title: 'T', replies: [] } });
    const topicQ = holdQuery(client, () => fetchQuery(GetTopic, { id: 't1' }));
    await topicQ;
    vi.spyOn(client.getContext().log as { warn: (...args: unknown[]) => void }, 'warn').mockImplementation(() => {});
    failWritesOf(store, K('Comment', 'c9'));

    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: {
        __typename: 'Comment',
        id: 'c9',
        postId: 't1',
        body: 'hi',
        author: newAuthor(),
        post: { __typename: 'Post', id: 't1', latestComment: { __typename: 'Comment', id: 'c9', body: 'hi' } },
      },
    });
    await sleep(5);

    // The topic's record was not written with a reference to a record that
    // does not exist; memory holds the adoption and the next write heals it.
    expect(audit(kv).dangling).toEqual([]);
    expect((topicQ.value as any).topic.replies).toEqual([]);
    expect((topicQ.value as any).topic.latestComment.body).toBe('hi');
    expect(refIds(kv, K('Post', 't1'))).toEqual([]);
  });

  it('a payload that links back to its parent is applied, persisted and hydrated', async () => {
    const { client, mockFetch, kv } = getClient();
    class Folder extends Entity {
      __typename = t.typename('Folder');
      id = t.id;
      name = t.string;
      files = t.array(t.entity(File));
    }
    class FolderRef extends Entity {
      __typename = t.typename('Folder');
      id = t.id;
      name = t.string;
    }
    class File extends Entity {
      __typename = t.typename('File');
      id = t.id;
      name = t.string;
      folder = t.entity(FolderRef);
    }
    class GetFolder extends RESTQuery {
      params = { id: t.id };
      path = `/folder/${this.params.id}`;
      result = { folder: t.entity(Folder) };
    }
    mockFetch.get('/folder/f1', {
      folder: {
        __typename: 'Folder',
        id: 'f1',
        name: 'root',
        files: [
          { __typename: 'File', id: 'x1', name: 'a.txt', folder: { __typename: 'Folder', id: 'f1', name: 'root' } },
        ],
      },
    });
    const q = holdQuery(client, () => fetchQuery(GetFolder, { id: 'f1' }));
    await q;
    expect((q.value as any).folder.files[0].folder.name).toBe('root');
    expect(refIds(kv, K('Folder', 'f1'))).toEqual([K('File', 'x1')]);
    expect(refIds(kv, K('File', 'x1'))).toEqual([K('Folder', 'f1')]);

    client.destroy();
    const warn = vi.fn();
    const second = new QueryClient({
      store: new SyncQueryStore(kv),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn, error: () => {} },
    } as never);
    mockFetch.get(
      '/folder/f1',
      { folder: { __typename: 'Folder', id: 'f1', name: 'FRESH', files: [] } },
      { delay: 5000 },
    );
    const q2 = holdQuery(second, () => fetchQuery(GetFolder, { id: 'f1' }));
    await sleep(10);
    expect(warn).not.toHaveBeenCalled();
    expect((q2.value as any).folder.files.map((f: any) => f.folder.name)).toEqual(['root']);
    second.destroy();
  });

  it('merging keeps the fields an event did not carry, including a parse result, and merges created descendants too', async () => {
    const { client, mockFetch, kv } = getClient();
    class Icon extends Entity {
      __typename = t.typename('Icon');
      id = t.id;
      url = t.string;
    }
    class Award extends Entity {
      __typename = t.typename('Badge');
      id = t.id;
      label = t.string;
      icon = t.optional(t.entity(Icon));
    }
    class Profile extends Entity {
      __typename = t.typename('Profile');
      id = t.id;
      name = t.string;
      bio = t.optional(t.string);
      badge = t.optional(t.entity(Award));
      parsed = t.optional(t.result(t.entity(Award)));
    }
    class GetProfile extends RESTQuery {
      params = { id: t.id };
      path = `/profile/${this.params.id}`;
      result = { profile: t.entity(Profile) };
    }
    mockFetch.get('/profile/pr1', {
      profile: {
        __typename: 'Profile',
        id: 'pr1',
        name: 'Alice',
        bio: 'hello',
        badge: {
          __typename: 'Badge',
          id: 'b1',
          label: 'gold',
          icon: { __typename: 'Icon', id: 'i1', url: '/gold.png' },
        },
        parsed: { __typename: 'Badge', id: 'b5', label: 'parsed' },
      },
    });
    await holdQuery(client, () => fetchQuery(GetProfile, { id: 'pr1' }));
    for (const key of ['pr1']) client.entityMap.getEntity(K('Profile', key))!.evict();
    client.entityMap.getEntity(K('Badge', 'b1'))?.evict();
    client.entityMap.getEntity(K('Icon', 'i1'))?.evict();

    // The badge under the event is a created entity with a record on disk:
    // its own merge keeps the icon the event did not mention.
    client.applyMutationEvent({
      type: 'update',
      typename: 'Profile',
      data: {
        __typename: 'Profile',
        id: 'pr1',
        name: 'Alicia',
        badge: { __typename: 'Badge', id: 'b1', label: 'gold+' },
      },
    });
    await sleep(5);

    const doc = getDoc(kv, K('Profile', 'pr1'))!;
    expect(doc).toMatchObject({ name: 'Alicia', bio: 'hello' });
    expect(doc.parsed).toEqual({ success: true, value: { __entityRef: K('Badge', 'b5') } });
    expect(getDoc(kv, K('Badge', 'b1'))).toMatchObject({ label: 'gold+', icon: { __entityRef: K('Icon', 'i1') } });
    expect(refIds(kv, K('Badge', 'b1'))).toEqual([K('Icon', 'i1')]);
    expect(getDoc(kv, K('Icon', 'i1'))).toMatchObject({ url: '/gold.png' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('a write after a cold start does not rewrite the hydrated entities under it', async () => {
    const { client, mockFetch, kv } = getClient();
    const comments = Array.from({ length: 5 }, (_, i) => ({
      __typename: 'Comment',
      id: `c${i}`,
      postId: 'p1',
      body: `b${i}`,
      author: {
        __typename: 'User',
        id: `u${i}`,
        name: `n${i}`,
        karma: i,
        badge: { __typename: 'Badge', id: `b${i}`, label: `l${i}` },
      },
    }));
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments, commentCount: 5 } });
    await holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));
    client.destroy();

    const store = new SyncQueryStore(kv);
    const second = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn: () => {}, error: () => {} },
    } as never);
    mockFetch.get(
      '/post/p1',
      { post: { __typename: 'Post', id: 'p1', title: 'FRESH', comments: [], commentCount: 0 } },
      { delay: 5000 },
    );
    const q = holdQuery(second, () => fetchQuery(GetPost, { id: 'p1' }));
    await sleep(10);
    expect((q.value as any).post.comments).toHaveLength(5);
    const writes = spyWrites(store);

    second.applyMutationEvent({ type: 'update', typename: 'Post', data: { id: 'p1', title: 'T2' } });
    await sleep(5);
    expect(writes()).toEqual([K('Post', 'p1')]);
    expect(getDoc(kv, K('Post', 'p1'))).toMatchObject({ title: 'T2' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
    second.destroy();
  });

  it('a member routed into the live array of an entity built from events reaches its record', async () => {
    const { client, mockFetch, kv } = getClient();
    // A second class for Post without the live fields makes them optional in
    // the merged definition, so an event for a post can omit them.
    class PostPreview extends Entity {
      __typename = t.typename('Post');
      id = t.id;
      title = t.string;
      blogId = t.optional(t.string);
    }
    class Blog extends Entity {
      __typename = t.typename('Blog');
      id = t.id;
      posts = t.liveArray(PostPreview, { constraints: { blogId: (this as any).id } });
    }
    class GetBlog extends RESTQuery {
      params = { id: t.id };
      path = `/blog/${this.params.id}`;
      result = { blog: t.entity(Blog) };
    }
    mockFetch.get('/post/p9', {
      post: {
        __typename: 'Post',
        id: 'p9',
        title: 'T',
        comments: [
          {
            __typename: 'Comment',
            id: 'c1',
            postId: 'p9',
            body: 'first',
            author: { __typename: 'User', id: 'u1', name: 'A', karma: 1 },
          },
        ],
        commentCount: 1,
      },
    });
    mockFetch.get('/blog/b1', { blog: { __typename: 'Blog', id: 'b1', posts: [] } });
    const postQ = holdQuery(client, () => fetchQuery(GetPost, { id: 'p9' }));
    await postQ;
    const blogQ = holdQuery(client, () => fetchQuery(GetBlog, { id: 'b1' }));
    await blogQ;
    expect(refIds(kv, K('Post', 'p9'))).toEqual([K('Comment', 'c1')]);
    // The post is collected from memory; its record stays on disk.
    client.entityMap.getEntity(K('Post', 'p9'))!.evict();

    // An event brings the post back into memory, retained by the blog's live
    // array and built from the event alone: no comments, no count.
    client.applyMutationEvent({
      type: 'update',
      typename: 'Post',
      data: { __typename: 'Post', id: 'p9', title: 'T2', blogId: 'b1', commentCount: 1 },
    });
    await sleep(5);
    expect((blogQ.value as any).blog.posts.map((p: any) => p.title)).toEqual(['T2']);
    const p9 = client.entityMap.getEntity(K('Post', 'p9'))!;
    expect(p9._partial).toBe(true);
    expect(getDoc(kv, K('Post', 'p9'))).toMatchObject({ title: 'T2', comments: [{ __entityRef: K('Comment', 'c1') }] });

    // A comment routed into its (empty in memory) live array reaches the record.
    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c9', postId: 'p9', body: 'second', author: newAuthor() },
    });
    await sleep(5);
    expect(getDoc(kv, K('Post', 'p9'))).toMatchObject({ title: 'T2', comments: [{ __entityRef: K('Comment', 'c9') }] });
    expect(refIds(kv, K('Post', 'p9'))).toEqual([K('Comment', 'c9')]);
    expect(getDoc(kv, K('Comment', 'c9'))).toMatchObject({ body: 'second' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('an unrouted root that references itself is evicted', async () => {
    const { client, mockFetch, kv } = getClient();
    class MessageRef extends Entity {
      __typename = t.typename('Message');
      id = t.id;
      body = t.string;
    }
    class Message extends Entity {
      __typename = t.typename('Message');
      id = t.id;
      roomId = t.string;
      body = t.string;
      threadRoot = t.optional(t.entity(MessageRef));
    }
    class Room extends Entity {
      __typename = t.typename('Room');
      id = t.id;
      messages = t.liveArray(Message, { constraints: { roomId: (this as any).id } });
    }
    class GetRoom extends RESTQuery {
      params = { id: t.id };
      path = `/room/${this.params.id}`;
      result = { room: t.entity(Room) };
    }
    mockFetch.get('/room/r1', { room: { __typename: 'Room', id: 'r1', messages: [] } });
    await holdQuery(client, () => fetchQuery(GetRoom, { id: 'r1' }));

    client.applyMutationEvent({
      type: 'create',
      typename: 'Message',
      data: {
        __typename: 'Message',
        id: 'm9',
        roomId: 'OTHER',
        body: 'hi',
        threadRoot: { __typename: 'Message', id: 'm9', body: 'hi' },
      },
    });
    await sleep(5);
    expect(client.entityMap.getEntity(K('Message', 'm9'))).toBeUndefined();
    expect(getDoc(kv, K('Message', 'm9'))).toBeUndefined();
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('an entity an event creates under a root in memory merges over its record too', async () => {
    const { client, mockFetch, kv } = getClient();
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments: [], commentCount: 0 } });
    mockFetch.get('/user/u7', { user: { ...newAuthor(), name: 'Old' } });
    const postQ = holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));
    await postQ;
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u7' }));
    // The author's record is on disk with its badge; the author is collected from memory.
    client.entityMap.getEntity(K('User', 'u7'))!.evict();
    client.entityMap.getEntity(K('Badge', 'b7'))?.evict();

    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: {
        __typename: 'Comment',
        id: 'c9',
        postId: 'p1',
        body: 'hi',
        author: { __typename: 'User', id: 'u7', name: 'Newbie', karma: 2 },
      },
    });
    await sleep(5);
    expect((postQ.value as any).post.comments.map((c: any) => c.author.name)).toEqual(['Newbie']);
    // The event did not mention the badge: the record keeps it.
    expect(getDoc(kv, K('User', 'u7'))).toMatchObject({
      name: 'Newbie',
      karma: 2,
      badge: { __entityRef: K('Badge', 'b7') },
    });
    expect(getDoc(kv, K('Badge', 'b7'))).toMatchObject({ label: 'new' });
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });
});

// ======================================================
// Entities with an in-memory gcTime linger after release
// ======================================================

describe('records a streamed event writes when released entities linger (gcTime)', () => {
  class Badge extends Entity {
    static cache = { gcTime: 1 };
    __typename = t.typename('Badge');
    id = t.id;
    label = t.string;
  }
  class User extends Entity {
    static cache = { gcTime: 1 };
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
    badge = t.optional(t.entity(Badge));
  }
  class Comment extends Entity {
    static cache = { gcTime: 1 };
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
  const getClient = setupTestClient({ evictionMultiplier: 0.001 });
  const newAuthor = () => ({
    __typename: 'User',
    id: 'u7',
    name: 'Newbie',
    badge: { __typename: 'Badge', id: 'b7', label: 'new' },
  });

  it('an unrouted create evicts everything it created at once, gcTime or not, and writes none of it', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments: [] } });
    const postQ = holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));
    await postQ;
    const writes = spyWrites(store);

    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c9', postId: 'OTHER', body: 'x', author: newAuthor() },
    });
    await sleep(5);

    // Nothing references what the event created. Had the author lingered
    // until its gcTime, a later event could have written it as an orphan.
    expect(client.entityMap.getEntity(K('Comment', 'c9'))).toBeUndefined();
    expect(client.entityMap.getEntity(K('User', 'u7'))).toBeUndefined();
    expect(client.entityMap.getEntity(K('Badge', 'b7'))).toBeUndefined();
    expect(writes()).toEqual([]);
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });

    // A second unrouted event for the same author still writes nothing.
    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c9b', postId: 'OTHER', body: 'x', author: newAuthor() },
    });
    await sleep(5);
    expect(writes()).toEqual([]);
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });

    // A routed create with the same author writes it, with its badge.
    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c10', postId: 'p1', body: 'y', author: newAuthor() },
    });
    await sleep(5);
    expect((postQ.value as any).post.comments.map((c: any) => c.author.badge.label)).toEqual(['new']);
    expect(getDoc(kv, K('Comment', 'c10'))).toMatchObject({ body: 'y' });
    expect(getDoc(kv, K('User', 'u7'))).toMatchObject({ name: 'Newbie' });
    expect(getDoc(kv, K('Badge', 'b7'))).toMatchObject({ label: 'new' });
    expect(refIds(kv, K('User', 'u7'))).toEqual([K('Badge', 'b7')]);
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });

    // GC time passes; the entities are retained and survive.
    await sleep(300);
    expect(client.entityMap.getEntity(K('User', 'u7'))).toBeDefined();
    expect(client.entityMap.getEntity(K('Badge', 'b7'))).toBeDefined();
  });

  it('an unrouted create followed by GC leaves nothing in memory or on disk', async () => {
    const { client, mockFetch, kv } = getClient();
    mockFetch.get('/post/p1', { post: { __typename: 'Post', id: 'p1', title: 'T', comments: [] } });
    await holdQuery(client, () => fetchQuery(GetPost, { id: 'p1' }));

    client.applyMutationEvent({
      type: 'create',
      typename: 'Comment',
      data: { __typename: 'Comment', id: 'c9', postId: 'OTHER', body: 'x', author: newAuthor() },
    });
    await sleep(300);

    expect(client.entityMap.getEntity(K('User', 'u7'))).toBeUndefined();
    expect(client.entityMap.getEntity(K('Badge', 'b7'))).toBeUndefined();
    expect(getDoc(kv, K('User', 'u7'))).toBeUndefined();
    expect(getDoc(kv, K('Badge', 'b7'))).toBeUndefined();
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });
});

// ======================================================
// AsyncQueryStore writer
// ======================================================

class AsyncDelegate implements AsyncPersistentStore {
  kv: Record<string, unknown> = {};
  constructor(public delayMs: number = 1) {}
  private tick() {
    return new Promise<void>(resolve => setTimeout(resolve, this.delayMs));
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

/** Waits for the writer's read of the keys it holds. */
async function scanned(store: AsyncQueryStore): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (store.hasEntity!(0) !== undefined) return;
    await sleep(2);
  }
  throw new Error('writer never read its keys');
}

async function drain(store: AsyncQueryStore): Promise<void> {
  for (let i = 0; i < 5000; i++) {
    if (store.isSettled()) return;
    await sleep(2);
  }
  throw new Error('writer queue did not drain');
}

function asyncDoc(delegate: AsyncDelegate, key: number): Record<string, unknown> | undefined {
  const value = delegate.kv[valueKeyFor(key)] as string | undefined;
  return value ? (JSON.parse(value) as Record<string, unknown>) : undefined;
}

describe('AsyncQueryStore writer', () => {
  const clients: QueryClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
  });

  class Badge extends Entity {
    __typename = t.typename('Badge');
    id = t.id;
    label = t.string;
  }
  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
    karma = t.number;
    badge = t.optional(t.entity(Badge));
  }
  class GetUser extends RESTQuery {
    params = { id: t.id };
    path = `/user/${this.params.id}`;
    result = { user: t.entity(User) };
  }

  function makeClient(store: AsyncQueryStore, mockFetch: ReturnType<typeof createMockFetch>) {
    const client = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn: () => {}, error: () => {} },
    } as never);
    clients.push(client);
    return client;
  }

  it('answers hasEntity from the records it holds, seeded from the delegate', async () => {
    const delegate = new AsyncDelegate();
    delegate.kv[valueKeyFor(42)] = JSON.stringify({ name: 'on disk' });
    const store = writerStore(delegate);
    await scanned(store);
    expect(store.hasEntity!(42)).toBe(true);
    expect(store.hasEntity!(43)).toBe(false);

    store.saveEntity(43, { name: 'written' });
    await drain(store);
    expect(store.hasEntity!(43)).toBe(true);

    // A query whose record references 43 is deleted: the cascade drops it.
    store.saveQuery(
      { statics: { id: 'def', cache: {} } } as never,
      7,
      { user: { __entityRef: 43 } },
      Date.now(),
      new Set([43]),
    );
    await drain(store);
    store.deleteQuery(7);
    await drain(store);
    expect(store.hasEntity!(43)).toBe(false);
    expect(store.hasEntity!(42)).toBe(true);
  });

  it('refreshes the record of an entity on disk but not in memory by merging the event into it', async () => {
    const delegate = new AsyncDelegate();
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    mockFetch.get('/user/u1', {
      user: {
        __typename: 'User',
        id: 'u1',
        name: 'Alice',
        karma: 10,
        badge: { __typename: 'Badge', id: 'b1', label: 'gold' },
      },
    });
    const client = makeClient(store, mockFetch);
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u1' }));
    await drain(store);
    await scanned(store);
    client.entityMap.getEntity(K('User', 'u1'))!.evict();

    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u1', name: 'Alicia', karma: 10 },
    });
    await drain(store);

    expect(asyncDoc(delegate, K('User', 'u1'))).toMatchObject({ name: 'Alicia', karma: 10 });
    expect(Array.from(delegate.kv[refIdsKeyFor(K('User', 'u1'))] as Uint32Array)).toEqual([K('Badge', 'b1')]);
    expect(asyncDoc(delegate, K('Badge', 'b1'))).toMatchObject({ label: 'gold' });
    expect(client.entityMap.getEntity(K('User', 'u1'))).toBeUndefined();

    // An entity the store has never seen leaves nothing behind.
    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u404', name: 'Nobody', karma: 0 },
    });
    await drain(store);
    expect(asyncDoc(delegate, K('User', 'u404'))).toBeUndefined();
  });

  it('does not write an event for an entity it cannot yet say it holds, and refreshes it once it can', async () => {
    const delegate = new AsyncDelegate(1);
    const mockFetch = createMockFetch();
    mockFetch.get('/user/u1', {
      user: {
        __typename: 'User',
        id: 'u1',
        name: 'Alice',
        karma: 10,
        badge: { __typename: 'Badge', id: 'b1', label: 'gold' },
      },
    });
    mockFetch.get('/user/u2', { user: { __typename: 'User', id: 'u2', name: 'Bob', karma: 1 } });
    const first = writerStore(delegate);
    const client1 = makeClient(first, mockFetch);
    await holdQuery(client1, () => fetchQuery(GetUser, { id: 'u1' }));
    await drain(first);
    client1.destroy();

    // A fresh writer has not read its keys yet when the event lands.
    let releaseScan = () => {};
    const scanGate = new Promise<void>(resolve => (releaseScan = resolve));
    const originalGetAllKeys = delegate.getAllKeys.bind(delegate);
    delegate.getAllKeys = async () => {
      await scanGate;
      return originalGetAllKeys();
    };
    const store = writerStore(delegate);
    const client = makeClient(store, mockFetch);
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u2' }));
    expect(store.hasEntity!(K('User', 'u1'))).toBeUndefined();
    // What this writer wrote itself is known even now.
    expect(store.hasEntity!(K('User', 'u2'))).toBe(true);
    const event = () => ({
      type: 'update' as const,
      typename: 'User',
      data: { __typename: 'User', id: 'u1', name: 'Alicia', karma: 10 },
    });
    client.applyMutationEvent(event());
    expect(client.entityMap.getEntity(K('User', 'u1'))).toBeUndefined();
    releaseScan();
    await scanned(store);
    await drain(store);
    // Not written: nothing referenced it and the store could not say it held it.
    expect(asyncDoc(delegate, K('User', 'u1'))).toMatchObject({ name: 'Alice' });
    expect(store.hasEntity!(K('User', 'u1'))).toBe(true);

    client.applyMutationEvent(event());
    await drain(store);
    expect(asyncDoc(delegate, K('User', 'u1'))).toMatchObject({
      name: 'Alicia',
      karma: 10,
      badge: { __entityRef: K('Badge', 'b1') },
    });
    expect(asyncDoc(delegate, K('Badge', 'b1'))).toMatchObject({ label: 'gold' });
  });

  it('ignores what it does not understand on the channel and keeps processing', async () => {
    const delegate = new AsyncDelegate();
    const store = writerStore(delegate);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handle = (store as unknown as { handleMessage(msg: unknown): void }).handleMessage.bind(store);
      handle(null);
      handle(undefined);
      handle('hello');
      handle({ type: -1 });
      handle({ type: 9, entityKey: 1 });
      handle({ type: 1.5 });
      store.saveEntity(7, { name: 'still written' });
      await drain(store);
      expect(asyncDoc(delegate, 7)).toMatchObject({ name: 'still written' });
      expect(store.isSettled()).toBe(true);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it('writes the fields as the record when the stored record cannot be merged into', async () => {
    const delegate = new AsyncDelegate();
    delegate.kv[valueKeyFor(5)] = '{not json';
    delegate.kv[valueKeyFor(6)] = JSON.stringify(['an', 'array']);
    const store = writerStore(delegate);
    store.mergeEntity(5, { name: 'healed' });
    store.mergeEntity(6, { name: 'healed too' });
    await drain(store);
    expect(asyncDoc(delegate, 5)).toEqual({ name: 'healed' });
    expect(asyncDoc(delegate, 6)).toEqual({ name: 'healed too' });

    const kv = new MemoryPersistentStore();
    kv.setString(valueKeyFor(5), '{not json');
    new SyncQueryStore(kv).mergeEntity(5, { name: 'healed' });
    expect(getDoc(kv, 5)).toEqual({ name: 'healed' });
  });

  it('counts a queued write as held, so an event for it is refreshed before the write lands', async () => {
    const delegate = new AsyncDelegate(5);
    const store = writerStore(delegate);
    await scanned(store);
    const mockFetch = createMockFetch();
    mockFetch.get('/user/u1', { user: { __typename: 'User', id: 'u1', name: 'Alice', karma: 10 } });
    const client = makeClient(store, mockFetch);
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u1' }));
    // The write is queued, not processed; the entity is collected meanwhile.
    expect(store.isSettled()).toBe(false);
    expect(store.hasEntity!(K('User', 'u1'))).toBe(true);
    client.entityMap.getEntity(K('User', 'u1'))!.evict();
    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u1', name: 'Alicia', karma: 10 },
    });
    await drain(store);
    expect(asyncDoc(delegate, K('User', 'u1'))).toMatchObject({ name: 'Alicia' });
  });

  it('a reader with its own delegate still purges stale queries directly', async () => {
    const delegate = new AsyncDelegate();
    delegate.kv['sq:doc:lastUsed:old-def'] = 1;
    delegate.kv['sq:doc:cacheTime:old-def'] = 1;
    delegate.kv[queueKeyFor('old-def')] = new Uint32Array([9, 0]);
    delegate.kv[valueKeyFor(9)] = JSON.stringify({ stale: true });
    delegate.kv[updatedAtKeyFor(9)] = 1;
    const reader = new AsyncQueryStore({
      isWriter: false,
      delegate,
      connect: () => ({ sendMessage: () => {} }),
    });
    await reader.purgeStaleQueries();
    expect(delegate.kv[valueKeyFor(9)]).toBeUndefined();
    expect(delegate.kv[queueKeyFor('old-def')]).toBeUndefined();
  });

  it('a store without mergeEntity gets the whole in-memory data of an event-built entity', async () => {
    const kv = new MemoryPersistentStore();
    const inner = new SyncQueryStore(kv);
    // A custom store forwarding the pre-0.6 surface only.
    const custom = {
      loadQuery: inner.loadQuery.bind(inner),
      saveQuery: inner.saveQuery.bind(inner),
      saveEntity: (key: number, value: unknown, refIds?: Set<number>) => inner.saveEntity(key, value, refIds),
      activateQuery: inner.activateQuery.bind(inner),
      deleteQuery: inner.deleteQuery.bind(inner),
      hasEntity: inner.hasEntity.bind(inner),
    };
    const mockFetch = createMockFetch();
    mockFetch.get('/user/u1', {
      user: {
        __typename: 'User',
        id: 'u1',
        name: 'Alice',
        karma: 10,
        badge: { __typename: 'Badge', id: 'b1', label: 'gold' },
      },
    });
    const client = new QueryClient({
      store: custom,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn: () => {}, error: () => {} },
    } as never);
    clients.push(client);
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u1' }));
    client.entityMap.getEntity(K('User', 'u1'))!.evict();
    client.applyMutationEvent({
      type: 'update',
      typename: 'User',
      data: { __typename: 'User', id: 'u1', name: 'Alicia', karma: 10 },
    });
    await sleep(5);
    // Written whole, dropping the badge the event did not carry, never as a
    // record holding only the event's fields.
    expect(getDoc(kv, K('User', 'u1'))).toMatchObject({ __typename: 'User', id: 'u1', name: 'Alicia', karma: 10 });
    expect(getDoc(kv, K('User', 'u1'))!.badge).toBeUndefined();
  });

  it('runs purgeStaleQueries through its queue, after the writes queued before it', async () => {
    const delegate = new AsyncDelegate();
    // A definition last used long ago, with one query whose record references entity 5.
    delegate.kv['sq:doc:lastUsed:old-def'] = 1;
    delegate.kv['sq:doc:cacheTime:old-def'] = 1;
    delegate.kv[queueKeyFor('old-def')] = new Uint32Array([9, 0, 0]);
    delegate.kv[valueKeyFor(9)] = JSON.stringify({ user: { __entityRef: 5 } });
    delegate.kv[updatedAtKeyFor(9)] = 1;
    delegate.kv[refIdsKeyFor(9)] = new Uint32Array([5]);
    delegate.kv[valueKeyFor(5)] = JSON.stringify({ name: 'old' });
    delegate.kv[refCountKeyFor(5)] = 1;
    const store = writerStore(delegate);
    const log: string[] = [];
    store.onPersisted!(key => log.push(`ack ${key}`));
    store.onDelete!(key => log.push(`delete ${key}`));

    store.saveEntity(5, { name: 'new' });
    const purged = store.purgeStaleQueries();
    expect(store.isSettled()).toBe(false);
    await purged;

    // The write was acknowledged before the purge dropped the record, so the
    // client that heard both ends up with the record marked missing.
    expect(log).toEqual(['ack 5', 'delete 9', 'delete 5']);
    expect(delegate.kv[valueKeyFor(5)]).toBeUndefined();
    expect(store.hasEntity!(5)).toBe(false);
  });

  it('shrinking the LRU while activating a key among the dropped slots keeps that key', async () => {
    const delegate = new AsyncDelegate();
    const defId = 'shrink-def';
    const def = (maxCount: number) => ({ statics: { id: defId, cache: { maxCount } } }) as never;
    delegate.kv[queueKeyFor(defId)] = new Uint32Array([4, 3, 2, 1]);
    for (const key of [4, 3, 2, 1]) {
      delegate.kv[valueKeyFor(key)] = JSON.stringify({ __entityRef: key });
      delegate.kv[updatedAtKeyFor(key)] = 1;
    }
    const store = writerStore(delegate);
    store.activateQuery(def(3), 1);
    await drain(store);

    expect(Array.from(delegate.kv[queueKeyFor(defId)] as Uint32Array)).toEqual([1, 4, 3]);
    expect(delegate.kv[valueKeyFor(1)]).toBeDefined();
    expect(delegate.kv[valueKeyFor(2)]).toBeUndefined();

    // The same for SyncQueryStore.
    const kv = new MemoryPersistentStore();
    kv.setBuffer(queueKeyFor(defId), new Uint32Array([4, 3, 2, 1]));
    for (const key of [4, 3, 2, 1]) {
      kv.setString(valueKeyFor(key), JSON.stringify({ __entityRef: key }));
      kv.setNumber(updatedAtKeyFor(key), 1);
    }
    new SyncQueryStore(kv).activateQuery(def(3), 1);
    expect(Array.from(kv.getBuffer(queueKeyFor(defId))!)).toEqual([1, 4, 3]);
    expect(kv.getString(valueKeyFor(1))).toBeDefined();
    expect(kv.getString(valueKeyFor(2))).toBeUndefined();
  });

  it('a message without maxCount keeps the persisted queue at its size', async () => {
    const delegate = new AsyncDelegate();
    delegate.kv[queueKeyFor('legacy-def')] = new Uint32Array([4, 3, 2, 1]);
    for (const key of [4, 3, 2, 1]) {
      delegate.kv[valueKeyFor(key)] = JSON.stringify({ __entityRef: key });
      delegate.kv[updatedAtKeyFor(key)] = 1;
    }
    delegate.kv[valueKeyFor(7)] = JSON.stringify({ __entityRef: 7 });
    const store = writerStore(delegate);
    (store as unknown as { handleMessage(msg: unknown): void }).handleMessage({
      type: 2,
      queryDefId: 'legacy-def',
      queryKey: 7,
      cacheTime: 1440,
    });
    await drain(store);

    const queue = delegate.kv[queueKeyFor('legacy-def')] as Uint32Array;
    expect(Array.from(queue)).toEqual([7, 4, 3, 2]);
    expect(delegate.kv[valueKeyFor(1)]).toBeUndefined();
    expect(delegate.kv[valueKeyFor(2)]).toBeDefined();
  });

  it('an acknowledgement only counts against a write the instance dispatched itself', async () => {
    const delegate = new AsyncDelegate();
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    mockFetch.get('/user/u1', { user: { __typename: 'User', id: 'u1', name: 'Alice', karma: 10 } });
    const client = makeClient(store, mockFetch);
    await holdQuery(client, () => fetchQuery(GetUser, { id: 'u1' }));
    const first = client.entityMap.getEntity(K('User', 'u1'))!;
    expect(first._pendingWrites).toBe(1);
    expect(first._persisted).toBe(false);
    await drain(store);
    expect(first._pendingWrites).toBe(0);
    expect(first._persisted).toBe(true);

    // An instance that never wrote (hydrated from the store) ignores a stray acknowledgement.
    first.recordDropped();
    first.acknowledgeWrite();
    expect(first._persisted).toBe(false);

    // Two writes in flight: the record is current once both have landed.
    first.save();
    first.save();
    expect(first._pendingWrites).toBe(2);
    await drain(store);
    expect(first._pendingWrites).toBe(0);
    expect(first._persisted).toBe(true);
  });

  it('does not write a parent referencing a created child before the child is written', async () => {
    class Item extends Entity {
      __typename = t.typename('Item');
      id = t.id;
      listId = t.string;
      title = t.string;
    }
    class List extends Entity {
      __typename = t.typename('List');
      id = t.id;
      items = t.liveArray(Item, { constraints: { listId: (this as any).id } });
    }
    class GetList extends RESTQuery {
      path = '/list';
      result = { list: t.entity(List) };
    }

    // Holds the write of one record until released.
    class GatedDelegate extends AsyncDelegate {
      gatedKey: string | undefined;
      gate: Promise<void> | undefined;
      override async setString(key: string, value: string) {
        if (key === this.gatedKey) await this.gate;
        return super.setString(key, value);
      }
    }

    const delegate = new GatedDelegate();
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    mockFetch.get('/list', { list: { __typename: 'List', id: 'l1', items: [] } });
    const client = makeClient(store, mockFetch);
    await holdQuery(client, () => fetchQuery(GetList));
    await drain(store);

    const listKey = K('List', 'l1');
    const itemKey = K('Item', 'i1');
    let release = () => {};
    delegate.gate = new Promise<void>(resolve => (release = resolve));
    delegate.gatedKey = valueKeyFor(itemKey);

    client.applyMutationEvent({
      type: 'create',
      typename: 'Item',
      data: { __typename: 'Item', id: 'i1', listId: 'l1', title: 'new' },
    });
    await sleep(50);

    // The child's write is held, so a cache read now must not find the parent pointing at it.
    expect(asyncDoc(delegate, itemKey)).toBeUndefined();
    expect(asyncDoc(delegate, listKey)).toMatchObject({ items: [] });
    expect(Array.from((delegate.kv[refIdsKeyFor(listKey)] as Uint32Array | undefined) ?? [])).toEqual([]);

    release();
    await drain(store);
    expect(asyncDoc(delegate, itemKey)).toMatchObject({ title: 'new' });
    expect(asyncDoc(delegate, listKey)).toMatchObject({ items: [{ __entityRef: itemKey }] });
  });
});

// ======================================================
// Store work per streamed event
// ======================================================

describe('store work per streamed event', () => {
  class Author extends Entity {
    __typename = t.typename('Author');
    id = t.id;
    name = t.string;
  }
  class Note extends Entity {
    __typename = t.typename('Note');
    id = t.id;
    boardId = t.string;
    body = t.string;
    pinned = t.optional(t.boolean);
    author = t.optional(t.entity(Author));
  }
  class Board extends Entity {
    __typename = t.typename('Board');
    id = t.id;
    notes = t.liveArray(Note, { constraints: { boardId: (this as any).id } });
  }
  class GetBoard extends RESTQuery {
    params = { id: t.id };
    path = `/board/${this.params.id}`;
    result = { board: t.entity(Board) };
  }

  const getClient = setupTestClient();

  it('an entity an event built, of which the store held no record, is written whole afterwards', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/board/b1', { board: { __typename: 'Board', id: 'b1', notes: [] } });
    const boardQ = holdQuery(client, () => fetchQuery(GetBoard, { id: 'b1' }));
    await boardQ;
    const merges = vi.spyOn(store, 'mergeEntity');
    const reads = vi.spyOn(kv, 'getString');

    client.applyMutationEvent({
      type: 'create',
      typename: 'Note',
      data: { __typename: 'Note', id: 'n1', boardId: 'b1', body: 'first' },
    });
    for (let i = 0; i < 3; i++) {
      client.applyMutationEvent({ type: 'update', typename: 'Note', data: { id: 'n1', body: `edit ${i}` } });
    }
    await sleep(5);

    expect(merges).not.toHaveBeenCalled();
    expect(reads.mock.calls.filter(([key]) => key === valueKeyFor(K('Note', 'n1')))).toEqual([]);
    expect(getDoc(kv, K('Note', 'n1'))).toEqual({ __typename: 'Note', id: 'n1', boardId: 'b1', body: 'edit 2' });
    expect((boardQ.value as any).board.notes.map((n: any) => n.body)).toEqual(['edit 2']);
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
  });

  it('an entity an event built over a record the store holds keeps merging into it', async () => {
    const { client, mockFetch, kv, store } = getClient();
    mockFetch.get('/board/b1', {
      board: {
        __typename: 'Board',
        id: 'b1',
        notes: [{ __typename: 'Note', id: 'n1', boardId: 'b1', body: 'a', pinned: true }],
      },
    });
    const boardQ = holdQuery(client, () => fetchQuery(GetBoard, { id: 'b1' }));
    await boardQ;
    // The note leaves memory but its record stays (the board's cache holds it).
    client.applyMutationEvent({ type: 'delete', typename: 'Note', data: 'n1' });
    await sleep(5);
    kv.setString(
      valueKeyFor(K('Note', 'n1')),
      JSON.stringify({ __typename: 'Note', id: 'n1', boardId: 'b1', body: 'a', pinned: true }),
    );
    const merges = vi.spyOn(store, 'mergeEntity');

    client.applyMutationEvent({
      type: 'create',
      typename: 'Note',
      data: { __typename: 'Note', id: 'n1', boardId: 'b1', body: 'b' },
    });
    await sleep(5);

    expect(merges.mock.calls.map(c => c[0])).toEqual([K('Note', 'n1')]);
    // The field the event did not carry survives.
    expect(getDoc(kv, K('Note', 'n1'))).toMatchObject({ body: 'b', pinned: true });
  });
});

describe('AsyncQueryStore writer: write skipping while writes are queued', () => {
  const clients: QueryClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
  });

  class Badge extends Entity {
    // Lingers in memory once released, so a later apply finds the same instance.
    static cache = { gcTime: 60 };
    __typename = t.typename('Badge');
    id = t.id;
    label = t.string;
  }
  class User extends Entity {
    __typename = t.typename('User');
    id = t.id;
    name = t.string;
    karma = t.number;
    badge = t.optional(t.entity(Badge));
  }
  class GetUser extends RESTQuery {
    params = { id: t.id };
    path = `/user/${this.params.id}`;
    result = { user: t.entity(User) };
  }

  async function setup(users: Record<string, unknown>[]) {
    const delegate = new AsyncDelegate(3);
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    for (const user of users) mockFetch.get(`/user/${user.id as string}`, { user });
    const client = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn: () => {}, error: () => {} },
    } as never);
    clients.push(client);
    for (const user of users) await holdQuery(client, () => fetchQuery(GetUser, { id: user.id as string }));
    await drain(store);
    await scanned(store);
    const saves = vi.spyOn(store, 'saveEntity');
    const merges = vi.spyOn(store, 'mergeEntity');
    const writes = () => [...saves.mock.calls.map(c => c[0]), ...merges.mock.calls.map(c => c[0])];
    return { delegate, store, client, writes };
  }

  const user = (id: string, karma: number, badge?: Record<string, unknown>) => ({
    __typename: 'User',
    id,
    name: id,
    karma,
    ...(badge !== undefined ? { badge } : {}),
  });

  it("one entity's queued write leaves skipping on for identical events of other entities", async () => {
    const { store, client, writes } = await setup([user('u1', 1), user('u2', 2), user('u3', 3)]);

    client.applyMutationEvent({ type: 'update', typename: 'User', data: { id: 'u1', karma: 10 } });
    client.applyMutationEvent({ type: 'update', typename: 'User', data: { id: 'u2', karma: 2 } });
    client.applyMutationEvent({ type: 'update', typename: 'User', data: { id: 'u3', karma: 3 } });
    // Identical to the write still queued for u1.
    client.applyMutationEvent({ type: 'update', typename: 'User', data: { id: 'u1', karma: 10 } });
    expect(store.isSettled()).toBe(false);
    await drain(store);

    expect(writes()).toEqual([K('User', 'u1')]);
  });

  it('a queued deletion still turns skipping off', async () => {
    const { store, client, writes } = await setup([user('u1', 1)]);

    store.deleteQuery(12345);
    client.applyMutationEvent({ type: 'update', typename: 'User', data: { id: 'u1', karma: 1 } });
    await drain(store);

    expect(writes()).toEqual([K('User', 'u1')]);
  });

  it('an entity a queued write stops referencing is written again when it is referenced again', async () => {
    class Card extends Entity {
      // Lingers in memory once released, so the next event finds the same instance.
      static cache = { gcTime: 60 };
      __typename = t.typename('Card');
      id = t.id;
      deckId = t.string;
      title = t.string;
    }
    class Deck extends Entity {
      __typename = t.typename('Deck');
      id = t.id;
      cards = t.liveArray(Card, { constraints: { deckId: (this as any).id } });
    }
    class GetDeck extends RESTQuery {
      path = '/deck';
      result = { deck: t.entity(Deck) };
    }
    const card = { __typename: 'Card', id: 'c1', deckId: 'd1', title: 'Ace' };
    const delegate = new AsyncDelegate(3);
    const store = writerStore(delegate);
    const mockFetch = createMockFetch();
    mockFetch.get('/deck', { deck: { __typename: 'Deck', id: 'd1', cards: [card] } });
    const client = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
      log: { warn: () => {}, error: () => {} },
    } as never);
    clients.push(client);
    const deckQ = holdQuery(client, () => fetchQuery(GetDeck));
    await deckQ;
    await drain(store);
    await scanned(store);

    // The deck's write drops its reference to c1, the only one on disk. Before
    // it is processed, the same card is created again with identical data.
    client.applyMutationEvent({ type: 'delete', typename: 'Card', data: 'c1' });
    client.applyMutationEvent({ type: 'create', typename: 'Card', data: card });
    await drain(store);

    expect((deckQ.value as any).deck.cards.map((c: any) => c.title)).toEqual(['Ace']);
    expect(Array.from(delegate.kv[refIdsKeyFor(K('Deck', 'd1'))] as Uint32Array)).toEqual([K('Card', 'c1')]);
    expect(asyncDoc(delegate, K('Card', 'c1'))).toMatchObject({ title: 'Ace' });
  });
});

// ======================================================
// A typename two classes share, across sessions
// ======================================================

describe('an event for a typename whose other class is not registered this session', () => {
  class Tag extends Entity {
    __typename = t.typename('Tag');
    id = t.id;
    label = t.string;
  }
  // A list's class and a detail class of one typename: a list-shaped event
  // carries every field of the list's class, but not the detail's.
  class CoinRow extends Entity {
    __typename = t.typename('Coin');
    id = t.id;
    symbol = t.string;
    price = t.number;
  }
  class CoinDetail extends Entity {
    __typename = t.typename('Coin');
    id = t.id;
    symbol = t.string;
    price = t.number;
    about = t.string;
    tag = t.entity(Tag);
  }
  class Market extends Entity {
    __typename = t.typename('Market');
    id = t.id;
    top = t.entity(CoinRow);
  }
  class GetCoinDetail extends RESTQuery {
    path = '/coin';
    result = { coin: t.entity(CoinDetail) };
  }
  class GetCoinRows extends RESTQuery {
    path = '/coins';
    result = { coins: t.array(t.entity(CoinRow)) };
  }
  class GetMarket extends RESTQuery {
    path = '/market';
    result = { market: t.entity(Market) };
  }

  const clients: QueryClient[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.destroy();
  });

  const detailCoin = {
    __typename: 'Coin',
    id: 'c1',
    symbol: 'C',
    price: 1,
    about: 'cached',
    tag: { __typename: 'Tag', id: 'g1', label: 'gold' },
  };
  const row = (id: string, price: number) => ({ __typename: 'Coin', id, symbol: 'C', price });
  const detailRecord = (price: number) => ({
    __typename: 'Coin',
    id: 'c1',
    symbol: 'C',
    price,
    about: 'cached',
    tag: { __entityRef: K('Tag', 'g1') },
  });

  function session(kv: MemoryPersistentStore, mockFetch: ReturnType<typeof createMockFetch>): QueryClient {
    const client = new QueryClient({
      store: new SyncQueryStore(kv),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as never, baseUrl: 'http://localhost' })],
    } as never);
    clients.push(client);
    return client;
  }

  /** A first session caches the detail of c1, then ends. */
  async function cacheDetail(kv: MemoryPersistentStore): Promise<ReturnType<typeof createMockFetch>> {
    const mockFetch = createMockFetch();
    mockFetch.get('/coin', { coin: detailCoin });
    const first = session(kv, mockFetch);
    await holdQuery(first, () => fetchQuery(GetCoinDetail));
    first.destroy();
    return mockFetch;
  }

  /** The next session's detail query, served from the cache before its slow fetch lands. */
  async function detailAtNextStart(
    kv: MemoryPersistentStore,
    mockFetch: ReturnType<typeof createMockFetch>,
  ): Promise<unknown> {
    mockFetch.get('/coin', { coin: { ...detailCoin, about: 'network' } }, { delay: 200 });
    const next = session(kv, mockFetch);
    const detailQ = holdQuery(next, () => fetchQuery(GetCoinDetail));
    await sleep(20);
    return detailQ.isReady ? (detailQ.value as any).coin.about : 'not ready';
  }

  it('an update for an entity not in memory merges into its record instead of replacing it', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = await cacheDetail(kv);

    // Only the list's class is registered (a list of other coins); c1 is not in memory.
    mockFetch.get('/coins', { coins: [row('c2', 2)] });
    const client = session(kv, mockFetch);
    await holdQuery(client, () => fetchQuery(GetCoinRows));
    client.applyMutationEvent({ type: 'update', typename: 'Coin', data: row('c1', 3) });

    expect(getDoc(kv, K('Coin', 'c1'))).toEqual(detailRecord(3));
    expect(refIds(kv, K('Coin', 'c1'))).toEqual([K('Tag', 'g1')]);
    client.destroy();
    expect(await detailAtNextStart(kv, mockFetch)).toBe('cached');
  });

  it('an entity an event builds under a root in memory merges into its record too', async () => {
    const kv = new MemoryPersistentStore();
    const mockFetch = await cacheDetail(kv);

    mockFetch.get('/market', { market: { __typename: 'Market', id: 'm1', top: row('c2', 2) } });
    const client = session(kv, mockFetch);
    await holdQuery(client, () => fetchQuery(GetMarket));
    client.applyMutationEvent({
      type: 'update',
      typename: 'Market',
      data: { __typename: 'Market', id: 'm1', top: row('c1', 3) },
    });
    // A later event for the in-memory entity still merges.
    client.applyMutationEvent({ type: 'update', typename: 'Coin', data: row('c1', 4) });

    expect(getDoc(kv, K('Coin', 'c1'))).toEqual(detailRecord(4));
    expect(audit(kv)).toEqual({ orphans: [], dangling: [] });
    client.destroy();
    expect(await detailAtNextStart(kv, mockFetch)).toBe('cached');
  });
});
