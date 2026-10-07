import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withContexts } from 'signalium';
import { RESTQuery, RESTQueryAdapter } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { t } from '../typeDefs.js';
import { QueryClient, QueryClientContext, type QueryClientConfig } from '../QueryClient.js';
import type { ActivitySource } from '../query-types.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { poll } from '../subscriptions/polling.js';
import { createMockFetch, createTestWatcher } from './utils.js';

/**
 * Focus-aware polling: with an `activity` source, poll() stops its timers
 * while the app is inactive, and spreads overdue ticks across
 * `pollResumeJitterMs` when it becomes active again.
 */

const INTERVAL = 1_000;

class GetPolled extends RESTQuery {
  path = '/polled';
  result = { n: t.number };
  config = { staleTime: Infinity, subscribe: poll({ interval: INTERVAL }) };
}

class GetPolledB extends RESTQuery {
  path = '/polled-b';
  result = { n: t.number };
  config = { staleTime: Infinity, subscribe: poll({ interval: INTERVAL }) };
}

class GetPolledOwnJitter extends RESTQuery {
  path = '/polled';
  result = { n: t.number };
  config = { staleTime: Infinity, subscribe: poll({ interval: INTERVAL, resumeJitterMs: 1_000 }) };
}

interface TestActivity extends ActivitySource {
  set(active: boolean): void;
  listenerCount(): number;
}

function createActivity(initial: boolean = true): TestActivity {
  let active = initial;
  const listeners = new Set<() => void>();
  return {
    isActive: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      active = next;
      for (const listener of [...listeners]) listener();
    },
    listenerCount: () => listeners.size,
  };
}

