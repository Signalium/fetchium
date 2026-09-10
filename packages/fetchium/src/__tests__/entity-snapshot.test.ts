import { describe, it, expect } from 'vitest';
import { watcher, withContexts } from 'signalium';
import { hashValue, snapshot } from 'signalium/utils';
import {
  __debug_resetSnapshotCounters,
  __debug_snapshotFieldReads,
  __debug_snapshotFullWalks,
} from '../EntityInstance.js';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { setupTestClient } from './utils.js';

/**
 * Entity Snapshot Tests
 *
 * `useQuery` -> `useReactive` deep-snapshots the query result so React sees a
 * plain, structurally-shared object tree. These tests pin the contract that
 * walk relies on: the snapshot's key set matches the proxy's own enumerable
 * keys, nothing proxied leaks into the result, and unchanged subtrees keep
 * their identity across re-snapshots.
 */

/**
 * Holds a `useReactive`-style snapshot signal open for the whole test, so
 * mutation events can be applied between reads. `testWithClient` can't be used
 * here: it runs its body as one reactive consumer, and dirtying a signal that
 * consumer already read is an error.
 */
function snapshotHarness<T>(client: QueryClient, start: () => T) {
  return withContexts([[QueryClientContext, client]], () => {
    const query = start();
    let prev: unknown;
    const snapshots = watcher(() => (prev = snapshot(query, prev)));
    snapshots.addListener(() => {});
    return {
      query,
      /** The snapshot of the resolved query result, as a component would see it. */
      read: () => (snapshots.value as { value: Record<string, unknown> }).value,
    };
  });
}

function isProxyFree(value: unknown, path = '$'): void {
  if (value === null || typeof value !== 'object') return;
  const proto = Object.getPrototypeOf(value);
  expect(proto === Object.prototype || proto === Array.prototype || value instanceof Date, `${path} is plain`).toBe(
    true,
  );
  if (value instanceof Date) return;
  for (const key of Object.keys(value)) {
    isProxyFree((value as Record<string, unknown>)[key], `${path}.${key}`);
  }
}

class Token extends Entity {
  __typename = t.typename('Token');
  id = t.id;
  symbol = t.string;
  price = t.number;
  metadata = t.object({ logo: t.string, tags: t.array(t.string) });

  doubled() {
    return (this as unknown as { price: number }).price * 2;
  }
}

class GetPortfolio extends RESTQuery {
  path = '/portfolio';
  result = { tokens: t.array(t.entity(Token)) };
}

function portfolio(count: number) {
  return {
    tokens: Array.from({ length: count }, (_, i) => ({
      __typename: 'Token',
      id: `tok-${i}`,
      symbol: `SYM${i}`,
      price: i,
      metadata: { logo: `logo-${i}.png`, tags: ['defi'] },
    })),
  };
}

