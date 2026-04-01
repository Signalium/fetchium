---
title: Caching & Refetching
---

Most data-fetching libraries treat caching as an afterthought --- a bag of imperative methods you call to set, invalidate, and evict cached data. You end up with `queryClient.invalidateQueries()` scattered across your codebase, mentally tracking which queries need refreshing after which mutations, and debugging stale UI when you forget one.

Fetchium takes a different approach. Caching in Fetchium is _declarative_. You configure three time-based knobs on your query classes --- `staleTime`, `gcTime`, and `cacheTime` --- and Fetchium handles the mechanics. The combination of entity normalization, automatic background refetching, and mutation effects keeps your data fresh without manual intervention. And when you do need to invalidate queries directly, you declare that on the mutation class too --- not in an imperative callback.

This philosophy is a direct extension of Fetchium's core design principle: _describe what you want, not how to get it_.

---

## The Three Time Knobs

Fetchium's cache behavior is controlled by three settings, each operating at a different layer of the caching system.

| Setting     | Unit         | Default              | Scope                    | Description                                                |
| ----------- | ------------ | -------------------- | ------------------------ | ---------------------------------------------------------- |
| `staleTime` | milliseconds | `0` (always stale)   | Per-query instance       | How long data is considered fresh after fetching            |
| `gcTime`    | minutes      | `5`                  | Per-query instance       | How long an unwatched query stays in the in-memory cache   |
| `cacheTime` | minutes      | `1440` (24 hours)    | Per-query class (static) | How long query results persist in the persistent store     |

The lifecycle of a piece of data flows through these layers:

```
fetch → in-memory cache (gcTime) → persistent store (cacheTime) → evicted
```

When a query is actively used by a component, it lives in memory. When all consumers unmount, the `gcTime` clock starts --- if no consumer re-subscribes before it expires, the data is evicted from memory. The persistent store (localStorage, IndexedDB) holds data independently and is governed by `cacheTime`. When a query is re-activated, Fetchium checks the store first --- if the cached data is newer than `cacheTime`, it is served immediately while a background refetch may occur (depending on `staleTime`).

### staleTime

`staleTime` controls how long data is considered _fresh_ after a successful fetch. While data is fresh, Fetchium serves it directly from the in-memory cache without hitting the network. Once the stale time has elapsed, the next read triggers a background refetch.

The default is `0`, meaning data is always considered stale. This is intentionally conservative --- every time a component mounts or re-activates, Fetchium will refetch in the background. For many applications this is exactly right: the network request happens transparently, the component shows cached data instantly, and updates arrive moments later.

Increase `staleTime` when:

- The data changes infrequently (user profiles, configuration, feature flags)
- The endpoint is expensive or rate-limited
- You want to reduce unnecessary network traffic on frequent navigation

```ts
class GetFeatureFlags extends RESTQuery {
  path = '/feature-flags';
  result = { flags: t.object({ darkMode: t.boolean, betaAccess: t.boolean }) };

  config = {
    staleTime: 5 * 60_000, // fresh for 5 minutes
  };
}
```

### gcTime

`gcTime` controls how long a query stays in the _in-memory_ cache after all of its consumers have unmounted. This is the window during which a user can navigate away and come back without triggering a new fetch --- the data is still in memory, ready to be served instantly.

The default is `5` minutes. Due to Fetchium's bucket-based garbage collection, the actual eviction time falls between `gcTime` and `2 × gcTime`. This is a deliberate trade-off: bucket-based GC is much cheaper than per-key timers, and the imprecision is irrelevant for most applications.

| `gcTime` value | Behavior                                                             |
| -------------- | -------------------------------------------------------------------- |
| `0`            | Evicted on the next tick after all consumers unmount                 |
| `5` (default)  | Stays in memory for 5--10 minutes after last consumer unmounts       |
| `Infinity`     | Never evicted from memory (use with caution)                         |

### cacheTime

`cacheTime` controls how long query results persist in the _persistent store_ (localStorage, IndexedDB, or whatever `QueryStore` implementation you provide). When a query is activated and no in-memory data exists, Fetchium checks the store. If the cached entry is newer than `cacheTime`, it is loaded and served to the component immediately. If it is older, the stale entry is discarded and a fresh fetch happens.