describe('poll() with an activity source', () => {
  let mockFetch: ReturnType<typeof createMockFetch>;
  let starts: Array<{ path: string; at: number }>;
  let clients: QueryClient[];
  let unsubs: Array<() => void>;
  let t0: number;

  beforeEach(() => {
    vi.useFakeTimers();
    mockFetch = createMockFetch();
    let n = 0;
    mockFetch.get('/polled', () => ({ n: ++n }));
    mockFetch.get('/polled-b', () => ({ n: ++n }));
    starts = [];
    clients = [];
    unsubs = [];
  });

  afterEach(async () => {
    for (const unsub of unsubs) unsub();
    for (const client of clients) client.destroy();
    // Drain signalium's pending flush on the fake clock before restoring real timers.
    await vi.advanceTimersByTimeAsync(1_000);
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeClient(config: Partial<QueryClientConfig> = {}): QueryClient {
    const client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [
        new RESTQueryAdapter({
          baseUrl: 'http://localhost',
          fetch: ((url: string, options?: RequestInit) => {
            starts.push({ path: new URL(url).pathname, at: Date.now() - t0 });
            return mockFetch(url, options);
          }) as typeof fetch,
        }),
      ],
      ...config,
    });
    clients.push(client);
    return client;
  }

  function watch(client: QueryClient, ...queries: Array<new () => RESTQuery>): () => void {
    const { unsub } = withContexts([[QueryClientContext, client]], () =>
      createTestWatcher(() => queries.map(Q => fetchQuery(Q as any).value)),
    );
    unsubs.push(unsub);
    return unsub;
  }

  /** Mounts the queries and lets the initial fetch settle; poll ticks are then due at INTERVAL. */
  async function mount(client: QueryClient, ...queries: Array<new () => RESTQuery>): Promise<() => void> {
    t0 = Date.now();
    const unsub = watch(client, ...queries);
    await vi.advanceTimersByTimeAsync(5);
    starts.length = 0;
    return unsub;
  }

  function count(path: string = '/polled'): number {
    return starts.filter(s => s.path === path).length;
  }

  it('polls as before when the client has no activity source', async () => {
    const client = makeClient();
    await mount(client, GetPolled);
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(count()).toBe(3);
  });

  it('stops polling while inactive', async () => {
    const activity = createActivity();
    const client = makeClient({ activity });
    await mount(client, GetPolled);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(count()).toBe(1);

    activity.set(false);
    await vi.advanceTimersByTimeAsync(10 * INTERVAL);
    expect(count()).toBe(1);
  });

  it('resumes a tick that is not yet due at its original time', async () => {
    const activity = createActivity();
    const client = makeClient({ activity, pollResumeJitterMs: 300 });
    await mount(client, GetPolled);

    // Due at ~1000; pause at 200, resume at 500.
    await vi.advanceTimersByTimeAsync(200);
    activity.set(false);
    await vi.advanceTimersByTimeAsync(300);
    activity.set(true);

    await vi.advanceTimersByTimeAsync(400);
    expect(count()).toBe(0);
    await vi.advanceTimersByTimeAsync(110);
    expect(count()).toBe(1);
    expect(starts[0].at).toBeGreaterThanOrEqual(INTERVAL);
    expect(starts[0].at).toBeLessThanOrEqual(INTERVAL + 10);
  });

  it('fires an overdue tick immediately on resume when no jitter is configured', async () => {
    const activity = createActivity();
    const client = makeClient({ activity });
    await mount(client, GetPolled);

    activity.set(false);
    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    expect(count()).toBe(0);

    const resumedAt = Date.now() - t0;
    activity.set(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(count()).toBe(1);
    expect(starts[0].at - resumedAt).toBeLessThanOrEqual(2);
  });

  it('spreads overdue ticks across the jitter window on resume', async () => {
    const random = vi.spyOn(Math, 'random');
    random.mockReturnValueOnce(0.1).mockReturnValueOnce(0.9);

    const activity = createActivity();
    const client = makeClient({ activity, pollResumeJitterMs: 300 });
    await mount(client, GetPolled, GetPolledB);

    activity.set(false);
    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    expect(starts).toHaveLength(0);

    const resumedAt = Date.now() - t0;
    activity.set(true);
    await vi.advanceTimersByTimeAsync(400);

    expect(starts.map(s => [s.path, s.at - resumedAt])).toEqual([
      ['/polled', 30],
      ['/polled-b', 270],
    ]);

    // Then back on the regular interval, from each tick.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(count('/polled')).toBe(2);
    expect(count('/polled-b')).toBe(2);
  });

  it('lets a poll override the client jitter window', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const activity = createActivity();
    const client = makeClient({ activity, pollResumeJitterMs: 300 });
    await mount(client, GetPolledOwnJitter);

    activity.set(false);
    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    const resumedAt = Date.now() - t0;
    activity.set(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(starts.map(s => s.at - resumedAt)).toEqual([500]);
  });

  it('jitters a tick whose timer fired late, as after JS timers were frozen in the background', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    // No activity source: lateness alone identifies the resume.
    const client = makeClient({ pollResumeJitterMs: 300 });
    await mount(client, GetPolled);

    // Jump the clock 10 s without running timers, as a frozen JS thread would.
    vi.setSystemTime(Date.now() + 10_000);
    const jumpedAt = Date.now() - t0;
    // The timer fires at its scheduled point (~INTERVAL - 5 from here) but doesn't fetch.
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(count()).toBe(0);
    // It fetches at the jitter point instead: 0.5 * 300.
    await vi.advanceTimersByTimeAsync(200);
    expect(count()).toBe(1);
    expect(Math.abs(starts[0].at - jumpedAt - (INTERVAL - 5 + 150))).toBeLessThanOrEqual(1);
  });

  it('fires a late tick immediately when no jitter is configured', async () => {
    const client = makeClient();
    await mount(client, GetPolled);

    vi.setSystemTime(Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(INTERVAL - 5);
    expect(count()).toBe(1);
  });

  it('does not start polling while mounted inactive, and starts once active', async () => {
    const activity = createActivity(false);
    const client = makeClient({ activity });
    await mount(client, GetPolled);

    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    expect(count()).toBe(0);

    activity.set(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(count()).toBe(1);
  });

  it('removes its activity listener when the subscription ends', async () => {
    const activity = createActivity();
    const client = makeClient({ activity });
    const unsub = await mount(client, GetPolled);
    expect(activity.listenerCount()).toBe(1);

    unsub();
    await vi.advanceTimersByTimeAsync(10);
    expect(activity.listenerCount()).toBe(0);

    activity.set(false);
    activity.set(true);
    await vi.advanceTimersByTimeAsync(5 * INTERVAL);
    expect(count()).toBe(0);
  });

  it('accepts an activity source whose methods live on its prototype', async () => {
    class AppActivity implements ActivitySource {
      active = true;
      listeners = new Set<() => void>();
      isActive(): boolean {
        return this.active;
      }
      subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
      }
    }
    const activity = new AppActivity();
    const client = makeClient({ activity });
    await mount(client, GetPolled);

    activity.active = false;
    for (const listener of activity.listeners) listener();
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(count()).toBe(0);
  });

  it('ignores an `activity` context value that is not an activity source, and warns once', async () => {
    // Custom config keys reach the context, so an app may use the name for a value of its own.
    const warn = vi.fn();
    const client = makeClient({ activity: { history: [] } as unknown as ActivitySource, log: { warn } });
    await mount(client, GetPolled, GetPolledB);
    await vi.advanceTimersByTimeAsync(3 * INTERVAL);
    expect(count('/polled')).toBe(3);
    expect(count('/polled-b')).toBe(3);
    expect((client.getContext() as Record<string, unknown>).activity).toEqual({ history: [] });
    expect(warn).toHaveBeenCalledTimes(IS_DEV ? 1 : 0);
  });

  it('treats a non-finite pollResumeJitterMs as no jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const activity = createActivity();
    const client = makeClient({ activity, pollResumeJitterMs: Infinity });
    await mount(client, GetPolled);

    activity.set(false);
    await vi.advanceTimersByTimeAsync(2 * INTERVAL);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    activity.set(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(count()).toBe(1);
    // An infinite delay is clamped to 1 ms by Node and the browser; other runtimes may never fire it.
    expect(setTimeoutSpy.mock.calls.filter(call => call[1] === Infinity)).toEqual([]);
  });
});
