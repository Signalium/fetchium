import { describe, it, expect } from 'vitest';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { testWithClient, sleep, setupTestClient } from './utils.js';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';

describe('__fetchNext', () => {
  const getClient = setupTestClient();

  describe('Basic pagination with static fetchNext', () => {
    it('should fetch next page using FieldRef search params', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a', 'b'], nextPage: 2, limit: 2 });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextPage: t.optional(t.number), limit: t.number };
        fetchNext = {
          searchParams: {
            page: this.result.nextPage,
            limit: this.result.limit,
          },
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.items).toEqual(['a', 'b']);

        mockFetch.get('/items', { items: ['c', 'd'], nextPage: 3, limit: 2 });

        await relay.value!.__fetchNext();

        const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
        expect(lastCall.url).toContain('page=2');
        expect(lastCall.url).toContain('limit=2');

        // Non-live array: replaced (not appended)
        expect(relay.value!.items).toEqual(['c', 'd']);
        // Scalar updated to new page value
        expect(relay.value!.nextPage).toBe(3);
      });
    });

    it('should clear optional scalar fields when omitted from new page', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a', 'b'], nextCursor: 'c1' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextCursor: t.optional(t.string) };
        fetchNext = {
          searchParams: { cursor: this.result.nextCursor },
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;
        expect(relay.value!.nextCursor).toBe('c1');

        // Field omitted — server intended undefined (e.g. JSON drops undefined values)
        mockFetch.get('/items', { items: ['c'] });
        await relay.value!.__fetchNext();

        expect(relay.value!.nextCursor).toBeUndefined();
      });
    });

    it('should clear nullable scalar fields with explicit null from new page', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a', 'b'], nextCursor: 'c1' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextCursor: t.nullish(t.string) };
        fetchNext = {
          searchParams: { cursor: this.result.nextCursor },
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;
        expect(relay.value!.nextCursor).toBe('c1');

        // Explicit null — server sent null to clear the value
        mockFetch.get('/items', { items: ['c'], nextCursor: null });
        await relay.value!.__fetchNext();

        expect(relay.value!.nextCursor).toBeNull();
      });
    });
  });

  describe('FieldRef resolution from this.result', () => {
    it('should resolve cursor from current result data', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a', 'b'], nextCursor: 'cursor-1' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextCursor: t.optional(t.string) };
        fetchNext = {
          searchParams: {
            cursor: this.result.nextCursor,
          },
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.nextCursor).toBe('cursor-1');

        mockFetch.get('/items', { items: ['c'], nextCursor: 'cursor-2' });

        await relay.value!.__fetchNext();

        // Verify the fetch was called with the resolved cursor
        const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
        expect(lastCall.url).toContain('cursor=cursor-1');

        // Cursor should be updated to new value
        expect(relay.value!.nextCursor).toBe('cursor-2');
      });
    });

    it('should resolve URL from current result data', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'], nextUrl: '/items?page=2' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextUrl: t.optional(t.string) };
        fetchNext = {
          url: this.result.nextUrl,
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        mockFetch.get('/items?page=2', { items: ['b'], nextUrl: '/items?page=3' });

        await relay.value!.__fetchNext();

        const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
        expect(lastCall.url).toContain('/items?page=2');

        expect(relay.value!.nextUrl).toBe('/items?page=3');
      });
    });

    it('should advance cursor across multiple fetchNext calls', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'], cursor: 'c1' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), cursor: t.optional(t.string) };
        fetchNext = {
          searchParams: { cursor: this.result.cursor },
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        // First fetchNext: cursor=c1
        mockFetch.get('/items', { items: ['b'], cursor: 'c2' });
        await relay.value!.__fetchNext();
        expect(mockFetch.calls[1].url).toContain('cursor=c1');

        // Second fetchNext: cursor should now be c2 (from previous response)
        mockFetch.get('/items', { items: ['c'], cursor: 'c3' });
        await relay.value!.__fetchNext();
        expect(mockFetch.calls[2].url).toContain('cursor=c2');
      });
    });
  });

  describe('Live array accumulation', () => {
    class Item extends Entity {
      __typename = t.typename('Item');
      id = t.id;
      name = t.string;
    }

    it('should append entities to live array across fetchNext calls', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', {
        items: [
          { __typename: 'Item', id: '1', name: 'first' },
          { __typename: 'Item', id: '2', name: 'second' },
        ],
        nextCursor: 'c1',
      });

      class GetItems extends RESTQuery {
        path = '/items';
        result = {
          items: t.liveArray(Item),
          nextCursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: {
            cursor: this.result.nextCursor,
          },
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.items).toHaveLength(2);
        expect(relay.value!.items[0].name).toBe('first');
        expect(relay.value!.items[1].name).toBe('second');

        // Load page 2
        mockFetch.get('/items', {
          items: [{ __typename: 'Item', id: '3', name: 'third' }],
          nextCursor: 'c2',
        });

        await relay.value!.__fetchNext();

        // Live array should have accumulated all 3 items
        expect(relay.value!.items).toHaveLength(3);
        expect(relay.value!.items[0].name).toBe('first');
        expect(relay.value!.items[1].name).toBe('second');
        expect(relay.value!.items[2].name).toBe('third');

        // Cursor updated
        expect(relay.value!.nextCursor).toBe('c2');

        // Load page 3
        mockFetch.get('/items', {
          items: [
            { __typename: 'Item', id: '4', name: 'fourth' },
            { __typename: 'Item', id: '5', name: 'fifth' },
          ],
          nextCursor: undefined,
        });

        await relay.value!.__fetchNext();

        expect(relay.value!.items).toHaveLength(5);
        expect(relay.value!.nextCursor).toBeUndefined();
      });
    });

    it('should deduplicate entities in live array', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', {
        items: [
          { __typename: 'Item', id: '1', name: 'first' },
          { __typename: 'Item', id: '2', name: 'second' },
        ],
        nextCursor: 'c1',
      });

      class GetItems extends RESTQuery {
        path = '/items';
        result = {
          items: t.liveArray(Item),
          nextCursor: t.optional(t.string),
        };
        fetchNext = {
          searchParams: { cursor: this.result.nextCursor },
        };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        // Next page contains a duplicate (id: '2') and a new one (id: '3')
        mockFetch.get('/items', {
          items: [
            { __typename: 'Item', id: '2', name: 'second-updated' },
            { __typename: 'Item', id: '3', name: 'third' },
          ],
          nextCursor: 'c2',
        });

        await relay.value!.__fetchNext();

        // Should have 3 items (not 4), id:'2' deduplicated
        expect(relay.value!.items).toHaveLength(3);
        // The existing item's data should be updated
        expect(relay.value!.items[1].name).toBe('second-updated');
        expect(relay.value!.items[2].name).toBe('third');
      });
    });
  });

  describe('Dynamic fetchNext via getFetchNext()', () => {
    it('should use fetchNext from getFetchNext() with literal values', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a', 'b'], page: 1 });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), page: t.number };

        getFetchNext() {
          return {
            searchParams: { page: 2, limit: 10 },
          };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        mockFetch.get('/items', { items: ['c'], page: 2 });

        await relay.value!.__fetchNext();

        const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
        expect(lastCall.url).toContain('page=2');
        expect(lastCall.url).toContain('limit=10');
      });
    });

    it('should support conditional fetchNext based on response', async () => {
      const { client, mockFetch } = getClient();
      let fetchCount = 0;

      mockFetch.get('/items', () => {
        fetchCount++;
        if (fetchCount === 1) {
          return { items: ['a'], hasMore: true, nextPage: 2 };
        }
        return { items: ['b'], hasMore: false, nextPage: undefined };
      });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), hasMore: t.boolean, nextPage: t.optional(t.number) };

        getFetchNext() {
          return {
            searchParams: { page: 2 },
          };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.hasMore).toBe(true);

        await relay.value!.__fetchNext();

        expect(relay.value!.hasMore).toBe(false);
        expect(relay.value!.nextPage).toBeUndefined();
      });
    });

    it('should support dynamic search params computed from response headers', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'], total: 5 });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), total: t.number };

        getFetchNext() {
          return {
            searchParams: { offset: 1 },
          };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        mockFetch.get('/items', { items: ['b'], total: 5 });

        await relay.value!.__fetchNext();

        const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
        expect(lastCall.url).toContain('offset=1');
      });
    });

    it('getFetchNext overrides static fetchNext', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'] });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string) };

        fetchNext = {
          searchParams: { page: 99 },
        };

        getFetchNext() {
          return {
            searchParams: { page: 2 },
          };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        mockFetch.get('/items', { items: ['b'] });

        await relay.value!.__fetchNext();

        const lastCall = mockFetch.calls[mockFetch.calls.length - 1];
        expect(lastCall.url).toContain('page=2');
        expect(lastCall.url).not.toContain('page=99');
      });
    });
  });

  describe('__hasNext', () => {
    it('should be true when cursor FieldRef resolves to a value', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'], nextCursor: 'c1' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextCursor: t.optional(t.string) };
        fetchNext = { searchParams: { cursor: this.result.nextCursor } };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__hasNext).toBe(true);

        // Fetch next page — cursor becomes undefined (last page)
        mockFetch.get('/items', { items: ['b'] });
        await relay.value!.__fetchNext();

        expect(relay.value!.__hasNext).toBe(false);
      });
    });

    it('should be true when url FieldRef resolves to a value', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'], nextUrl: '/items?page=2' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), nextUrl: t.optional(t.string) };
        fetchNext = { url: this.result.nextUrl };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__hasNext).toBe(true);

        mockFetch.get('/items?page=2', { items: ['b'], nextUrl: undefined });
        await relay.value!.__fetchNext();

        expect(relay.value!.__hasNext).toBe(false);
      });
    });

    it('should be false when no fetchNext is configured', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'] });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__hasNext).toBe(false);
      });
    });

    it('should be true with getFetchNext() returning a config', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'] });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string) };

        getFetchNext() {
          return { searchParams: { page: 2 } };
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__hasNext).toBe(true);
      });
    });

    it('should be false with getFetchNext() returning undefined', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'] });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string) };

        getFetchNext() {
          return undefined;
        }
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__hasNext).toBe(false);
      });
    });
  });

  describe('__isFetchingNext', () => {
    it('should be false initially and after fetchNext completes', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'], cursor: 'c1' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), cursor: t.optional(t.string) };
        fetchNext = { searchParams: { cursor: this.result.cursor } };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__isFetchingNext).toBe(false);

        mockFetch.get('/items', { items: ['b'], cursor: undefined });
        await relay.value!.__fetchNext();

        expect(relay.value!.__isFetchingNext).toBe(false);
      });
    });

    it('should be false when no fetchNext is configured', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a'] });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.__isFetchingNext).toBe(false);
      });
    });
  });

  describe('Edge cases', () => {
    it('should throw if fetchNext called before initial data loads', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: [] }, { delay: 100 });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string) };
        fetchNext = { searchParams: { page: 1 } };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);

        const instance = client.queryInstances.values().next().value!;
        expect(() => instance.fetchNext()).toThrow('Cannot call __fetchNext before initial data has loaded');

        await relay;
      });
    });

    it('should throw if fetchNext is not configured', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: [] });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string) };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        const instance = client.queryInstances.values().next().value!;
        await expect(instance.fetchNext()).rejects.toThrow('fetchNext is not configured');
      });
    });

    it('should deduplicate concurrent fetchNext calls', async () => {
      const { client, mockFetch } = getClient();
      let fetchCount = 0;
      mockFetch.get('/items', () => ({ items: [String(++fetchCount)], next: fetchCount }));

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), next: t.number };
        fetchNext = { searchParams: { page: 1 } };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        const countBefore = fetchCount;

        const p1 = relay.value!.__fetchNext();
        const p2 = relay.value!.__fetchNext();

        expect(p1).toBe(p2);

        await p1;
        expect(fetchCount).toBe(countBefore + 1);
      });
    });

    it('should handle network errors without corrupting state', async () => {
      const { client, mockFetch } = getClient();
      mockFetch.get('/items', { items: ['a', 'b'], cursor: 'c1' });

      class GetItems extends RESTQuery {
        path = '/items';
        result = { items: t.array(t.string), cursor: t.optional(t.string) };
        fetchNext = { searchParams: { cursor: this.result.cursor } };
      }

      await testWithClient(client, async () => {
        const relay = fetchQuery(GetItems);
        await relay;

        expect(relay.value!.items).toEqual(['a', 'b']);

        mockFetch.get('/items', null, { error: new Error('Network error') });

        await expect(relay.value!.__fetchNext()).rejects.toThrow('Network error');

        expect(relay.value!.items).toEqual(['a', 'b']);
        expect(relay.value!.cursor).toBe('c1');
      });
    });
  });
});
