import { describe, it, expect, expectTypeOf, beforeEach } from 'vitest';
import { render } from 'vitest-browser-react';
import { ContextProvider } from 'signalium/react';
import React, { memo, useState } from 'react';
import { signal } from 'signalium';
import { MemoryPersistentStore, SyncQueryStore } from '../../stores/sync.js';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { t } from '../../typeDefs.js';
import { RESTQuery } from '../../rest/index.js';
import { Entity } from '../../proxy.js';
import { RESTQueryAdapter } from '../../rest/RESTQueryAdapter.js';
import { createMockFetch, sleep } from '../../__tests__/utils.js';
import { useQueries, __debug_queriesThunkAllocations, __debug_resetQueriesThunkAllocations } from '../use-queries.js';
import type { QueryPromise } from '../../types.js';

class GetItem extends RESTQuery {
  params = { id: t.string };
  path = `/items/${this.params.id}`;
  result = { name: t.string };
}

class GetOther extends RESTQuery {
  params = { id: t.string };
  path = `/others/${this.params.id}`;
  result = { name: t.string };
}

class GetCount extends RESTQuery {
  path = '/count';
  result = { count: t.number };
}

describe('useQueries', () => {
  let client: QueryClient;
  let mockFetch: ReturnType<typeof createMockFetch>;

  beforeEach(() => {
    client?.destroy();
    mockFetch = createMockFetch();
    client = new QueryClient({
      store: new SyncQueryStore(new MemoryPersistentStore()),
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    });
  });

  const withClient = (node: React.ReactNode) => (
    <ContextProvider contexts={[[QueryClientContext, client]]}>{node}</ContextProvider>
  );

  const paths = () => mockFetch.calls.map(call => new URL(call.url).pathname);

  function Items({ ids, enabled }: { ids: string[]; enabled?: Record<string, boolean> }): React.ReactNode {
    const results = useQueries(ids.map(id => ({ query: GetItem, params: { id }, enabled: enabled?.[id] })));
    return (
      <div data-testid="items">{results.map(result => (result.isReady ? result.value.name : 'Pending')).join(',')}</div>
    );
  }

  it('fetches each entry and returns the results in order', async () => {
    mockFetch.get('/items/1', { name: 'One' });
    mockFetch.get('/items/2', { name: 'Two' });
    mockFetch.get('/count', { count: 3 });

    let results: [QueryPromise<GetItem>, QueryPromise<GetCount>] | undefined;
    function Mixed(): React.ReactNode {
      const r = useQueries([{ query: GetItem, params: { id: '1' } }, { query: GetCount }]);
      expectTypeOf(r).toEqualTypeOf<[QueryPromise<GetItem>, QueryPromise<GetCount>]>();
      results = r;
      return (
        <div data-testid="mixed">
          {r[0].isReady && r[1].isReady ? `${r[0].value.name}:${r[1].value.count}` : 'Pending'}
        </div>
      );
    }

    const { getByTestId } = render(
      withClient(
        <>
          <Items ids={['1', '2']} />
          <Mixed />
        </>,
      ),
    );
    await expect.element(getByTestId('items')).toHaveTextContent('One,Two');
    await expect.element(getByTestId('mixed')).toHaveTextContent('One:3');
    expect(results).toHaveLength(2);
    // GetItem 1 is shared by both components: one request.
    expect(paths().sort()).toEqual(['/count', '/items/1', '/items/2']);
  });

  it('returns an empty array for no entries', async () => {
    let results: unknown;
    function Empty(): React.ReactNode {
      results = useQueries([]);
      return null;
    }
    render(withClient(<Empty />));
    await sleep(10);
    expect(results).toEqual([]);
    expect(mockFetch.calls).toHaveLength(0);
  });

  it('fetches only added entries and keeps the others subscribed', async () => {
    for (const id of ['1', '2', '3']) mockFetch.get(`/items/${id}`, { name: `Item ${id}` });

    const { getByTestId, rerender } = render(withClient(<Items ids={['1', '2']} />));
    await expect.element(getByTestId('items')).toHaveTextContent('Item 1,Item 2');

    rerender(withClient(<Items ids={['1', '2', '3']} />));
    await expect.element(getByTestId('items')).toHaveTextContent('Item 1,Item 2,Item 3');

    rerender(withClient(<Items ids={['3', '1']} />));
    await expect.element(getByTestId('items')).toHaveTextContent('Item 3,Item 1');
    await sleep(20);

    // Entries 1 and 2 were never deactivated and refetched (staleTime is 0).
    expect(paths()).toEqual(['/items/1', '/items/2', '/items/3']);
  });

  it('unsubscribes a removed entry', async () => {
    const subscribed = new Set<string>();
    class GetLive extends RESTQuery {
      params = { id: t.string };
      path = `/live/${this.params.id}`;
      result = { name: t.string };
      getConfig() {
        const id = this.params.id as unknown as string;
        return {
          subscribe: () => {
            subscribed.add(id);
            return () => subscribed.delete(id);
          },
        };
      }
    }
    mockFetch.get('/live/1', { name: 'One' });
    mockFetch.get('/live/2', { name: 'Two' });

    function Live({ ids }: { ids: string[] }): React.ReactNode {
      const results = useQueries(ids.map(id => ({ query: GetLive, params: { id } })));
      return <div data-testid="live">{results.map(r => (r.isReady ? r.value.name : 'Pending')).join(',')}</div>;
    }

    const { getByTestId, rerender } = render(withClient(<Live ids={['1', '2']} />));
    await expect.element(getByTestId('live')).toHaveTextContent('One,Two');
    expect([...subscribed].sort()).toEqual(['1', '2']);

    rerender(withClient(<Live ids={['1']} />));
    await expect.element(getByTestId('live')).toHaveTextContent('One');
    await expect.poll(() => [...subscribed]).toEqual(['1']);
    expect(paths()).toEqual(['/live/1', '/live/2']);
  });

  it('refetches only the entry whose params changed', async () => {
    for (const id of ['1', '2', '3']) mockFetch.get(`/items/${id}`, { name: `Item ${id}` });

    const { getByTestId, rerender } = render(withClient(<Items ids={['1', '2']} />));
    await expect.element(getByTestId('items')).toHaveTextContent('Item 1,Item 2');

    rerender(withClient(<Items ids={['1', '3']} />));
    await expect.element(getByTestId('items')).toHaveTextContent('Item 1,Item 3');
    await sleep(20);
    expect(paths()).toEqual(['/items/1', '/items/2', '/items/3']);
  });

  it('skips disabled entries, which still show cached data', async () => {
    mockFetch.get('/items/1', { name: 'One' });
    mockFetch.get('/items/2', { name: 'Two' });

    const { getByTestId, rerender } = render(withClient(<Items ids={['1', '2']} enabled={{ '2': false }} />));
    await expect.element(getByTestId('items')).toHaveTextContent('One,Pending');
    await sleep(20);
    expect(paths()).toEqual(['/items/1']);

    rerender(withClient(<Items ids={['1', '2']} />));
    await expect.element(getByTestId('items')).toHaveTextContent('One,Two');

    // Disabling 1 keeps its cached value on screen, without a request.
    rerender(withClient(<Items ids={['1', '2']} enabled={{ '1': false }} />));
    await sleep(20);
    expect(getByTestId('items').element().textContent).toBe('One,Two');
    expect(paths()).toEqual(['/items/1', '/items/2']);
  });

  it('keeps an unchanged entry result identity when another entry updates', async () => {
    mockFetch.get('/items/1', { name: 'One' });
    mockFetch.get('/items/2', { name: 'Two' });
    mockFetch.get('/items/2', { name: 'Two again' });

    const renders: Record<string, number> = {};
    const Row = memo(function Row({ result }: { result: QueryPromise<GetItem> }) {
      const name = result.isReady ? result.value.name : 'Pending';
      renders[name] = (renders[name] ?? 0) + 1;
      return <span>{name}</span>;
    });

    let results: QueryPromise<GetItem>[] = [];
    function Rows(): React.ReactNode {
      results = useQueries(['1', '2'].map(id => ({ query: GetItem, params: { id } })));
      return (
        <div data-testid="rows">
          {results.map((result, i) => (
            <Row key={i} result={result} />
          ))}
        </div>
      );
    }

    const { getByTestId } = render(withClient(<Rows />));
    await expect.element(getByTestId('rows')).toHaveTextContent('OneTwo');
    const first = results[0];
    const rendersOfOne = renders['One'];

    results[1].value!.__refetch();
    await expect.element(getByTestId('rows')).toHaveTextContent('OneTwo again');

    expect(results[0]).toBe(first);
    expect(renders['One']).toBe(rendersOfOne);
  });

  it('switches an entry to another query with the same params', async () => {
    mockFetch.get('/items/1', { name: 'Item' });
    mockFetch.get('/others/1', { name: 'Other' });

    function Switch({ other }: { other: boolean }): React.ReactNode {
      const [result] = useQueries([{ query: other ? GetOther : GetItem, params: { id: '1' } }]);
      return <div data-testid="switch">{result.isReady ? result.value.name : 'Pending'}</div>;
    }

    const { getByTestId, rerender } = render(withClient(<Switch other={false} />));
    await expect.element(getByTestId('switch')).toHaveTextContent('Item');
    rerender(withClient(<Switch other />));
    await expect.element(getByTestId('switch')).toHaveTextContent('Other');
    expect(paths()).toEqual(['/items/1', '/others/1']);
  });

  it('follows a Signal param in one entry without rebuilding the list', async () => {
    mockFetch.get('/items/1', { name: 'One' });
    mockFetch.get('/items/2', { name: 'Two' });
    mockFetch.get('/count', { count: 7 });
    const id = signal('1');

    function WithSignal(): React.ReactNode {
      const [item, count] = useQueries([{ query: GetItem, params: { id } }, { query: GetCount }]);
      return (
        <div data-testid="signal">
          {item.isReady && count.isReady ? `${item.value.name}:${count.value.count}` : 'Pending'}
        </div>
      );
    }

    __debug_resetQueriesThunkAllocations();
    const { getByTestId } = render(withClient(<WithSignal />));
    await expect.element(getByTestId('signal')).toHaveTextContent('One:7');
    const allocations = __debug_queriesThunkAllocations;

    id.value = '2';
    await expect.element(getByTestId('signal')).toHaveTextContent('Two:7');
    expect(__debug_queriesThunkAllocations).toBe(allocations);
    expect(paths()).toEqual(['/items/1', '/count', '/items/2']);
  });

  it('isolates a failing entry from the others', async () => {
    class GetFailing extends RESTQuery {
      path = '/failing';
      result = { name: t.string };
      config = { retry: false };
    }
    mockFetch.get('/items/1', { name: 'One' });
    mockFetch.get('/failing', null, { error: new Error('boom') });

    function Mixed(): React.ReactNode {
      const [item, failing] = useQueries([{ query: GetItem, params: { id: '1' } }, { query: GetFailing }]);
      const failed = failing.isRejected ? (failing.error as Error).message : failing.isPending ? 'Pending' : 'ok';
      return <div data-testid="mixed">{`${item.isReady ? item.value.name : 'Pending'}|${failed}`}</div>;
    }

    const { getByTestId } = render(withClient(<Mixed />));
    await expect.element(getByTestId('mixed')).toHaveTextContent('One|boom');
  });

  it('updates every entry that shows a changed entity', async () => {
    class Person extends Entity {
      __typename = t.typename('QueriesPerson');
      id = t.id;
      name = t.string;
    }
    class GetPerson extends RESTQuery {
      path = '/person';
      result = { person: t.entity(Person) };
    }
    class GetPeople extends RESTQuery {
      path = '/people';
      result = { people: t.array(t.entity(Person)) };
    }
    mockFetch.get('/person', { person: { __typename: 'QueriesPerson', id: '1', name: 'Before' } });
    mockFetch.get('/people', {
      people: [
        { __typename: 'QueriesPerson', id: '1', name: 'Before' },
        { __typename: 'QueriesPerson', id: '2', name: 'Other' },
      ],
    });

    function People(): React.ReactNode {
      const [one, all] = useQueries([{ query: GetPerson }, { query: GetPeople }]);
      if (!one.isReady || !all.isReady) return <div data-testid="people">Pending</div>;
      return (
        <div data-testid="people">{`${one.value.person.name}|${all.value.people.map(p => p.name).join(',')}`}</div>
      );
    }

    const { getByTestId } = render(withClient(<People />));
    await expect.element(getByTestId('people')).toHaveTextContent('Before|Before,Other');

    client.applyMutationEvent({
      type: 'update',
      typename: 'QueriesPerson',
      data: { __typename: 'QueriesPerson', id: '1', name: 'After' },
    });
    await expect.element(getByTestId('people')).toHaveTextContent('After|After,Other');
    expect(paths()).toEqual(['/person', '/people']);
  });

  describe('thunk identity', () => {
    it('keeps the thunk across re-renders with a fresh, equal list', async () => {
      for (const id of ['1', '2']) mockFetch.get(`/items/${id}`, { name: `Item ${id}` });
      let bump!: () => void;

      function Component(): React.ReactNode {
        // A new array of new entry objects each render, deeply equal across renders.
        const results = useQueries(['1', '2'].map(id => ({ query: GetItem, params: { id } })));
        const [, setN] = useState(0);
        bump = () => setN(n => n + 1);
        return <div data-testid="probe">{results.every(r => r.isReady) ? 'r' : 'l'}</div>;
      }

      __debug_resetQueriesThunkAllocations();
      const { getByTestId } = render(withClient(<Component />));
      await expect.element(getByTestId('probe')).toHaveTextContent('r');
      const afterMount = __debug_queriesThunkAllocations;

      for (let i = 0; i < 20; i++) {
        bump();
        await sleep(5);
      }
      await sleep(20);
      expect(__debug_queriesThunkAllocations - afterMount).toBe(0);
      expect(paths()).toEqual(['/items/1', '/items/2']);
    });

    it('rebuilds the thunk once per structural change to the list', async () => {
      for (const id of ['1', '2', '3']) mockFetch.get(`/items/${id}`, { name: `Item ${id}` });
      mockFetch.get('/others/3', { name: 'Other 3' });
      type Entry = { other?: boolean; id: string; enabled?: boolean };
      let setEntries!: (entries: Entry[]) => void;

      function Component(): React.ReactNode {
        const [entries, set] = useState<Entry[]>([{ id: '1' }, { id: '2' }]);
        setEntries = set;
        useQueries(
          entries.map(entry => ({
            query: entry.other ? GetOther : GetItem,
            params: { id: entry.id },
            enabled: entry.enabled,
          })),
        );
        return null;
      }

      __debug_resetQueriesThunkAllocations();
      render(withClient(<Component />));
      await sleep(20);
      const afterMount = __debug_queriesThunkAllocations;

      const changes: Entry[][] = [
        [{ id: '1' }, { id: '2' }, { id: '3' }], // add
        [{ id: '1' }, { id: '3' }], // remove
        [{ id: '1' }, { id: '2' }], // change params
        [{ id: '1' }, { id: '2', enabled: false }], // disable
        [{ id: '1' }, { other: true, id: '2', enabled: false }], // other query, same params
      ];
      for (const entries of changes) {
        setEntries(entries);
        await sleep(20);
      }
      // An equal list again changes nothing.
      setEntries([{ id: '1' }, { other: true, id: '2', enabled: false }]);
      await sleep(20);

      expect(__debug_queriesThunkAllocations - afterMount).toBe(changes.length);
    });
  });

  it('checks each entry against its own query', () => {
    // Type-level only: the body is never called.
    const useTypeChecks = () => {
      // @ts-expect-error GetItem requires params
      useQueries([{ query: GetItem }]);
      // @ts-expect-error params must match the entry's query
      useQueries([{ query: GetItem, params: { id: 1 } }]);
      // @ts-expect-error GetItem has no `name` param
      useQueries([{ query: GetCount }, { query: GetItem, params: { name: 'x' } }]);
      const mapped = useQueries(['1'].map(id => ({ query: GetItem, params: { id } })));
      expectTypeOf(mapped).toEqualTypeOf<QueryPromise<GetItem>[]>();
    };
    expect(useTypeChecks).toBeTypeOf('function');
  });
});
