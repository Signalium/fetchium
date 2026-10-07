import { describe, it, expect, afterEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider } from 'signalium/react';
import React, { Suspense } from 'react';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { RESTQuery } from '../../rest/index.js';
import { RESTQueryAdapter } from '../../rest/RESTQueryAdapter.js';
import { createMockFetch, sleep } from '../../__tests__/utils.js';
import type { MutationEvent } from '../../types.js';
import { useQuery } from '../use-query.js';
import { useSuspenseQuery } from '../use-suspense-query.js';
import { withContexts } from 'signalium';
import { fetchQuery } from '../../query.js';

class GetItem extends RESTQuery {
  path = '/item';
  result = { name: t.string };
  config = { staleTime: 0 };
}

class GetFreshItem extends RESTQuery {
  path = '/fresh';
  result = { name: t.string };
  config = { staleTime: 60_000 };
}

let subscribed = 0;
let unsubscribed = 0;

class GetStreamed extends RESTQuery {
  path = '/streamed';
  result = { name: t.string };
  config = {
    subscribe: (_onEvent: (event: MutationEvent) => void) => {
      subscribed++;
      return () => {
        unsubscribed++;
      };
    },
  };
}

let clients: QueryClient[] = [];

afterEach(() => {
  for (const c of clients) c.destroy();
  clients = [];
  subscribed = 0;
  unsubscribed = 0;
});

function makeClient(mockFetch: ReturnType<typeof createMockFetch>, kv = new MemoryPersistentStore()): QueryClient {
  const client = new QueryClient({
    store: new SyncQueryStore(kv),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
  });
  clients.push(client);
  return client;
}

class Boundary extends React.Component<
  { children: React.ReactNode; onError: (e: unknown) => void },
  { error: unknown }
> {
  state = { error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  render() {
    return this.state.error !== undefined ? <div>Boundary caught</div> : this.props.children;
  }
}

describe('client.prefetch() with React', () => {
  it('a screen mounting after a tap-time prefetch renders the data on its first render, with one request', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { name: 'prefetched' }, { delay: 20 });
    const client = makeClient(mockFetch);

    client.prefetch(GetItem, undefined, { ttl: 5_000 });
    await sleep(60);

    const renders: Array<string | undefined> = [];
    function Item(): React.ReactNode {
      const item = useQuery(GetItem);
      const label = item.isReady ? item.value.name : undefined;
      renders.push(label);
      return <div>{label ?? 'Loading...'}</div>;
    }

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Item />
      </ContextProvider>,
    );

    await expect.element(getByText('prefetched')).toBeInTheDocument();
    await sleep(50);
    expect(renders[0]).toBe('prefetched');
    expect(renders).not.toContain(undefined);
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('a screen mounting before the prefetch lands joins the in-flight request', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { name: 'joined' }, { delay: 60 });
    const client = makeClient(mockFetch);

    client.prefetch(GetItem);
    await sleep(10);

    function Item(): React.ReactNode {
      const item = useQuery(GetItem);
      return <div>{item.isReady ? item.value.name : 'Loading...'}</div>;
    }

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Item />
      </ContextProvider>,
    );

    await expect.element(getByText('joined')).toBeInTheDocument();
    expect(mockFetch.calls).toHaveLength(1);
  });
});

