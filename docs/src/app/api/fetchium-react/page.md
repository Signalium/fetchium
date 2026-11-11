---
title: fetchium/react
description: API reference for the fetchium React integration.
---

# fetchium/react

React hooks for using Fetchium queries in React components. Built on top of Signalium's `useReactive` hook.

```ts
import { useQuery, useQueries, useSuspenseQuery } from 'fetchium/react';
```

---

## Hooks

### `useQuery`

```ts
function useQuery<T extends Query>(
  QueryClass: new () => T,
  params?: ExtractQueryParams<T>,
  options?: { enabled?: boolean },
): QueryPromise<T>;
```

React hook for fetching a query. Subscribes the component to the query's reactive state, re-rendering when the query result changes. Internally uses Signalium's `useReactive` (deep-by-default in v3) to bridge the reactive signal system with React's rendering cycle.

#### Parameters

| Parameter         | Type                    | Description                                                                                                                                                     |
| ----------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryClass`      | `new () => T`           | The query class to instantiate and execute. Must extend `Query` or `RESTQuery`.                                                                                 |
| `params`          | `ExtractQueryParams<T>` | Parameters matching the query's `params` shape. Optional if the query has no required params. Values can be Signalium `Signal`s for reactive parameter changes. |
| `options.enabled` | `boolean`               | Defaults to `true`. When `false`, skips fetching and subscribing to the query, but still returns cached data when there is some.                                |

#### Returns

`QueryPromise<T>` — a `ReactivePromise` that provides the query state.

The returned promise object has the following properties:

| Property     | Type             | Description                                                                                                                                    |
| ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `value`      | `QueryResult<T>` | The resolved query result, or `undefined` until the first value arrives. Returns a deep clone to avoid accidental mutation of cached entities. |
| `isReady`    | `boolean`        | `true` once the query has loaded a value at least once. Use for type narrowing on `value`.                                                     |
| `isPending`  | `boolean`        | `true` while the query is loading. Also true during refetches, even if a value already exists.                                                 |
| `isResolved` | `boolean`        | `true` when the most recent execution resolved successfully.                                                                                   |
| `isRejected` | `boolean`        | `true` when the most recent execution failed.                                                                                                  |
| `error`      | `unknown`        | The error if `isRejected` is `true`.                                                                                                           |

The resolved `QueryResult<T>` includes pagination helpers:

| Property           | Type                            | Description                                            |
| ------------------ | ------------------------------- | ------------------------------------------------------ |
| `__refetch()`      | `() => QueryPromise<T>`         | Triggers a refetch and returns a new promise.          |
| `__fetchNext()`    | `() => Promise<QueryResult<T>>` | Fetches the next page (if configured via `fetchNext`). |
| `__hasNext`        | `boolean`                       | Whether there is a next page available.                |
| `__isFetchingNext` | `boolean`                       | Whether a next-page request is currently in flight.    |

#### Requirements

- A `QueryClient` must be provided via `QueryClientContext` using Signalium's `ContextProvider`.
- The component must be wrapped in a Signalium `component()` or use `useReactive` for the reactive system to function.

#### Example

```tsx
import { component } from 'signalium/react';
import { useQuery } from 'fetchium/react';

class GetUsers extends RESTQuery {
  path = '/api/users';

  result = {
    users: t.array(t.entity(User)),
    total: t.number,
  };
}

