import { describe, it, expect, vi } from 'vitest';
import { reactive } from 'signalium';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery, RESTMutation } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { getMutation } from '../mutation.js';
import { setupTestClient, sleep, testWithClient } from './utils.js';

class OptPost extends Entity {
  __typename = t.typename('OptPost');
  id = t.id;
  title = t.string;
  liked = t.boolean;
  editedAt = t.format('date');
}

class GetOptPost extends RESTQuery {
  readonly path = '/post';
  readonly result = { post: t.entity(OptPost) };
}

class SetLiked extends RESTMutation {
  readonly path = '/like';
  readonly params = { id: t.id, liked: t.boolean };
  readonly optimisticUpdates = true;
  readonly config = { retry: false as const };
  readonly effects = { updates: [[OptPost, { id: this.params.id, liked: this.params.liked }] as const] };
}

const post = { __typename: 'OptPost', id: '1', title: 'Hello', liked: false, editedAt: '2026-10-01' };

describe('Optimistic mutations', () => {
  const getClient = setupTestClient();

  it('applies params effects before the response and keeps the server value on success', async () => {
    const { client, mockFetch } = getClient();

    class Rename extends RESTMutation {
      readonly path = '/rename';
      readonly params = { id: t.id, title: t.string };
      readonly result = { post: t.object({ __typename: t.string, id: t.id, title: t.string }) };
      readonly optimisticUpdates = true;
      readonly effects = {
        updates: [
          [OptPost, { id: this.params.id, title: this.params.title }] as const,
          [OptPost, this.result.post] as const,
        ],
      };
    }

    mockFetch.get('/post', { post });
    mockFetch.post('/rename', { post: { __typename: 'OptPost', id: '1', title: 'hello world' } }, { delay: 10 });

    await testWithClient(client, async () => {
      const { post: entity } = await fetchQuery(GetOptPost);
      const pending = getMutation(Rename).run({ id: '1', title: 'Hello World' });
      await sleep();
      expect(entity.title).toBe('Hello World');
      await pending;
      expect(entity.title).toBe('hello world');
    });
  });

  it('rolls back updated fields, including formatted ones, when the request fails', async () => {
    const { client, mockFetch } = getClient();

    class Edit extends RESTMutation {
      readonly path = '/edit';
      readonly params = { id: t.id, liked: t.boolean, editedAt: t.string };
      readonly optimisticUpdates = true;
      readonly config = { retry: false as const };
      readonly effects = {
        updates: [[OptPost, { id: this.params.id, liked: this.params.liked, editedAt: this.params.editedAt }] as const],
      };
    }

    mockFetch.get('/post', { post });
    mockFetch.post('/edit', { message: 'failed' }, { status: 500, delay: 10 });

    await testWithClient(client, async () => {
      const { post: entity } = await fetchQuery(GetOptPost);
      const pending = getMutation(Edit).run({ id: '1', liked: true, editedAt: '2026-11-19' });
      await sleep();
      expect(entity.liked).toBe(true);
      expect(entity.editedAt.toISOString()).toBe('2026-11-19T00:00:00.000Z');
      await expect(pending).rejects.toThrow();
      expect(entity.liked).toBe(false);
      expect(entity.editedAt.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    });
  });

  it('keeps a value another source wrote while the request was in flight', async () => {
    const { client, mockFetch } = getClient();

    class Retitle extends RESTMutation {
      readonly path = '/retitle';
      readonly params = { id: t.id, title: t.string, liked: t.boolean };
      readonly optimisticUpdates = true;
      readonly config = { retry: false as const };
      readonly effects = {
        updates: [[OptPost, { id: this.params.id, title: this.params.title, liked: this.params.liked }] as const],
      };
    }

    mockFetch.get('/post', { post });
    mockFetch.post('/retitle', {}, { error: new Error('offline'), delay: 10 });

    await testWithClient(client, async () => {
      const { post: entity } = await fetchQuery(GetOptPost);
      const pending = getMutation(Retitle).run({ id: '1', title: 'Optimistic', liked: true });
      await sleep();
      client.applyMutationEvent({ type: 'update', typename: 'OptPost', data: { id: '1', title: 'Stream' } });
      await expect(pending).rejects.toThrow();
      expect(entity.title).toBe('Stream');
      expect(entity.liked).toBe(false);
    });
  });

  it('restores an entity reference and a deleted entity with references', async () => {
    const { client, mockFetch } = getClient();

    class OptAuthor extends Entity {
      __typename = t.typename('OptAuthor');
      id = t.id;
      name = t.string;
    }

    class OptBook extends Entity {
      __typename = t.typename('OptBook');
      id = t.id;
      shelf = t.string;
      author = t.entity(OptAuthor);
    }

    class OptShelf extends Entity {
      __typename = t.typename('OptShelf');
      id = t.id;
      books = t.liveArray(OptBook, { constraints: { shelf: (this as any).id } });
    }

    class GetShelf extends RESTQuery {
      readonly path = '/shelf';
      readonly result = { shelf: t.entity(OptShelf), other: t.entity(OptAuthor) };
    }

    class SetAuthor extends RESTMutation {
      readonly path = '/author';
      readonly params = { id: t.id, authorId: t.string };
      readonly optimisticUpdates = true;
      readonly config = { retry: false as const };
      readonly effects = {
        updates: [
          [OptBook, { id: this.params.id, author: { __typename: 'OptAuthor', id: this.params.authorId } }] as const,
        ],
      };
    }

    class RemoveBook extends RESTMutation {
      readonly path = '/remove-book';
      readonly params = { id: t.id };
      readonly optimisticUpdates = true;
      readonly config = { retry: false as const };
      readonly effects = { deletes: [[OptBook, this.params.id] as const] };
    }

    mockFetch.get('/shelf', {
      shelf: {
        __typename: 'OptShelf',
        id: 's1',
        books: [
          { __typename: 'OptBook', id: 'b1', shelf: 's1', author: { __typename: 'OptAuthor', id: 'a1', name: 'Ann' } },
        ],
      },
      other: { __typename: 'OptAuthor', id: 'a2', name: 'Bo' },
    });
    mockFetch.post('/author', {}, { error: new Error('offline'), delay: 10 });
    mockFetch.post('/remove-book', {}, { error: new Error('offline'), delay: 10 });

    await testWithClient(client, async () => {
      const { shelf } = await fetchQuery(GetShelf);
      const authors = reactive(() => shelf.books.map(b => b.author.name));

      const setAuthor = getMutation(SetAuthor).run({ id: 'b1', authorId: 'a2' });
      await sleep();
      expect(authors()).toEqual(['Bo']);
      await expect(setAuthor).rejects.toThrow();
      expect(authors()).toEqual(['Ann']);

      const remove = getMutation(RemoveBook).run({ id: 'b1' });
      await sleep();
      expect(authors()).toEqual([]);
      await expect(remove).rejects.toThrow();
      expect(authors()).toEqual(['Ann']);
    });
  });

  describe('overlapping calls', () => {
    class Retitle extends RESTMutation {
      readonly path = '/retitle';
      readonly params = { id: t.id, title: t.string };
      readonly optimisticUpdates = true;
      readonly config = { retry: false as const };
      readonly effects = { updates: [[OptPost, { id: this.params.id, title: this.params.title }] as const] };
    }

    // `run()` returns the task itself, which settles with the latest call, so
    // the earlier call's outcome is read from the entity after its delay.
    it('shows the latest remaining call when the newest one fails, then the original value', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/post', { post });
      mockFetch.post('/retitle', {}, { error: new Error('offline'), delay: 60 });
      mockFetch.post('/retitle', {}, { error: new Error('offline'), delay: 50 });
      mockFetch.post('/retitle', {}, { error: new Error('offline'), delay: 10 });

      await testWithClient(client, async () => {
        const { post: entity } = await fetchQuery(GetOptPost);
        const retitle = getMutation(Retitle);
        retitle.run({ id: '1', title: 'First' });
        await sleep();
        retitle.run({ id: '1', title: 'Second' });
        await sleep();
        retitle.run({ id: '1', title: 'Third' });
        await sleep(25);
        expect(entity.title).toBe('Second');
        await sleep(50);
        expect(entity.title).toBe('Hello');
      });
    });

    it('keeps the later value when the earlier call fails first', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/post', { post });
      mockFetch.post('/retitle', {}, { error: new Error('offline'), delay: 10 });
      mockFetch.post('/retitle', {}, { error: new Error('offline'), delay: 40 });

      await testWithClient(client, async () => {
        const { post: entity } = await fetchQuery(GetOptPost);
        const retitle = getMutation(Retitle);
        retitle.run({ id: '1', title: 'First' });
        await sleep();
        retitle.run({ id: '1', title: 'Second' });
        await sleep(25);
        expect(entity.title).toBe('Second');
        await expect(retitle).rejects.toThrow();
        expect(entity.title).toBe('Hello');
      });
    });

    it('keeps a pending later value over an earlier success, then restores the confirmed value', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/post', { post });
      mockFetch.post('/retitle', {}, { delay: 10 });
      mockFetch.post('/retitle', {}, { error: new Error('offline'), delay: 40 });

      await testWithClient(client, async () => {
        const { post: entity } = await fetchQuery(GetOptPost);
        const retitle = getMutation(Retitle);
        retitle.run({ id: '1', title: 'First' });
        await sleep();
        retitle.run({ id: '1', title: 'Second' });
        await sleep(25);
        expect(entity.title).toBe('Second');
        await expect(retitle).rejects.toThrow();
        expect(entity.title).toBe('First');
      });
    });
  });

  describe('live arrays', () => {
    class OptItem extends Entity {
      __typename = t.typename('OptItem');
      id = t.id;
      listId = t.string;
      name = t.string;
    }

    class OptList extends Entity {
      __typename = t.typename('OptList');
      id = t.id;
      items = t.liveArray(OptItem, { constraints: { listId: (this as any).id } });
    }

    class GetOptList extends RESTQuery {
      readonly path = '/list';
      readonly result = { list: t.entity(OptList) };
    }

    const list = {
      __typename: 'OptList',
      id: 'l1',
      items: [{ __typename: 'OptItem', id: 'a', listId: 'l1', name: 'A' }],
    };

    it('removes an optimistically created entity when the request fails', async () => {
      const { client, mockFetch } = getClient();

      class AddItem extends RESTMutation {
        readonly path = '/items';
        readonly params = { id: t.id, listId: t.string, name: t.string };
        readonly optimisticUpdates = true;
        readonly config = { retry: false as const };
        readonly effects = {
          creates: [
            [
              OptItem,
              { __typename: 'OptItem', id: this.params.id, listId: this.params.listId, name: this.params.name },
            ] as const,
          ],
        };
      }

      mockFetch.get('/list', { list });
      mockFetch.post('/items', {}, { error: new Error('offline'), delay: 10 });

      await testWithClient(client, async () => {
        const { list: entity } = await fetchQuery(GetOptList);
        const names = reactive(() => entity.items.map(i => i.name));
        expect(names()).toEqual(['A']);
        const pending = getMutation(AddItem).run({ id: 'b', listId: 'l1', name: 'B' });
        await sleep();
        expect(names()).toEqual(['A', 'B']);
        await expect(pending).rejects.toThrow();
        expect(names()).toEqual(['A']);
      });
    });

    it('restores an optimistically deleted entity when the request fails', async () => {
      const { client, mockFetch } = getClient();

      class RemoveItem extends RESTMutation {
        readonly path = '/items/remove';
        readonly params = { id: t.id };
        readonly optimisticUpdates = true;
        readonly config = { retry: false as const };
        readonly effects = { deletes: [[OptItem, this.params.id] as const] };
      }

      mockFetch.get('/list', { list });
      mockFetch.post('/items/remove', {}, { error: new Error('offline'), delay: 10 });

      await testWithClient(client, async () => {
        const { list: entity } = await fetchQuery(GetOptList);
        const names = reactive(() => entity.items.map(i => i.name));
        const pending = getMutation(RemoveItem).run({ id: 'a' });
        await sleep();
        expect(names()).toEqual([]);
        await expect(pending).rejects.toThrow();
        expect(names()).toEqual(['A']);
      });
    });
  });

  it('applies nothing before the response without the flag', async () => {
    const { client, mockFetch } = getClient();

    class SetLikedLater extends RESTMutation {
      readonly path = '/like';
      readonly params = { id: t.id, liked: t.boolean };
      readonly effects = { updates: [[OptPost, { id: this.params.id, liked: this.params.liked }] as const] };
    }

    mockFetch.get('/post', { post });
    mockFetch.post('/like', {}, { delay: 10 });

    await testWithClient(client, async () => {
      const { post: entity } = await fetchQuery(GetOptPost);
      const pending = getMutation(SetLikedLater).run({ id: '1', liked: true });
      await sleep();
      expect(entity.liked).toBe(false);
      await pending;
      expect(entity.liked).toBe(true);
    });
  });

  it('warns when no effect can apply before the response', async () => {
    const warn = vi.fn();
    const { client } = getClient();
    client.getContext().log = { ...client.getContext().log, warn };

    class ResultOnly extends RESTMutation {
      readonly path = '/result-only';
      readonly result = { post: t.object({ __typename: t.string, id: t.id, title: t.string }) };
      readonly optimisticUpdates = true;
      readonly effects = { updates: [[OptPost, this.result.post] as const] };
    }

    await testWithClient(client, async () => {
      getMutation(ResultOnly);
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('none of its effects can be applied'));
  });
});
