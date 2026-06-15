import { describe, it, expect, afterEach } from 'vitest';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { QueryClient } from '../QueryClient.js';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { fetchQuery } from '../query.js';
import { testWithClient, sleep } from './utils.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import type { MutationEvent } from '../types.js';

/**
 * Unknown union variant: optional field degrades to undefined (apply the rest),
 * non-optional surfaces an error without applying partial state. Same on initial
 * load and live updates.
 */

class Stream {
  private sub: { onData: (d: unknown) => void; onEvent: (e: MutationEvent) => void } | undefined;
  private buffered: unknown[] = [];
  subscribe(cb: { onData: (d: unknown) => void; onEvent: (e: MutationEvent) => void }) {
    this.sub = cb;
    const pending = this.buffered;
    this.buffered = [];
    for (const d of pending) cb.onData(d);
    return () => {
      this.sub = undefined;
    };
  }
  pushData(data: unknown) {
    if (this.sub) this.sub.onData(data);
    else this.buffered.push(data);
  }
  pushEvent(event: MutationEvent) {
    this.sub?.onEvent(event);
  }
}

class MockAdapter extends TopicQueryAdapter {
  stream: Stream;
  private unsubs = new Map<string, () => void>();
  constructor(stream: Stream) {
    super();
    this.stream = stream;
  }
  subscribe(topic: string): void {
    this.unsubs.set(
      topic,
      this.stream.subscribe({
        onData: data => this.fulfillTopic(topic, data),
        onEvent: event => this.sendMutationEvent(event),
      }),
    );
  }
  unsubscribe(topic: string): void {
    this.unsubs.get(topic)?.();
    this.unsubs.delete(topic);
    this.clearTopic(topic);
  }
}

const StatusActive = t.object({ __typename: t.typename('StatusActive'), label: t.string });
const StatusClosed = t.object({ __typename: t.typename('StatusClosed'), closedAt: t.string });

class CardReq extends Entity {
  __typename = t.typename('CardReq');
  id = t.id;
  disabled = t.boolean;
  status = t.union(StatusActive, StatusClosed); // non-optional union
}

class CardOpt extends Entity {
  __typename = t.typename('CardOpt');
  id = t.id;
  disabled = t.boolean;
  status = t.optional(t.union(StatusActive, StatusClosed)); // optional union
}

class GetCardReq extends TopicQuery {
  static override adapter = MockAdapter;
  topic = 'card:req';
  result = t.entity(CardReq);
}

class GetCardOpt extends TopicQuery {
  static override adapter = MockAdapter;
  topic = 'card:opt';
  result = t.entity(CardOpt);
}

class GetCardReqLoad extends TopicQuery {
  static override adapter = MockAdapter;
  topic = 'card:reqload';
  result = t.entity(CardReq);
  // retry off so a parse-failed load rejects immediately, not after the backoff.
  override getConfig() {
    return { ...super.getConfig(), retry: false as const };
  }
}

function makeClient(stream: Stream) {
  const logs = { error: [] as unknown[][], warn: [] as unknown[][] };
  const client = new QueryClient({
    store: new SyncQueryStore(new MemoryPersistentStore()),
    adapters: [new MockAdapter(stream)],
    log: {
      error: (m: string, e?: unknown) => logs.error.push([m, e]),
      warn: (m: string, e?: unknown) => logs.warn.push([m, e]),
    },
  } as any);
  return { client, logs };
}

async function pushEventOutsideReactiveContext(stream: Stream, event: MutationEvent): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => {
      stream.pushEvent(event);
      resolve();
    }, 0);
  });
  await sleep(10);
}

const unknownVariantUpdate = (typename: string) => ({
  type: 'update' as const,
  typename,
  id: '1',
  data: { __typename: typename, id: '1', disabled: true, status: { __typename: 'StatusVoided', voidedAt: 'now' } },
});

describe('unknown union variant in a mutation event', () => {
  let client: QueryClient;
  afterEach(() => client?.destroy());

  it('non-optional union: does not apply partial state and surfaces an error', async () => {
    const stream = new Stream();
    const made = makeClient(stream);
    client = made.client;

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetCardReq);
      stream.pushData({
        __typename: 'CardReq',
        id: '1',
        disabled: false,
        status: { __typename: 'StatusActive', label: 'Open' },
      });
      await relay;
      expect((relay.value as any).disabled).toBe(false);

      await pushEventOutsideReactiveContext(stream, unknownVariantUpdate('CardReq'));

      const v: any = relay.value;
      // No partial state: sibling change not applied, but the drop is surfaced.
      expect(v.disabled).toBe(false);
      expect(v.status.__typename).toBe('StatusActive');
      expect(made.logs.error.length).toBe(1);
      expect(String(made.logs.error[0][0])).toMatch(/unknown union variant/i);
    });
  });

  it('optional union: degrades the field to undefined and applies the rest', async () => {
    const stream = new Stream();
    const made = makeClient(stream);
    client = made.client;

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetCardOpt);
      stream.pushData({
        __typename: 'CardOpt',
        id: '1',
        disabled: false,
        status: { __typename: 'StatusActive', label: 'Open' },
      });
      await relay;
      expect((relay.value as any).status.__typename).toBe('StatusActive');

      await pushEventOutsideReactiveContext(stream, unknownVariantUpdate('CardOpt'));

      const v: any = relay.value;
      // Sibling applies; the unknown-variant union degrades to undefined, no error.
      expect(v.disabled).toBe(true);
      expect(v.status).toBeUndefined();
      expect(made.logs.error.length).toBe(0);
    });
  });

  it('non-optional union on initial load: rejects the query, surfacing the error (no degrade, no partial state)', async () => {
    const stream = new Stream();
    const made = makeClient(stream);
    client = made.client;

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetCardReqLoad);
      stream.pushData({
        __typename: 'CardReq',
        id: '1',
        disabled: true,
        status: { __typename: 'StatusVoided', voidedAt: 'now' },
      });
      await expect(relay).rejects.toThrow(/Unknown typename 'StatusVoided'/);
      expect(relay.isRejected).toBe(true);
    });
  });

  it('optional union on initial load: unknown variant degrades to undefined, rest applies (parity with updates)', async () => {
    const stream = new Stream();
    const made = makeClient(stream);
    client = made.client;

    await testWithClient(client, async () => {
      const relay = fetchQuery(GetCardOpt);
      // First (and only) snapshot already carries an unknown variant.
      stream.pushData({
        __typename: 'CardOpt',
        id: '1',
        disabled: true,
        status: { __typename: 'StatusVoided', voidedAt: 'now' },
      });
      await relay;

      const v: any = relay.value;
      expect(v.disabled).toBe(true);
      expect(v.status).toBeUndefined();
      expect(made.logs.error.length).toBe(0);
    });
  });
});