The default is `1440` minutes (24 hours). Unlike `gcTime`, which is set per-instance via the `config` object, `cacheTime` is set per-query-class via the _static_ `cache` property. This is because persistent storage is shared across all instances of a query class.

---

## Configuring Cache Behavior

### Per-instance config

`staleTime` and `gcTime` are set on the instance-level `config` field (or `getConfig()` method):

```ts
class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { name: t.string, email: t.string };

  config = {
    staleTime: 30_000, // fresh for 30 seconds
    gcTime: 10,        // keep in memory 10 minutes after unmount
  };
}
```

For dynamic configuration based on runtime conditions, use the `getConfig()` method:

```ts
class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { name: t.string, email: t.string };

  getConfig() {
    const lastResponseOk = this.response?.ok ?? true;

    return {
      staleTime: lastResponseOk ? 30_000 : 0,
      gcTime: 10,
    };
  }
}
```

### Static cache for persistent store

`cacheTime` and `maxCount` are configured via the static `cache` property on the query class:

```ts
class GetUser extends RESTQuery {
  static cache = {
    cacheTime: 120, // persist in store for 2 hours
    maxCount: 100,  // keep at most 100 cached instances
  };

  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { name: t.string, email: t.string };
}
```

`maxCount` limits how many distinct parameter combinations are stored for this query class. When the limit is exceeded, the oldest entries are evicted. The default is `50`.

---

## Manual Refetching with `__refetch()`

The declarative cache covers the vast majority of use cases, but sometimes you need to explicitly trigger a fresh fetch. Every query result exposes a `__refetch()` method:

```tsx {% mode="react" %}
function UserProfile({ userId }: { userId: number }) {
  const query = useQuery(GetUser, { id: userId });

  if (!query.isReady) return <div>Loading...</div>;

  return (
    <div>
      <h1>{query.value.name}</h1>
      <button onClick={() => query.value.__refetch()}>
        Refresh
      </button>
    </div>
  );
}
```

```tsx {% mode="signalium" %}
const UserProfile = component(({ userId }: { userId: number }) => {
  const query = fetchQuery(GetUser, { id: userId });

  if (!query.isReady) return <div>Loading...</div>;

  return (
    <div>
      <h1>{query.value.name}</h1>
      <button onClick={() => query.value.__refetch()}>
        Refresh
      </button>
    </div>
  );
});
```

`__refetch()` returns the query's `ReactivePromise`, so you can `await` it if you need to know when the fresh data arrives:

```ts
const freshResult = await result.__refetch();
```

If a fetch is already in flight, `__refetch()` returns the existing promise without starting a duplicate request.

{% callout title="Why __refetch lives on the result" type="note" %}
You might wonder why `__refetch()` is on the `QueryResult` rather than on the `ReactivePromise`. The reason is composability: the result object can be passed to child components, stored in variables, or returned from helper functions. Any consumer holding a reference to the result can trigger a refetch without needing access to the original query handle.
{% /callout %}

---

## Cache Invalidation

If you are coming from TanStack Query, you may be used to `queryClient.invalidateQueries()` --- a single imperative call that marks queries as stale and triggers refetches. Fetchium handles this differently: invalidation is _declarative_ and happens through mutation effects, not imperative calls.

In a traditional query cache, each query is an island. When a mutation changes data, you have to manually figure out _which queries_ are affected and invalidate them in an `onSuccess` callback. Forget one, and you have stale UI. Add a new query that displays the same data, and you have to remember to add it to the invalidation list.

Fetchium's entity normalization eliminates this problem for most cases. When User #42's name changes via a mutation, _every query displaying User #42 updates automatically_, because they all share the same normalized entity proxy. You do not need to know which queries to invalidate --- the entity system handles it.

The mechanisms for keeping data fresh in Fetchium are, in order of preference:

1. **Entity effects from mutations** (`creates`, `updates`, `deletes`). When a mutation succeeds, its effects update entities in the normalized store. Every query referencing those entities sees the change immediately. This is the most common and most powerful freshness mechanism.

2. **Query invalidation via `invalidates`**. For mutations whose effects are too complex or broad to express as entity-level changes, you can declare `invalidates` in the mutation's effects to mark specific query classes as stale. You can target all instances of a query class, or only those matching a param subset. See the [Mutations guide](/data/mutations) for details.

