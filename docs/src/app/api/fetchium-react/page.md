---
title: fetchium/react
description: API reference for the fetchium React integration.
---

# fetchium/react

React hooks for using Fetchium queries in React components. Built on top of Signalium's `useReactive` hook.

Use these hooks in ordinary React function components. Inside a Signalium `component()`, which is already reactive, call `fetchQuery` directly instead:

```tsx
import { component } from 'signalium/react';
import { fetchQuery } from 'fetchium';

const UserList = component(() => {
  const query = fetchQuery(GetUsers);
  if (!query.isReady) return <div>Loading...</div>;
  return <div>{query.value.total} users</div>;
});
```

```ts
import { useQuery, useSuspenseQuery } from 'fetchium/react';
```

---

## Hooks

### `useQuery`

```ts
function useQuery<T extends Query>(
  QueryClass: new () => T,
  params?: ExtractQueryParams<T>,
): QueryPromise<T>;
```

React hook for fetching a query. Subscribes the component to the query's reactive state, re-rendering when the query result changes. Internally uses Signalium's `useReactive` (deep-by-default in v3) to bridge the reactive signal system with React's rendering cycle.

#### Parameters

| Parameter    | Type                    | Description                                                                                                                                                     |
| ------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryClass` | `new () => T`           | The query class to instantiate and execute. Must extend `Query` or `RESTQuery`.                                                                                 |
| `params`     | `ExtractQueryParams<T>` | Parameters matching the query's `params` shape. Optional if the query has no required params. Values can be Signalium `Signal`s for reactive parameter changes. |

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
- Call it from an ordinary React function component, not inside a Signalium `component()`.

#### Example

```tsx
import { useQuery } from 'fetchium/react';

class GetUsers extends RESTQuery {
  path = '/api/users';

  result = {
    users: t.array(t.entity(User)),
    total: t.number,
  };
}

function UserList() {
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
}
```

#### With parameters

```tsx
function UserProfile({ userId }: { userId: string }) {
  const query = useQuery(GetUser, { id: userId });
  if (!query.isReady) return null;

  return <div>{query.value.name}</div>;
}
```

#### With reactive parameters

```tsx
import { signal } from 'signalium';

const searchTerm = signal('');

function SearchResults() {
  const query = useQuery(SearchUsers, { q: searchTerm });
  if (!query.isReady) return null;

  // Re-renders when searchTerm changes and the query refetches
  return <div>{query.value.results.length} results</div>;
}
```

#### Notes

- `useQuery` is a thin wrapper around Signalium v3's `useReactive`, which is deep-by-default. It returns a **structurally-shared snapshot** of the query result, so memoized children that receive subtrees as props keep stable references when the underlying data is unchanged.
- Fetchium registers a custom snapshot for entity proxies so the snapshot walks into entities (instead of returning them by reference), giving you correct re-rendering on entity field changes.
- The snapshot is a read-only copy of the query result. Development builds freeze it, so mutating it throws a `TypeError`. Sort a copy (`[...items].sort()`) or use `draft()` from `fetchium` when you need a mutable copy.
- `useQuery` never suspends: `.value` is `undefined` until the first value arrives. Use [`useSuspenseQuery`](#usesuspensequery) to suspend.

---

### `useSuspenseQuery`

```ts
function useSuspenseQuery<T extends Query>(
  QueryClass: new () => T,
  params?: ExtractQueryParams<T>,
): ReadyReactivePromise<QueryResult<T>>;
```

Like `useQuery`, but suspends while the query has no value yet. Refetches don't suspend, so `value` is always defined. A failed first fetch is thrown to the nearest error boundary, and resetting the boundary retries it.

Changing params to ones with no value yet suspends again. Wrap the change in `startTransition` to keep showing the previous result.

Like `useQuery`, call it from an ordinary React component, not inside a Signalium `component()`.

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
