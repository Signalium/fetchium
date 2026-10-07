/* eslint-disable @typescript-eslint/no-unused-expressions */
import { describe, it, expect, afterEach } from 'vitest';
import { signal, watcher, withContexts } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { t } from '../typeDefs.js';
import { fetchQuery } from '../query.js';
import { createMockFetch, sleep } from './utils.js';

// Latency in macrotask turns: each turn drains microtasks, checks, then yields one setTimeout(0).
// Turn 0 means no timer ran. On React Native a zero timer can wait a frame.

async function flushMicrotasks(count = 30): Promise<void> {
  for (let i = 0; i < count; i++) await Promise.resolve();
}

async function turnsUntil(cond: () => boolean, max = 10): Promise<number> {
  for (let turn = 0; turn <= max; turn++) {
    await flushMicrotasks();
    if (cond()) return turn;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  return Infinity;
}

class GetItem extends RESTQuery {
  path = '/item';
  result = { n: t.number };
  config = { staleTime: 0 };
}

class GetFreshItem extends RESTQuery {
  path = '/fresh';
  result = { n: t.number };
  config = { staleTime: 60_000 };
}

class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { n: t.number };
}

let clients: QueryClient[] = [];

afterEach(() => {
  for (const c of clients) c.destroy();
  clients = [];
});

function setup() {
  const mockFetch = createMockFetch();
  let n = 0;
  mockFetch.get('/item', () => ({ n: ++n }));
  mockFetch.get('/fresh', () => ({ n: ++n }));
  mockFetch.get('/users/[id]', () => ({ n: ++n }));
  const client = new QueryClient({
    store: new SyncQueryStore(new MemoryPersistentStore()),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
  });
  clients.push(client);
  return { client, mockFetch };
}

function watchNow<T>(client: QueryClient, read: () => T): { w: { value: T }; unsub: () => void } {
  const w = withContexts([[QueryClientContext, client]], () => watcher(read));
  const unsub = w.addListener(() => {});
  w.value;
  return { w: w as { value: T }, unsub };
}

async function loadThenDeactivate(client: QueryClient, Q: new () => RESTQuery): Promise<void> {
  const { unsub } = watchNow(client, () => fetchQuery(Q as any).value);
  await sleep(10);
  unsub();
  // Let Signalium's deactivation flush run.
  await sleep(10);
}

describe('read-path latency (macrotask turns)', () => {
  it('cold miss: the first fetch starts without a macrotask', async () => {
    const { client, mockFetch } = setup();
    const started = performance.now();
    const { unsub } = watchNow(client, () => fetchQuery(GetItem).value);
    const turns = await turnsUntil(() => mockFetch.calls.length === 1);
    console.log(`[latency] cold miss -> fetch start: ${turns} turns, ${(performance.now() - started).toFixed(2)} ms`);
    expect(turns).toBe(0);
    unsub();
  });

  it('in-memory cache hit: the value is readable in the activating read', async () => {
    const { client, mockFetch } = setup();
    await loadThenDeactivate(client, GetFreshItem);
    expect(mockFetch.calls).toHaveLength(1);

    const { w, unsub } = watchNow(client, () => fetchQuery(GetFreshItem).value);
    expect(w.value).toMatchObject({ n: 1 });
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);
    unsub();
  });

  it('stale reactivation: the refetch starts without a macrotask', async () => {
    const { client, mockFetch } = setup();
    await loadThenDeactivate(client, GetItem);
    expect(mockFetch.calls).toHaveLength(1);

    const started = performance.now();
    const { w, unsub } = watchNow(client, () => fetchQuery(GetItem).value);
    expect(w.value).toMatchObject({ n: 1 });
    const turns = await turnsUntil(() => mockFetch.calls.length === 2);
    console.log(
      `[latency] stale reactivation -> refetch start: ${turns} turns, ${(performance.now() - started).toFixed(2)} ms`,
    );
    expect(turns).toBe(0);
    unsub();
  });

  it('staggered reactivation: the first refetch starts in the stagger flush', async () => {
    const mockFetch = createMockFetch();
    let n = 0;
    mockFetch.get('/item', () => ({ n: ++n }));
    const client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
      reactivationStaggerMs: 300,
    });
    clients.push(client);
    await loadThenDeactivate(client, GetItem);

    const started = performance.now();
    const { unsub } = watchNow(client, () => fetchQuery(GetItem).value);
    const turns = await turnsUntil(() => mockFetch.calls.length === 2);
    console.log(
      `[latency] staggered reactivation -> first refetch start: ${turns} turns, ${(performance.now() - started).toFixed(2)} ms`,
    );
    // One timer for the stagger flush.
    expect(turns).toBe(1);
    unsub();
  });

  it('Signal param change: the new fetch starts in the flush that applies it', async () => {
    const { client, mockFetch } = setup();
    const id = signal(1);
    const { w, unsub } = watchNow(client, () => fetchQuery(GetUser, { id }).value);
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);

    const started = performance.now();
    id.value = 2;
    w.value;
    const turns = await turnsUntil(() => mockFetch.calls.length === 2);
    console.log(
      `[latency] param change -> fetch start: ${turns} turns, ${(performance.now() - started).toFixed(2)} ms`,
    );
    // One timer for Signalium's flush. The fetch starts on its microtask.
    expect(turns).toBe(1);
    expect(mockFetch.calls[1].url).toContain('/users/2');
    unsub();
  });

  it('coalesces zero-delay refetches requested in the same task', async () => {
    const { client, mockFetch } = setup();
    const id = signal(1);
    const { w, unsub } = watchNow(client, () => fetchQuery(GetUser, { id }).value);
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(1);

    id.value = 2;
    w.value;
    id.value = 3;
    w.value;
    await sleep(10);
    expect(mockFetch.calls).toHaveLength(2);
    expect(mockFetch.calls[1].url).toContain('/users/3');
    unsub();
  });

  it('a deactivation in the same task aborts the zero-delay refetch', async () => {
    const { client, mockFetch } = setup();
    await loadThenDeactivate(client, GetItem);
    mockFetch.reset();
    mockFetch.get('/item', { n: 2 }, { delay: 30 });
    const { unsub } = watchNow(client, () => fetchQuery(GetItem).value);
    unsub();
    await sleep(10);
    // Deactivation lands a timer after the refetch's microtask started it.
    // Accepted to avoid a timer on every reactivation.
    expect(mockFetch.calls).toHaveLength(1);
    expect(mockFetch.calls[0].options.signal?.aborted).toBe(true);
    await sleep(30);
  });
});
