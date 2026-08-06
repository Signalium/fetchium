import { describe, it, expect } from 'vitest';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { parseValue } from '../parseEntities.js';
import { generateEntityData } from '../testing/auto-generate.js';
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

  describe('union composition', () => {
    const Text = t.object({ __typename: t.typename('Media'), kind: t.variant('text'), body: t.string });
    const Link = t.object({ __typename: t.typename('Media'), kind: t.variant('link'), url: t.string });
    const Gallery = t.object({ __typename: t.typename('Media'), kind: t.variant('gallery'), count: t.number });

    it('does not mutate an inner union composed into an outer union', () => {
      const Inner = t.union(Text, Link);
      const Outer = t.union(Inner, Gallery);

      const gallery = parseValue({ __typename: 'Media', kind: 'gallery', count: 2 }, Outer, '');
      expect((gallery as { count: number }).count).toBe(2);
      const text = parseValue({ __typename: 'Media', kind: 'text', body: 'hi' }, Outer, '');
      expect((text as { body: string }).body).toBe('hi');

      // the inner union must not gain the outer union's variant
      expect(() => parseValue({ __typename: 'Media', kind: 'gallery', count: 2 }, Inner, '')).toThrow(
        /Unknown variant 'gallery'/,
      );
    });

    it('composes in either order', () => {
      const Inner = t.union(Text, Link);
      const Outer = t.union(Gallery, Inner);

      const link = parseValue({ __typename: 'Media', kind: 'link', url: 'https://example.com' }, Outer, '');
      expect((link as { url: string }).url).toBe('https://example.com');
    });

    it('merges variant groups from two nested unions, with duplicate checks', () => {
      const A = t.union(Text, Gallery);
      const B = t.union(Link, Gallery); // sharing the same def is allowed
      const Merged = t.union(A, B);

      const link = parseValue({ __typename: 'Media', kind: 'link', url: 'https://example.com' }, Merged, '');
      expect((link as { url: string }).url).toBe('https://example.com');
      const text = parseValue({ __typename: 'Media', kind: 'text', body: 'hi' }, Merged, '');
      expect((text as { body: string }).body).toBe('hi');

      const OtherText = t.object({ __typename: t.typename('Media'), kind: t.variant('text'), words: t.string });
      expect(() => t.union(A, t.union(OtherText, Gallery))).toThrow(/Duplicate variant value 'text'/);
    });

    it('auto-generates data for variant-union fields', () => {
      class Widget extends Entity {
        __typename = t.typename('Widget');
        id = t.id;
        media = t.union(Text, Link);
      }

      const data = generateEntityData(Widget);
      const media = data.media as Record<string, unknown>;
      expect(media.kind).toBe('text');
      expect(typeof media.body).toBe('string');
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

  describe('variant gating with overlapping field profiles', () => {
    const getClient = setupTestClient();

    // Three variants with identical field profiles, so presence checks alone
    // cannot tell them apart; only the tag's value can.
    class InMessage extends Entity {
      __typename = t.typename('Message');
      id = t.id;
      dir = t.variant('in');
      text = t.string;
    }

    class OutMessage extends Entity {
      __typename = t.typename('Message');
      id = t.id;
      dir = t.variant('out');
      text = t.string;
    }

    class SysMessage extends Entity {
      __typename = t.typename('Message');
      id = t.id;
      dir = t.variant('sys');
      text = t.string;
    }

    class Mailbox extends RESTQuery {
      params = { user: t.string };
      path = '/mailbox';
      searchParams = { user: this.params.user };
      result = {
        inbox: t.liveArray(InMessage),
        all: t.liveArray([InMessage, OutMessage] as Array<new () => InMessage | OutMessage>),
        system: t.liveArray(SysMessage),
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

    const msg = (id: string, dir: string) => ({ __typename: 'Message', id, dir, text: `Message ${id}` });

    it('only admits events for variants the collection declares', async () => {
      const { client, mockFetch } = getClient();

      mockFetch.get('/mailbox', {
        inbox: [msg('i1', 'in')],
        all: [msg('i1', 'in'), msg('o1', 'out')],
        system: [],
      });

      await testWithClient(client, async () => {
        const relay = fetchQuery(Mailbox, { user: 'mb1' });
        await relay;

        const fieldIds = (field: string) =>
          (relay.value as unknown as Record<string, Array<{ id: string }>>)[field].map(m => String(m.id));

        expect(fieldIds('inbox')).toEqual(['i1']);
        expect(fieldIds('all')).toEqual(['i1', 'o1']);
        expect(fieldIds('system')).toEqual([]);

        // An out message matches InMessage's field profile but not its tag;
        // the single-def inbox must not admit it.
        await emit('mb1', { type: 'create', typename: 'Message', data: msg('o2', 'out') });
        expect(fieldIds('inbox')).toEqual(['i1']);
        expect(fieldIds('all')).toEqual(['i1', 'o1', 'o2']);
        expect(fieldIds('system')).toEqual([]);

        // A sys message is registered on the client but undeclared by the
        // multi-def collection; it must not fall through the satisfies gate.
        await emit('mb1', { type: 'create', typename: 'Message', data: msg('s1', 'sys') });
        expect(fieldIds('inbox')).toEqual(['i1']);
        expect(fieldIds('all')).toEqual(['i1', 'o1', 'o2']);
        expect(fieldIds('system')).toEqual(['s1']);

        // Declared variants still insert everywhere they belong.
        await emit('mb1', { type: 'create', typename: 'Message', data: msg('i2', 'in') });
        expect(fieldIds('inbox')).toEqual(['i1', 'i2']);
        expect(fieldIds('all')).toEqual(['i1', 'o1', 'o2', 'i2']);
        expect(fieldIds('system')).toEqual(['s1']);
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

    const reduced: string[] = [];
    const tag = (e: unknown) =>
      e instanceof ReadingMetric ? 'ReadingMetric' : e instanceof StatusMetric ? 'StatusMetric' : 'unknown';

    class LiveMetrics extends RESTQuery {
      params = { user: t.string };
      path = '/metrics';
      searchParams = { user: this.params.user };
      result = {
        eventCount: t.liveValue(
          t.number,
          [ReadingMetric, StatusMetric] as Array<new () => ReadingMetric | StatusMetric>,
          {
            onCreate: (v: number, e: unknown) => {
              reduced.push(`create:${tag(e)}`);
              return v + 1;
            },
            onUpdate: (v: number) => v,
            onDelete: (v: number, e: unknown) => {
              reduced.push(`delete:${tag(e)}`);
              return v - 1;
            },
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
      reduced.length = 0;

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

        await emit('m1', { type: 'delete', typename: 'Metric', id: 's1', data: 's1' });
        expect(count()).toBe(1);

        // Deletes resolve the def the same way creates do; previously they
        // fell back to the first def, handing onDelete the wrong class.
        expect(reduced).toEqual(['create:ReadingMetric', 'create:StatusMetric', 'delete:StatusMetric']);
      });
    });
  });
});