describe('Entity Snapshots', () => {
  const getClient = setupTestClient();

  it("snapshots exactly the proxy's own enumerable keys", async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(1));

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await query;

    const result = query.value as unknown as Record<string, unknown>;
    const snap = read();

    expect(Object.keys(snap)).toEqual(Object.keys(result));

    const tokenProxy = (result.tokens as Record<string, unknown>[])[0];
    const tokenSnap = (snap.tokens as Record<string, unknown>[])[0];
    expect(Object.keys(tokenSnap)).toEqual(Object.keys(tokenProxy));

    // Entity methods are reported non-enumerable by the proxy, so they stay
    // out of the snapshot; the query's own methods are enumerable and stay in.
    expect(Object.keys(tokenSnap)).not.toContain('doubled');
    expect(typeof snap.__refetch).toBe('function');
  });

  it('produces a plain, proxy-free tree', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(3));

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await query;

    const snap = read();
    isProxyFree(snap.tokens, '$.tokens');
    expect((snap.tokens as Record<string, unknown>[])[1]).toEqual({
      __typename: 'Token',
      id: 'tok-1',
      symbol: 'SYM1',
      price: 1,
      metadata: { logo: 'logo-1.png', tags: ['defi'] },
    });
  });

  it('keeps unchanged entities and nested subtrees identical across re-snapshots', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(5));

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await query;

    const before = read();
    const beforeTokens = before.tokens as Record<string, unknown>[];

    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-2', price: 999 } });

    const after = read();
    const afterTokens = after.tokens as Record<string, unknown>[];

    expect(after).not.toBe(before);
    expect(afterTokens[2]).not.toBe(beforeTokens[2]);
    expect(afterTokens[2].price).toBe(999);
    // The changed entity's untouched nested object keeps its identity...
    expect(afterTokens[2].metadata).toBe(beforeTokens[2].metadata);
    // ...and so does every entity that didn't change.
    for (const i of [0, 1, 3, 4]) {
      expect(afterTokens[i], `token ${i}`).toBe(beforeTokens[i]);
    }
  });

  it('re-snapshots an ancestor when only a nested entity changes', async () => {
    const { client, mockFetch } = getClient();

    class Holder extends Entity {
      __typename = t.typename('Holder');
      id = t.id;
      label = t.string;
      token = t.entity(Token);
    }
    class GetHolder extends RESTQuery {
      path = '/holder';
      result = { holder: t.entity(Holder) };
    }

    mockFetch.get('/holder', {
      holder: {
        __typename: 'Holder',
        id: 'h-1',
        label: 'first',
        token: { __typename: 'Token', id: 'tok-9', symbol: 'SYM9', price: 9, metadata: { logo: 'l', tags: [] } },
      },
    });

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetHolder));
    await query;

    const before = read() as unknown as { holder: { label: string; token: { price: number } } };
    const beforeHolder = before.holder;

    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-9', price: 42 } });

    const after = read() as unknown as { holder: { label: string; token: { price: number } } };

    expect(after.holder).not.toBe(beforeHolder);
    expect(after.holder.token.price).toBe(42);
    expect(after.holder.label).toBe('first');
  });

  it('unwraps formatted values and keeps method identity stable', async () => {
    const { client, mockFetch } = getClient();

    class Position extends Entity {
      __typename = t.typename('Position');
      id = t.id;
      opened = t.format('date-time');
    }
    class GetPosition extends RESTQuery {
      path = '/position';
      result = { position: t.entity(Position) };
    }

    mockFetch.get('/position', {
      position: { __typename: 'Position', id: 'p-1', opened: '2026-01-01T00:00:00.000Z' },
    });

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetPosition));
    await query;

    const before = read();
    const beforePosition = before.position as Record<string, unknown>;
    expect(beforePosition.opened).toBeInstanceOf(Date);
    expect((beforePosition.opened as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');

    client.applyMutationEvent({
      type: 'update',
      typename: 'Position',
      data: { id: 'p-1', opened: '2026-01-02T00:00:00.000Z' },
    });

    const after = read();
    const afterPosition = after.position as Record<string, unknown>;
    expect(afterPosition.opened).toBeInstanceOf(Date);
    expect((afterPosition.opened as Date).toISOString()).toBe('2026-01-02T00:00:00.000Z');
    expect(after.__refetch).toBe(before.__refetch);
  });

  it('reflects live-array membership changes in the parent snapshot', async () => {
    const { client, mockFetch } = getClient();

    class Message extends Entity {
      __typename = t.typename('Message');
      id = t.id;
      body = t.string;
      chatId = t.string;
    }
    class Chat extends Entity {
      __typename = t.typename('Chat');
      id = t.id;
      messages = t.liveArray(Message, { constraints: { chatId: (this as unknown as { id: string }).id } });
    }
    class GetChat extends RESTQuery {
      path = '/chat';
      result = { chat: t.entity(Chat) };
    }

    mockFetch.get('/chat', {
      chat: {
        __typename: 'Chat',
        id: 'c-1',
        messages: [{ __typename: 'Message', id: 'm-1', body: 'hi', chatId: 'c-1' }],
      },
    });

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetChat));
    await query;

    const before = read() as unknown as { chat: { messages: { id: string }[] } };
    expect(before.chat.messages).toHaveLength(1);

    client.applyMutationEvent({
      type: 'create',
      typename: 'Message',
      data: { __typename: 'Message', id: 'm-2', body: 'there', chatId: 'c-1' },
    });

    const after = read() as unknown as { chat: { messages: { id: string }[] } };
    expect(after.chat.messages.map(m => m.id)).toEqual(['m-1', 'm-2']);
  });

  it('keeps existing rows identical when a sorted live array gains a row that sorts first', async () => {
    const { client, mockFetch } = getClient();

    class Event extends Entity {
      __typename = t.typename('Event');
      id = t.id;
      feedId = t.string;
      at = t.number;
    }
    class Feed extends Entity {
      __typename = t.typename('Feed');
      id = t.id;
      events = t.liveArray(Event, {
        constraints: { feedId: (this as unknown as { id: string }).id },
        sort: (a: { at: number }, b: { at: number }) => b.at - a.at,
      });
    }
    class GetFeed extends RESTQuery {
      path = '/feed';
      result = { feed: t.entity(Feed) };
    }

    mockFetch.get('/feed', {
      feed: {
        __typename: 'Feed',
        id: 'f-1',
        events: [
          { __typename: 'Event', id: 'e-2', feedId: 'f-1', at: 2 },
          { __typename: 'Event', id: 'e-1', feedId: 'f-1', at: 1 },
        ],
      },
    });

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetFeed));
    await query;

    const before = read() as unknown as { feed: { events: { id: string }[] } };
    expect(before.feed.events.map(e => e.id)).toEqual(['e-2', 'e-1']);

    client.applyMutationEvent({
      type: 'create',
      typename: 'Event',
      data: { __typename: 'Event', id: 'e-3', feedId: 'f-1', at: 3 },
    });

    const after = read() as unknown as { feed: { events: { id: string }[] } };
    expect(after.feed.events.map(e => e.id)).toEqual(['e-3', 'e-2', 'e-1']);

    // Signalium pairs array items with the previous array's item at the same
    // index, so after the insert every row is diffed against its neighbour's
    // snapshot. Existing rows must still keep their identity.
    expect(after.feed.events[1]).toBe(before.feed.events[0]);
    expect(after.feed.events[2]).toBe(before.feed.events[1]);
  });

  it('gives each consumer its own snapshot tree', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(2));

    const first = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await first.query;
    const second = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await second.query;

    const a = first.read();
    const b = second.read();

    expect(a).not.toBe(b);
    expect((a.tokens as unknown[])[0]).not.toBe((b.tokens as unknown[])[0]);
    expect(a).toEqual(b);
  });

  it('propagates an update to a field the entity shares with nothing else', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(2));

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await query;

    const before = read();
    const beforeTokens = before.tokens as Record<string, unknown>[];

    // Two updates in a row: the second must not be swallowed by a snapshot
    // that already decided the entity was unchanged.
    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-0', symbol: 'FIRST' } });
    const middle = read();
    expect((middle.tokens as Record<string, unknown>[])[0].symbol).toBe('FIRST');

    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-0', symbol: 'SECOND' } });
    const after = read();
    const afterTokens = after.tokens as Record<string, unknown>[];

    expect(afterTokens[0].symbol).toBe('SECOND');
    expect(afterTokens[1]).toBe(beforeTokens[1]);
  });

  it('re-reads nested entities behind wrappers, plain objects and arrays', async () => {
    const { client, mockFetch } = getClient();

    // Shapes modelled on a real schema: primitive unions and enums collapse to
    // bare masks, while an entity can sit behind optional/nullable wrappers,
    // inside a plain object, or inside an array. Only the entity-bearing
    // fields may be re-read from a version short-circuit, so a misjudgement
    // here shows up as a nested entity update that never reaches the parent.
    const NumberLike = t.union(t.string, t.number);
    const OptionalNullableString = t.optional(t.nullable(t.string));

    class Row extends Entity {
      __typename = t.typename('Row');
      id = t.id;
      count = NumberLike;
      label = OptionalNullableString;
      kind = t.enum('up', 'down', 'pending');
      deep = t.object({ a: t.string, inner: t.object({ items: t.array(t.object({ x: t.number })) }) });
      wrapped = t.optional(t.nullable(t.entity(Token)));
      boxed = t.object({ note: t.string, child: t.optional(t.nullable(t.entity(Token))) });
      list = t.array(t.entity(Token));
    }
    class GetRow extends RESTQuery {
      path = '/row';
      result = { row: t.entity(Row) };
    }

    const tok = (id: string, price: number) => ({
      __typename: 'Token',
      id,
      symbol: id.toUpperCase(),
      price,
      metadata: { logo: `${id}.png`, tags: ['defi'] },
    });

    mockFetch.get('/row', {
      row: {
        __typename: 'Row',
        id: 'r-1',
        count: '7',
        label: null,
        kind: 'up',
        deep: { a: 'x', inner: { items: [{ x: 1 }] } },
        wrapped: tok('w', 1),
        boxed: { note: 'n', child: tok('b', 2) },
        list: [tok('l', 3)],
      },
    });

    type Snap = {
      row: {
        count: string | number;
        deep: { inner: { items: { x: number }[] } };
        wrapped: { price: number };
        boxed: { note: string; child: { price: number } };
        list: { price: number }[];
      };
    };

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetRow));
    await query;

    const before = read() as unknown as Snap;
    expect(before.row.wrapped.price).toBe(1);
    expect(before.row.boxed.child.price).toBe(2);
    expect(before.row.list[0].price).toBe(3);

    // Each of these changes only a child entity — Row itself never notifies.
    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'w', price: 11 } });
    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'b', price: 22 } });
    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'l', price: 33 } });

    const after = read() as unknown as Snap;
    expect(after.row.wrapped.price).toBe(11);
    expect(after.row.boxed.child.price).toBe(22);
    expect(after.row.list[0].price).toBe(33);
    // The parent's own inert fields are untouched, and the plain-object subtree
    // that changed nothing keeps its identity.
    expect(after.row.count).toBe('7');
    expect(after.row.deep).toBe(before.row.deep);
    expect(after.row.boxed.note).toBe('n');
  });

  it('re-reads the parent when its own inert fields change', async () => {
    const { client, mockFetch } = getClient();

    const NumberLike = t.union(t.string, t.number);

    class Row extends Entity {
      __typename = t.typename('Row');
      id = t.id;
      count = NumberLike;
      kind = t.enum('up', 'down', 'pending');
      deep = t.object({ inner: t.object({ items: t.array(t.object({ x: t.number })) }) });
    }
    class GetRow extends RESTQuery {
      path = '/row';
      result = { row: t.entity(Row) };
    }

    mockFetch.get('/row', {
      row: { __typename: 'Row', id: 'r-1', count: '7', kind: 'up', deep: { inner: { items: [{ x: 1 }] } } },
    });

    type Snap = { row: { count: string | number; kind: string; deep: { inner: { items: { x: number }[] } } } };

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetRow));
    await query;
    const before = read() as unknown as Snap;

    client.applyMutationEvent({
      type: 'update',
      typename: 'Row',
      data: { id: 'r-1', count: 9, kind: 'down', deep: { inner: { items: [{ x: 2 }] } } },
    });

    const after = read() as unknown as Snap;
    expect(after.row.count).toBe(9);
    expect(after.row.kind).toBe('down');
    expect(after.row.deep.inner.items[0].x).toBe(2);
    expect(after.row.deep).not.toBe(before.row.deep);
  });

  it('re-reads only the entity that changed, not the whole list', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(20));

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await query;

    __debug_resetSnapshotCounters();
    read();
    const firstWalks = __debug_snapshotFullWalks;
    const firstReads = __debug_snapshotFieldReads;
    // The root plus every token.
    expect(firstWalks).toBe(21);

    __debug_resetSnapshotCounters();
    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-7', price: 777 } });
    read();

    // The root's own data didn't change, so it re-reads only its dynamic
    // fields; of the 20 tokens only tok-7 is walked. Nothing here is asserted
    // by the behavioral tests — losing the fast path keeps them all green.
    expect(__debug_snapshotFullWalks).toBe(1);
    expect(__debug_snapshotFieldReads).toBeLessThan(firstReads / 5);
  });

  // TODO: drop this once `signalium/utils` exports its structural walkers and
  // `snapshotRawValue` can call them instead of reimplementing them.
  it('walks nested plain data the same way Signalium would', async () => {
    const { client, mockFetch } = getClient();

    // `snapshotRawValue` reimplements Signalium's unexported array and object
    // walks. If the two ever diverge, structural sharing silently changes and
    // only a re-render profile would show it.
    class Doc extends Entity {
      __typename = t.typename('Doc');
      id = t.id;
      body = t.object({
        title: t.string,
        tags: t.array(t.string),
        sections: t.array(t.object({ heading: t.string, lines: t.array(t.string) })),
      });
    }
    class GetDoc extends RESTQuery {
      path = '/doc';
      result = { doc: t.entity(Doc) };
    }

    const raw = (title: string) => ({
      title,
      tags: ['a', 'b'],
      sections: [
        { heading: 'one', lines: ['x'] },
        { heading: 'two', lines: ['y', 'z'] },
      ],
    });

    mockFetch.get('/doc', { doc: { __typename: 'Doc', id: 'd-1', body: raw('first') } });

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetDoc));
    await query;

    type Body = { title: string; tags: string[]; sections: { heading: string; lines: string[] }[] };
    const ours = (read().doc as { body: Body }).body;
    const theirs = snapshot(raw('first'), undefined) as Body;
    expect(ours).toEqual(theirs);

    // Same structural sharing on a change: the untouched subtrees keep
    // identity in both implementations, the changed one does not.
    client.applyMutationEvent({ type: 'update', typename: 'Doc', data: { id: 'd-1', body: raw('second') } });
    const oursNext = (read().doc as { body: Body }).body;
    const theirsNext = snapshot(raw('second'), theirs) as Body;

    expect(oursNext).toEqual(theirsNext);
    expect(oursNext).not.toBe(ours);
    expect(theirsNext).not.toBe(theirs);
    expect(oursNext.tags === ours.tags).toBe(theirsNext.tags === theirs.tags);
    expect(oursNext.sections === ours.sections).toBe(theirsNext.sections === theirs.sections);
    expect(oursNext.sections[0] === ours.sections[0]).toBe(theirsNext.sections[0] === theirs.sections[0]);
  });

  it('pairs entities by identity even when a preceding slot holds no entity', async () => {
    const { client, mockFetch } = getClient();

    class Slot extends Entity {
      __typename = t.typename('Slot');
      id = t.id;
      label = t.string;
    }
    class Board extends Entity {
      __typename = t.typename('Board');
      id = t.id;
      slots = t.array(t.optional(t.nullable(t.entity(Slot))));
    }
    class GetBoard extends RESTQuery {
      path = '/board';
      result = { board: t.entity(Board) };
    }

    const slot = (id: string) => ({ __typename: 'Slot', id, label: id });
    mockFetch.get('/board', {
      board: { __typename: 'Board', id: 'b-1', slots: [null, slot('s-1'), slot('s-2')] },
    });

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetBoard));
    await query;

    type Snap = { board: { slots: ({ id: string } | null)[] } };
    const before = read() as unknown as Snap;
    expect(before.board.slots.map(s => s?.id ?? null)).toEqual([null, 's-1', 's-2']);

    // Dropping the empty leading slot shifts both entities left, and the slot
    // they land on previously held `null` rather than a sibling's snapshot.
    mockFetch.get('/board', {
      board: { __typename: 'Board', id: 'b-1', slots: [slot('s-1'), slot('s-2')] },
    });
    (query.value as unknown as { __refetch(): void }).__refetch();
    await query;

    const after = read() as unknown as Snap;
    expect(after.board.slots.map(s => s?.id ?? null)).toEqual(['s-1', 's-2']);
    expect(after.board.slots[0]).toBe(before.board.slots[1]);
    expect(after.board.slots[1]).toBe(before.board.slots[2]);
  });

  it('throws in dev when a field changes without the version moving', async () => {
    const { client, mockFetch } = getClient();
    mockFetch.get('/portfolio', portfolio(2));

    const { query, read } = snapshotHarness(client, () => fetchQuery(GetPortfolio));
    await query;
    read();

    // The failure the fast path cannot otherwise detect: `data` changed without
    // a notify, or a field wrongly judged static. Touching a sibling is what
    // makes the snapshot recompute; tok-0 then takes the fast path while its
    // version still claims nothing moved.
    const instance = client.entityMap.getEntity(hashValue(['Token', 'tok-0']))!;
    const original = instance.data.symbol;
    instance.data.symbol = 'MUTATED';
    client.applyMutationEvent({ type: 'update', typename: 'Token', data: { id: 'tok-1', price: 5 } });

    expect(() => read()).toThrow(/stale entity snapshot/);

    // Put the entity back and let the version move, so the watcher's own
    // recompute doesn't rethrow after the test has finished.
    instance.data.symbol = original;
    instance.notify();
    read();
  });
});
