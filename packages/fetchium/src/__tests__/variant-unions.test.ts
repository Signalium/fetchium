import { describe, it, expect } from 'vitest';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { parseValue } from '../parseEntities.js';
import { testWithClient, sleep, setupTestClient } from './utils.js';
import type { MutationEvent } from '../types.js';

/**
 * Union members sharing a typename dispatch on their `t.variant` field; the
 * typename stays the identity (cache key). Members must be unique by
 * (typename, variant), enforced at definition time.
 */

class TextPost extends Entity {
  __typename = t.typename('Post');
  id = t.id;
  kind = t.variant('text');
  body = t.string;
  likes = t.number;
}

class ThreadPost extends Entity {
  __typename = t.typename('Post');
  id = t.id;
  kind = t.variant('thread');
  title = t.string;
  likes = t.number;
}

const PostRow = t.union(t.entity(TextPost), t.entity(ThreadPost));

function compareLikes(a: unknown, b: unknown) {
  const left = a as { id: string; likes: number };
  const right = b as { id: string; likes: number };

  return right.likes - left.likes || String(left.id).localeCompare(String(right.id));
}

const emitters = new Map<string, (event: MutationEvent) => void>();

class LiveFeed extends RESTQuery {
  params = { user: t.string };
  path = '/feed';
  searchParams = { user: this.params.user };
  result = {
    items: t.liveArray([ThreadPost, TextPost] as Array<new () => ThreadPost | TextPost>, { sort: compareLikes }),
    cursor: t.optional(t.string),
  };

  getConfig() {
    return {
      staleTime: 60_000,
      subscribe: (onEvent: (event: MutationEvent) => void) => {
        const user = this.params.user as unknown as string;
        emitters.set(user, onEvent);
        return () => {
          emitters.delete(user);
        };
      },
    };
  }
}

/** Emit through the query's captured onEvent outside any reactive context. */
async function emit(user: string, event: MutationEvent): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => {
      const send = emitters.get(user);
      if (send === undefined) throw new Error(`no active subscription for ${user}`);
      send(event);
      resolve();
    }, 0);
  });
  await sleep(10);
}

function ids(relayValue: unknown): string[] {
  const value = relayValue as { items: Array<{ id: string }> };
  return value.items.map(item => String(item.id));
}

const threadRow = (id: string, likes: number) => ({
  __typename: 'Post',
  id,
  kind: 'thread',
  title: `Thread ${id}`,
  likes,
});

const textRow = (id: string, likes: number) => ({
  __typename: 'Post',
  id,
  kind: 'text',
  body: `Post ${id}`,
  likes,
});