describe('useSuspenseQuery', () => {
  it('suspends on a cold miss, then renders the data, with one request', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { name: 'loaded' }, { delay: 20 });
    const client = makeClient(mockFetch);

    const renders: string[] = [];
    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetItem);
      renders.push(item.value.name);
      return <div>{item.value.name}</div>;
    }

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Suspense fallback={<div>Suspended</div>}>
          <Item />
        </Suspense>
      </ContextProvider>,
    );

    await expect.element(getByText('Suspended')).toBeInTheDocument();
    await expect.element(getByText('loaded')).toBeInTheDocument();
    await sleep(30);
    expect(renders.every(r => r === 'loaded')).toBe(true);
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('does not suspend when the value is in memory, and does not suspend for the refetch', async () => {
    const mockFetch = createMockFetch();
    let n = 0;
    mockFetch.get('/item', () => ({ name: `v${++n}` }), { delay: 20 });
    const client = makeClient(mockFetch);

    const release = client.prefetch(GetItem);
    await sleep(40);
    release();
    await sleep(20);
    expect(mockFetch.calls).toHaveLength(1);

    let fallbacks = 0;
    function Fallback(): React.ReactNode {
      fallbacks++;
      return <div>Suspended</div>;
    }
    const renders: string[] = [];
    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetItem);
      renders.push(item.value.name);
      return <div>{item.value.name}</div>;
    }

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Suspense fallback={<Fallback />}>
          <Item />
        </Suspense>
      </ContextProvider>,
    );

    // The stale reactivation refetches without suspending.
    await expect.element(getByText('v2')).toBeInTheDocument();
    expect(renders[0]).toBe('v1');
    expect(fallbacks).toBe(0);
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('does not suspend when a synchronous store has the value', async () => {
    const kv = new MemoryPersistentStore();
    const seedFetch = createMockFetch();
    seedFetch.get('/fresh', { name: 'persisted' });
    const seed = makeClient(seedFetch, kv);
    seed.prefetch(GetFreshItem);
    await sleep(20);
    seed.destroy();

    const mockFetch = createMockFetch();
    const client = makeClient(mockFetch, kv);

    let fallbacks = 0;
    function Fallback(): React.ReactNode {
      fallbacks++;
      return <div>Suspended</div>;
    }
    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetFreshItem);
      return <div>{item.value.name}</div>;
    }

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Suspense fallback={<Fallback />}>
          <Item />
        </Suspense>
      </ContextProvider>,
    );

    await expect.element(getByText('persisted')).toBeInTheDocument();
    expect(fallbacks).toBe(0);
    expect(mockFetch.calls).toHaveLength(0);
  });

  it('throws a failed cold fetch to the error boundary', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', null, { status: 500 });
    const client = makeClient(mockFetch);

    class GetNoRetry extends RESTQuery {
      path = '/item';
      result = { name: t.string };
      config = { retry: false };
    }

    const errors: unknown[] = [];
    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetNoRetry);
      return <div>{item.value.name}</div>;
    }

    const { getByText } = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Boundary onError={e => errors.push(e)}>
          <Suspense fallback={<div>Suspended</div>}>
            <Item />
          </Suspense>
        </Boundary>
      </ContextProvider>,
    );

    await expect.element(getByText('Boundary caught')).toBeInTheDocument();
    expect(errors.length).toBeGreaterThan(0);
    expect(mockFetch.calls).toHaveLength(1);
  });

  it('retries a failed cold fetch when the error boundary resets', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { error: 'down' }, { status: 500 });
    const client = makeClient(mockFetch);

    class GetNoRetry extends RESTQuery {
      path = '/item';
      result = { name: t.string };
      config = { retry: false };
    }

    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetNoRetry);
      return <div>{item.value.name}</div>;
    }

    const tree = (attempt: number) => (
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Boundary key={attempt} onError={() => {}}>
          <Suspense fallback={<div>Suspended</div>}>
            <Item />
          </Suspense>
        </Boundary>
      </ContextProvider>
    );

    const screen = render(tree(0));
    await expect.element(screen.getByText('Boundary caught')).toBeInTheDocument();
    await sleep(10);

    mockFetch.get('/item', { name: 'recovered' });
    screen.rerender(tree(1));
    await expect.element(screen.getByText('recovered')).toBeInTheDocument();
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('suspends on a refetch that started after the cold fetch failed, without re-rendering in a loop', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { error: 'down' }, { status: 500, delay: 20 });
    mockFetch.get('/item', { name: 'second' }, { delay: 400 });
    const client = makeClient(mockFetch);

    class GetNoRetry extends RESTQuery {
      path = '/item';
      result = { name: t.string };
      config = { retry: false };
    }

    client.prefetch(GetNoRetry);
    const relay = withContexts([[QueryClientContext, client]], () => fetchQuery(GetNoRetry));
    // Another refetch starts as soon as the first attempt fails.
    relay.then(
      () => {},
      () => {
        client.queryInstances.values().next().value!.refetch();
      },
    );

    let renders = 0;
    function Item(): React.ReactNode {
      renders++;
      const item = useSuspenseQuery(GetNoRetry);
      return <div>{item.value.name}</div>;
    }

    const screen = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Boundary onError={() => {}}>
          <Suspense fallback={<div>Suspended</div>}>
            <Item />
          </Suspense>
        </Boundary>
      </ContextProvider>,
    );

    await expect.element(screen.getByText('second'), { timeout: 3000 }).toBeInTheDocument();
    expect(renders).toBeLessThan(10);
    expect(mockFetch.calls).toHaveLength(2);
  });

  it('makes a new attempt when a tree abandoned while suspended is mounted again after the fetch failed', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { error: 'down' }, { status: 500, delay: 20 });
    const client = makeClient(mockFetch);

    class GetNoRetry extends RESTQuery {
      path = '/item';
      result = { name: t.string };
      config = { retry: false };
    }

    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetNoRetry);
      return <div>{item.value.name}</div>;
    }

    const errors: unknown[] = [];
    const tree = (show: boolean) => (
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Boundary onError={e => errors.push(e)}>
          <Suspense fallback={<div>Suspended</div>}>{show ? <Item /> : <div>Other</div>}</Suspense>
        </Boundary>
      </ContextProvider>
    );

    const screen = render(tree(true));
    await expect.element(screen.getByText('Suspended')).toBeInTheDocument();
    // Navigated away while suspended. The fetch fails and no render claims the
    // error within the 1 s window.
    screen.rerender(tree(false));
    await sleep(1_150);
    expect(mockFetch.calls).toHaveLength(1);

    mockFetch.get('/item', { name: 'recovered' });
    screen.rerender(tree(true));
    await expect.element(screen.getByText('recovered')).toBeInTheDocument();
    expect(mockFetch.calls).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('throws a failed cold fetch to the boundary once when the retry render is slow to reach the reader', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/item', { error: 'down' }, { status: 500, delay: 10 });
    const client = makeClient(mockFetch);

    class GetNoRetry extends RESTQuery {
      path = '/item';
      result = { name: t.string };
      config = { retry: false };
    }

    // Siblings that take ~100 ms to render: React's time-sliced retry render
    // reaches the reader long after the fetch failed.
    function Slow(): React.ReactNode {
      const until = performance.now() + 10;
      while (performance.now() < until) {
        // busy
      }
      return null;
    }
    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetNoRetry);
      return <div>{item.value.name}</div>;
    }

    const errors: unknown[] = [];
    const screen = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Boundary onError={e => errors.push(e)}>
          <Suspense fallback={<div>Suspended</div>}>
            {Array.from({ length: 10 }, (_, i) => (
              <Slow key={i} />
            ))}
            <Item />
          </Suspense>
        </Boundary>
      </ContextProvider>,
    );
    await expect.element(screen.getByText('Boundary caught'), { timeout: 3000 }).toBeInTheDocument();
    await sleep(300);
    expect(mockFetch.calls).toHaveLength(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('hands the query to the reader on commit, so unmounting deactivates it', async () => {
    const mockFetch = createMockFetch();
    mockFetch.get('/streamed', { name: 'live' }, { delay: 10 });
    const client = makeClient(mockFetch);

    function Item(): React.ReactNode {
      const item = useSuspenseQuery(GetStreamed);
      return <div>{item.value.name}</div>;
    }

    const screen = render(
      <ContextProvider contexts={[[QueryClientContext, client]]}>
        <Suspense fallback={<div>Suspended</div>}>
          <Item />
        </Suspense>
      </ContextProvider>,
    );

    await expect.element(screen.getByText('live')).toBeInTheDocument();
    expect(subscribed).toBe(1);
    screen.unmount();
    await sleep(30);
    expect(unsubscribed).toBe(1);
  });
});