3. **`staleTime` expiration.** Background refetches happen automatically when data becomes stale and a consumer re-reads it. For data that changes unpredictably on the server, this provides eventual consistency without any manual intervention.

4. **`__refetch()` for explicit reloads.** When you need a one-off full query reload from a specific place in your code (not tied to a mutation), `__refetch()` on the query result gives you a direct escape hatch.

5. **`refreshStaleOnReconnect` for network recovery.** When the user's device comes back online, stale queries are automatically refetched.

{% callout type="note" %}
Entity effects should be your first choice. They are precise, efficient, and work with optimistic updates and live collections. Use `invalidates` when the mutation's impact is too broad to express as entity changes. Use `__refetch()` only for one-off imperative needs outside of the mutation system.
{% /callout %}

---

## Background Refetching

Fetchium automatically refetches data in several scenarios, all governed by the `staleTime` setting.

### On remount

When a component mounts and subscribes to a query that already has cached data, Fetchium serves the cached data immediately. If the data is stale (older than `staleTime`), a background refetch is triggered. The component sees the cached data first, then re-renders with fresh data when the fetch completes.

This is why the default `staleTime` of `0` works well in practice: users see data instantly, and it silently refreshes in the background. The UI never shows a loading spinner for data that has been fetched before.

### On reconnect

The `refreshStaleOnReconnect` option (default: `true`) controls whether stale queries are automatically refetched when the device comes back online. When a user loses connectivity and then reconnects, all active queries whose data has become stale are refetched automatically.

```ts
class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { name: t.string, email: t.string };

  config = {
    refreshStaleOnReconnect: false, // opt out of automatic reconnect refetch
  };
}
```

### Stale vs. pending

It is worth understanding the distinction between _stale_ and _pending_:

- **Stale** means the data's age has exceeded `staleTime`. Stale data is still perfectly usable --- it is served to the component and displayed to the user. It simply means a background refetch will be triggered on the next activation.
- **Pending** means a fetch is currently in flight. A query can be both stale and pending simultaneously (it has old data and is fetching new data).

The `ReactivePromise` exposes both states: `isPending` tells you if a fetch is in progress, while `isReady` tells you if _any_ value (fresh or stale) is available. For most UIs, you should use `isReady` to decide whether to render content, not `isPending`.

---

## Entity-Level GC

Entities have their own garbage collection, configured via the static `cache` property on the `Entity` class:

```ts
class User extends Entity {
  static cache = { gcTime: 10 }; // keep in memory 10 minutes after last reference

  __typename = t.typename('User');
  id = t.id;
  name = t.string;
}
```

| `gcTime` value        | Behavior                                                         |
| --------------------- | ---------------------------------------------------------------- |
| `undefined` (default) | Entity is evicted immediately when no queries reference it       |
| `0`                   | Entity is evicted on the next tick                               |
| `10`                  | Entity stays in cache for 10--20 minutes after last reference    |
| `Infinity`            | Entity is never garbage collected                                |

Entity GC and query GC are independent but related. When a query is evicted from memory (its `gcTime` expires), the entities it referenced lose one consumer. If no other active query references a given entity, that entity's own `gcTime` clock starts. This means:

- If both the query and entity have a `gcTime` of 5, an entity could stay in memory for up to 5 + 10 = 15 minutes after the last component unmounts (query GC window + entity GC window, accounting for bucket imprecision).
- Setting entity `gcTime` to `Infinity` keeps entities in memory permanently --- useful for user profiles or other data that is referenced from many queries and expensive to re-parse.

{% callout %}
Entity cache configuration is set at the class level, not per-instance. All instances of `User` share the same GC policy regardless of which query loaded them.
{% /callout %}

---

## Next Steps

{% quick-links %}

{% quick-link title="Mutations" icon="theming" href="/data/mutations" description="Update data with optimistic updates and entity effects" /%}

{% quick-link title="Offline & Persistence" icon="installation" href="/guides/offline" description="Configure persistent stores and offline-first network modes" /%}

{% quick-link title="REST Queries Reference" icon="presets" href="/reference/rest-queries" description="Full reference for query fields, methods, and configuration" /%}

{% quick-link title="Entities" icon="plugins" href="/core/entities" description="Normalized entity caching and identity-stable proxies" /%}

{% /quick-links %}