describe('variant unions', () => {
  describe('definition guards', () => {
    // Construction rules are def-kind-agnostic, so these use plain shapes.
    // The entity path is covered by the liveArray and same-def tests.
    const TextShape = t.object({ __typename: t.typename('Post'), kind: t.variant('text'), body: t.string });

    it('throws on duplicate typenames without variants', () => {
      const A = t.object({ __typename: t.typename('Post'), body: t.string });
      const B = t.object({ __typename: t.typename('Post'), url: t.string });

      expect(() => t.union(A, B)).toThrow(/Duplicate typename value 'Post' in union/);
    });

    it('throws on duplicate typenames when liveArray entity classes lack variants', () => {
      class A extends Entity {
        __typename = t.typename('Post');
        id = t.id;
        body = t.string;
      }
      class B extends Entity {
        __typename = t.typename('Post');
        id = t.id;
        url = t.string;
      }

      expect(() => t.liveArray([A, B] as Array<new () => A | B>)).toThrow(/Duplicate typename value 'Post' in union/);
    });

    it('throws on a duplicate (typename, variant) pair', () => {
      const OtherTextShape = t.object({ __typename: t.typename('Post'), kind: t.variant('text'), text: t.string });

      expect(() => t.union(TextShape, OtherTextShape)).toThrow(/Duplicate variant value 'text' for typename 'Post'/);
    });

    it('throws when variants of one typename use different fields', () => {
      const FlavorShape = t.object({ __typename: t.typename('Post'), flavor: t.variant('link'), url: t.string });

      expect(() => t.union(TextShape, FlavorShape)).toThrow(/Union variant field conflict/);
    });

    it('throws when a typename mixes variant and non-variant members', () => {
      const PlainShape = t.object({ __typename: t.typename('Post'), body: t.string });

      expect(() => t.union(TextShape, PlainShape)).toThrow(/Duplicate typename value 'Post' in union/);
      expect(() => t.union(PlainShape, TextShape)).toThrow(/Duplicate typename value 'Post' in union/);
    });

    it('throws on a duplicate variant field within one definition', () => {
      expect(() =>
        t.object({ __typename: t.typename('Post'), kind: t.variant('text'), other: t.variant('link') }),
      ).toThrow(/Duplicate variant field: other/);
    });

    it('allows the same definition to appear twice', () => {
      expect(() => t.union(t.entity(TextPost), t.entity(TextPost))).not.toThrow();
    });
  });

  describe('parse dispatch', () => {
    it('dispatches each payload to the member matching its variant', () => {
      const text = parseValue(textRow('p1', 1), PostRow, '');
      expect((text as { body: string }).body).toBe('Post p1');

      const thread = parseValue(threadRow('t1', 3), PostRow, '');
      expect((thread as { title: string }).title).toBe('Thread t1');
    });

    it('validates fields against the resolved variant, not another member', () => {
      // 'text' variant requires body; title from the thread shape does not satisfy it
      expect(() =>
        parseValue({ __typename: 'Post', id: 'p1', kind: 'text', title: 'Thread p1', likes: 1 }, PostRow, ''),
      ).toThrow(/body/);
    });

    it('throws a typed error for an unknown variant value', () => {
      expect(() => parseValue({ __typename: 'Post', id: 'p1', kind: 'poll', likes: 1 }, PostRow, '')).toThrow(
        /Unknown variant 'poll' for typename 'Post'/,
      );
    });

    it('throws a typed error when the variant field is missing', () => {
      expect(() => parseValue({ __typename: 'Post', id: 'p1', body: 'hi', likes: 1 }, PostRow, '')).toThrow(
        /Unknown variant 'undefined' for typename 'Post'/,
      );
    });

    it('degrades an optional union field to undefined on an unknown variant', () => {
      const Card = t.object({ pinned: t.optional(PostRow), label: t.string });

      const parsed = parseValue({ pinned: { __typename: 'Post', id: 'p1', kind: 'poll' }, label: 'ok' }, Card, '') as {
        pinned: unknown;
        label: string;
      };
      expect(parsed.pinned).toBeUndefined();
      expect(parsed.label).toBe('ok');
    });
  });

  describe('entity arrays declared as a single variant', () => {
    const getClient = setupTestClient();

    class PinnedFeed extends RESTQuery {
      path = '/pinned-feed';
      result = {
        rows: t.array(PostRow),
        pinned: t.array(t.entity(TextPost)),
      };
    }

    it('rejects a sibling-variant payload at parse, like any literal mismatch', async () => {
      const { client, mockFetch } = getClient();

      mockFetch.get('/pinned-feed', { rows: [], pinned: [textRow('p1', 1), threadRow('t1', 2)] });

      await testWithClient(client, async () => {
        const relay = fetchQuery(PinnedFeed);
        await relay;

        const value = relay.value as { pinned: Array<{ id: string }> };
        expect(value.pinned.map(p => String(p.id))).toEqual(['p1']);
      });
    });

    it('keeps array reads intact when sibling variant defs are registered', async () => {
      const { client, mockFetch } = getClient();

      mockFetch.get('/pinned-feed', {
        rows: [threadRow('t1', 300), textRow('p2', 100)],
        pinned: [textRow('p1', 1)],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(PinnedFeed);
        await relay;

        // `rows` parsed both variants, so 'Post' has two registered defs and
        // reading `pinned` goes through the multi-def array filter.
        const value = relay.value as { pinned: Array<{ id: string; body: string }> };
        expect(value.pinned.map(p => String(p.id))).toEqual(['p1']);
        expect(value.pinned[0].body).toBe('Post p1');
      });
    });
  });

  describe('live arrays over variant entities', () => {
    const getClient = setupTestClient();

    it('parses mixed variants from the initial page and routes membership events per variant', async () => {
      const { client, mockFetch } = getClient();

      mockFetch.get('/feed', {
        items: [threadRow('t1', 300), textRow('p1', 100)],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(LiveFeed, { user: 'u1' });
        await relay;

        // Both variants survive the initial parse
        expect(ids(relay.value)).toEqual(['t1', 'p1']);
        const items = (relay.value as { items: unknown[] }).items;
        expect(items[0]).toBeInstanceOf(ThreadPost);
        expect(items[1]).toBeInstanceOf(TextPost);

        // Create for the thread variant inserts
        await emit('u1', { type: 'create', typename: 'Post', data: threadRow('t2', 200) });
        expect(ids(relay.value)).toEqual(['t1', 't2', 'p1']);

        // Create for the text variant inserts
        await emit('u1', { type: 'create', typename: 'Post', data: textRow('p2', 50) });
        expect(ids(relay.value)).toEqual(['t1', 't2', 'p1', 'p2']);

        // Partial field update re-sorts without changing membership
        await emit('u1', {
          type: 'update',
          typename: 'Post',
          id: 'p1',
          data: { __typename: 'Post', id: 'p1', likes: 400 },
        });
        expect(ids(relay.value)).toEqual(['p1', 't1', 't2', 'p2']);

        // Delete removes regardless of variant
        await emit('u1', { type: 'delete', typename: 'Post', id: 't1', data: 't1' });
        expect(ids(relay.value)).toEqual(['p1', 't2', 'p2']);
      });
    });

    it('applies a create event for a variant absent from the initial page', async () => {
      const { client, mockFetch } = getClient();

      mockFetch.get('/feed', {
        items: [textRow('p1', 100)],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(LiveFeed, { user: 'u2' });
        await relay;

        expect(ids(relay.value)).toEqual(['p1']);

        // No thread row has been parsed yet; the def must already be
        // registered so the event parses against a complete merged def.
        await emit('u2', { type: 'create', typename: 'Post', data: threadRow('t1', 300) });

        expect(ids(relay.value)).toEqual(['t1', 'p1']);
        const items = (relay.value as { items: unknown[] }).items;
        expect(items[0]).toBeInstanceOf(ThreadPost);
        expect((items[0] as ThreadPost).title).toBe('Thread t1');
      });
    });
  });

  describe('multi-def typenames without variants', () => {
    const getClient = setupTestClient();

    // No union is involved for liveValue, so same-typename defs without
    // variants are allowed; events route to the first def the entity's
    // current data satisfies.
    class ReadingMetric extends Entity {
      __typename = t.typename('Metric');
      id = t.id;
      reading = t.number;
    }

    class StatusMetric extends Entity {
      __typename = t.typename('Metric');
      id = t.id;
      status = t.string;
    }

    class LiveMetrics extends RESTQuery {
      params = { user: t.string };
      path = '/metrics';
      searchParams = { user: this.params.user };
      result = {
        eventCount: t.liveValue(
          t.number,
          [ReadingMetric, StatusMetric] as Array<new () => ReadingMetric | StatusMetric>,
          {
            onCreate: (v: number) => v + 1,
            onUpdate: (v: number) => v,
            onDelete: (v: number) => v - 1,
          },
        ),
      };

      getConfig() {
        return {
          staleTime: 60_000,
          subscribe: (onEvent: (event: MutationEvent) => void) => {
            const user = this.params.user as unknown as string;
            emitters.set(user, onEvent);
            return () => {
              emitters.delete(user);
            };
          },
        };
      }
    }

    it('routes events for every def sharing the typename, not just the last', async () => {
      const { client, mockFetch } = getClient();

      mockFetch.get('/metrics', { eventCount: 0 });

      await testWithClient(client, async () => {
        const relay = fetchQuery(LiveMetrics, { user: 'm1' });
        await relay;

        const count = () => (relay.value as { eventCount: number }).eventCount;
        expect(count()).toBe(0);

        // Satisfies only the FIRST def; previously the binding kept only the
        // last def per typename, so this event was silently dropped.
        await emit('m1', { type: 'create', typename: 'Metric', data: { __typename: 'Metric', id: 'r1', reading: 10 } });
        expect(count()).toBe(1);

        await emit('m1', {
          type: 'create',
          typename: 'Metric',
          data: { __typename: 'Metric', id: 's1', status: 'ok' },
        });
        expect(count()).toBe(2);

        await emit('m1', { type: 'delete', typename: 'Metric', id: 'r1', data: 'r1' });
        expect(count()).toBe(1);
      });
    });
  });
});