const UserList = component(() => {
  const query = useQuery(GetUsers);

  if (query.isPending) {
    return <div>Loading...</div>;
  }

  if (query.isRejected) {
    return <div>Error: {String(query.error)}</div>;
  }

  const { users, total } = query.value;

  return (
    <div>
      <h2>Users ({total})</h2>
      <ul>
        {users.map((user) => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
});
```

#### With parameters

```tsx
const UserProfile = component(({ userId }: { userId: string }) => {
  const query = useQuery(GetUser, { id: userId });

  return <div>{query.value.name}</div>;
});
```

#### With reactive parameters

```tsx
import { signal } from 'signalium';

const searchTerm = signal('');

const SearchResults = component(() => {
  const query = useQuery(SearchUsers, { q: searchTerm });

  // Component re-renders when searchTerm changes and the query refetches
  return <div>{query.value.results.length} results</div>;
});
```

#### Conditional queries

```tsx
function UserProfile({
  userId,
  enabled,
}: {
  userId: string;
  enabled: boolean;
}) {
  const query = useQuery(GetUser, { id: userId }, { enabled });

  // A disabled query still shows cached data.
  if (query.isReady) {
    return <div>{query.value.name}</div>;
  }

  return (
    <div>{enabled ? 'Loading...' : 'Select a user to load their profile.'}</div>
  );
}
```

A disabled query never fetches or subscribes, but it still reads the cache:

- If the query has cached data (in memory, or in the persistent store and within its `cacheTime`), the result starts resolved: `isReady: true`, `isResolved: true`, `isPending: false`, with `value` set to the cached data. Stale data is shown as-is. It is not refetched while disabled.
- If there is no cached data, the result stays `isPending: true` with `value: undefined` and no request is made.

The cached value stays reactive. Entity updates and fetches by enabled consumers of the same query appear in the disabled result. Setting `enabled` to `true` activates the query with the current parameters. Setting it back to `false` releases this hook's subscription; other consumers of the same query remain active. For queries without parameters, pass `undefined` as the second argument: `useQuery(GetUsers, undefined, { enabled })`.

#### Notes

- `useQuery` is a thin wrapper around Signalium v3's `useReactive`, which is deep-by-default. It returns a **structurally-shared snapshot** of the query result, so memoized children that receive subtrees as props keep stable references when the underlying data is unchanged.
- Fetchium registers a custom snapshot for entity proxies so the snapshot walks into entities (instead of returning them by reference), giving you correct re-rendering on entity field changes.
- The snapshot is a plain-object copy of the query result to prevent accidental mutation of the entity cache. Treat it as read-only: in development builds the snapshot and every nested object and array in it are frozen, so an in-place `sort()`, a `push()` or an assignment in render throws a `TypeError` at that line. Production snapshots are not frozen, and a mutation there is carried forward until the entity changes. Sort a copy (`[...items].sort()`) or use `draft()` from `fetchium` if you need a mutable copy for mutations.
- `useQuery` never suspends. Reading `.value` while pending returns `undefined`. Use [`useSuspenseQuery`](#usesuspensequery) to suspend on a cold miss.

---

### `useQueries`

```ts
function useQueries<E extends readonly QueriesEntry<Query>[]>(
  entries: E,
): QueriesResults<E>;

type QueriesEntry<T extends Query> = {
  query: new () => T;
  params?: ExtractQueryParams<T>; // required when the query has required params
  enabled?: boolean;
};
```

`useQuery` for a list of queries whose length or contents change between renders, where calling `useQuery` in a loop would break the rules of hooks. Each entry takes the same query, params and `enabled` option as `useQuery`. The result is an array with one `useQuery`-shaped result per entry, in the same order. For a fixed list of different queries the result is a typed tuple. Each entry's `params` are checked against its own query.

```tsx
function UserList({ ids }: { ids: string[] }) {
  const users = useQueries(
    ids.map((id) => ({ query: GetUser, params: { id } })),
  );

  return (
    <ul>
      {users.map((user, i) => (
        <li key={ids[i]}>{user.isReady ? user.value.name : 'Loading...'}</li>
      ))}
    </ul>
  );
}

const [user, posts] = useQueries([
  { query: GetUser, params: { id } },
  { query: GetPosts },
]);
```

#### Behavior

- **Entries are independent.** Each query fetches, refetches, fails and updates on its own. Adding, removing or reordering entries doesn't refetch the ones that stay.
- **Stable results.** Passing a new array with the same entries on every render is fine: the hook compares entries by query, params and `enabled`. An entry whose data didn't change keeps its result identity, so memoized children re-render only for the entries that changed.
- **Removed entries** are released like an unmounted `useQuery`: their subscriptions stop and they are collected after `gcTime`.
- **`enabled: false`** works per entry as in `useQuery`: the entry never fetches or subscribes, and shows cached data when there is some.
- **Signal params** work per entry, as in `useQuery`.
- `useQueries` never suspends. There is no suspense variant yet.

---

### `useSuspenseQuery`

```ts
function useSuspenseQuery<T extends Query>(
  QueryClass: new () => T,
  params?: ExtractQueryParams<T>,
): ReadyReactivePromise<QueryResult<T>>;
```

`useQuery` for components under a React `<Suspense>` boundary. It suspends only on a **cold miss**: the query has never produced a value, neither in memory nor, with a synchronous store, in the persisted cache. Anything else renders at once, including a stale value whose refetch is in flight. Refetches never suspend. Because the hook only returns once a value exists, `value` is always defined.

A cold fetch that fails is thrown to the nearest error boundary. Resetting the boundary (remounting the component) tries the fetch again.

Changing params to ones with no value yet is a cold miss, so the component suspends. Wrap the change in `startTransition` to keep showing the previous result.

Call it from a plain function component. Like `useQuery`, it cannot run inside a Signalium `component()`, which is a reactive context.

```tsx
import { Suspense } from 'react';
import { useSuspenseQuery } from 'fetchium/react';

function UserName({ id }: { id: number }) {
  const user = useSuspenseQuery(GetUser, { id });
  return <span>{user.value.name}</span>;
}

<Suspense fallback={<Spinner />}>
  <UserName id={42} />
</Suspense>;
```

While suspended, the client keeps the query active, since React discards a suspended render without subscribing to anything. The component's commit takes over.
