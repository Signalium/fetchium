---
title: Server-Side Rendering
---

Fetchium is primarily a _client-side_ data-fetching library. Its reactive engine --- subscriptions, background refetching, garbage collection, entity proxy tracking --- is designed around a long-lived browser session where data changes over time and the UI reacts automatically.

But many applications need to render HTML on the server, whether for SEO, faster first-paint, or progressive enhancement. Fetchium supports this. The key thing to understand is that on the server, most of that reactive machinery _doesn't apply_. There are no WebSocket connections to maintain, no stale queries to refetch in the background, and no component tree that survives across navigations.

A server-side QueryClient is **short-lived** and **non-reactive**: it fetches data once, serializes the result, and is discarded when the response is sent. This isn't a limitation --- it's the correct behavior for a request/response lifecycle.

{% callout title="Client-only apps can skip this" type="note" %}
If your application is purely client-rendered (a single-page app with no server rendering), you can skip this page entirely. Everything here is specific to applications that render HTML on the server for performance or SEO.
{% /callout %}

## Server-side defaults

Fetchium detects a server environment when `typeof window === 'undefined'` and adjusts its defaults accordingly:

| Default | Client | Server | Why |
| --- | --- | --- | --- |
| **Retry count** | Configurable (typically 3) | `0` | Retries on the server block the HTTP response. Fail fast and let the client handle recovery. |
| **GcManager** | Active (evicts inactive queries) | `NoOpGcManager` | The client lives for milliseconds --- there's nothing to garbage collect. |
| **NetworkManager** | Browser connectivity API | `isOnline = true` | There's no `navigator.onLine` on the server. Assume the server can reach the network. |

You can also set any of these explicitly when creating your QueryClient, which is useful if your server environment has unusual constraints.

## Creating a server-side QueryClient

A minimal server-side setup looks like this:

```ts
import { QueryClient, NoOpGcManager, NoOpNetworkManager } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';

function createServerClient() {
  const store = new SyncQueryStore(new MemoryPersistentStore());

  return new QueryClient(
    store,
    { fetch },
    new NoOpNetworkManager(),
    new NoOpGcManager(),
  );
}
```

There are a few deliberate choices here:

- **SyncQueryStore** with **MemoryPersistentStore** --- on the server you don't need IndexedDB or any async persistence. Data lives in memory for the duration of the request and is discarded afterward.
- **NoOpGcManager** --- disables garbage collection entirely. The QueryClient won't outlive the request, so there's nothing to evict.
- **NoOpNetworkManager** --- reports the network as always online. The server doesn't have browser connectivity events.

{% callout title="One client per request" type="warning" %}
Each incoming request _must_ get its own QueryClient. If you share a single client across requests, cached data from one user's request will leak into another user's response. This is both a correctness bug and a security issue.
{% /callout %}

## The hydration pattern

The general pattern for SSR with Fetchium follows three steps:

1. **Server**: Create a QueryClient, fetch the data your page needs, serialize the store
2. **Client**: Create a QueryClient with a store pre-populated from the serialized data
3. **Render**: Components render immediately with cached data, then revalidate in the background if stale

This is conceptually similar to how TanStack Query's `dehydrate` / `hydrate` works, or how Relay's store is serialized and transferred to the client.

### Step 1: Fetch on the server

On the server, use `fetchQuery` to execute the queries your page needs. Once they resolve, the store contains the cached responses.

```ts
import { fetchQuery } from 'fetchium';
import { settled } from 'signalium';

async function getServerData(params) {
  const client = createServerClient();

  // Fetch the queries your page needs
  fetchQuery(GetUser, { id: params.userId });
  fetchQuery(GetUserPosts, { userId: params.userId });

  // Wait for all pending queries to settle
  await settled();

  // Serialize the store for transfer to the client
  const dehydratedState = client.store.dehydrate();

  return { dehydratedState };
}
```

### Step 2: Hydrate on the client

On the client, create a store pre-populated with the serialized data and pass it to your QueryClient.

```tsx
import { QueryClient, QueryClientContext } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { ContextProvider } from 'signalium/react';

function createClientFromServerState(dehydratedState) {
  const store = new SyncQueryStore(
    new MemoryPersistentStore(dehydratedState),
  );

  return new QueryClient(store, { fetch });
}

function App({ dehydratedState }) {
  const client = createClientFromServerState(dehydratedState);

  return (
    <ContextProvider value={client} context={QueryClientContext}>
      <YourApp />
    </ContextProvider>
  );
}
```

### Step 3: Components render with cached data

Components using `useQuery` or `fetchQuery` will find the data already in the cache. The initial render is synchronous --- no loading spinner. If the data is stale according to the query's `staleTime`, Fetchium revalidates in the background automatically.

```tsx
import { useQuery } from 'fetchium/react';

function UserProfile({ userId }) {
  const result = useQuery(GetUser, { id: userId });

  // On the server and on initial client render,
  // this data is already available from the hydrated cache.
  if (!result.isReady) return <div>Loading...</div>;

  return <h1>{result.value.name}</h1>;
}
```

## Next.js App Router

Here's a practical pattern for Next.js applications using the App Router. The server component fetches data and passes the serialized store to a client component that hydrates it.

{% callout title="Evolving patterns" type="note" %}
React Server Components and the Next.js App Router are still maturing. The patterns shown here work today, but may evolve as the ecosystem stabilizes. Check the Fetchium release notes for updates.
{% /callout %}

### Server component

```tsx
// app/users/[id]/page.tsx
import { fetchQuery } from 'fetchium';
import { settled } from 'signalium';
import { UserProfileClient } from './client';

export default async function UserPage({ params }) {
  const client = createServerClient();

  fetchQuery(GetUser, { id: params.id });
  await settled();

  const dehydratedState = client.store.dehydrate();

  return <UserProfileClient userId={params.id} dehydratedState={dehydratedState} />;
}
```

### Client component

```tsx
// app/users/[id]/client.tsx
'use client';

import { QueryClient, QueryClientContext } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { ContextProvider } from 'signalium/react';
import { useQuery } from 'fetchium/react';
import { useMemo } from 'react';

export function UserProfileClient({ userId, dehydratedState }) {
  const client = useMemo(() => {
    const store = new SyncQueryStore(
      new MemoryPersistentStore(dehydratedState),
    );
    return new QueryClient(store, { fetch });
  }, [dehydratedState]);

  return (
    <ContextProvider value={client} context={QueryClientContext}>
      <UserProfile userId={userId} />
    </ContextProvider>
  );
}

function UserProfile({ userId }) {
  const result = useQuery(GetUser, { id: userId });

  if (!result.isReady) return <div>Loading...</div>;
  if (result.isRejected) return <div>Error: {result.error.message}</div>;

  return (
    <div>
      <h1>{result.value.name}</h1>
      <p>{result.value.email}</p>
    </div>
  );
}
```

The `useMemo` ensures the QueryClient is only created once per set of hydrated data, not on every render.

## Caveats

There are several important differences between server-side and client-side Fetchium usage to keep in mind:

**No subscriptions on the server.** WebSocket connections, Server-Sent Events, and polling don't make sense in a request/response lifecycle. Any query with a `subscribe` configuration will simply fetch once and return. Subscriptions activate only on the client after hydration.

**No garbage collection.** The server-side QueryClient is discarded after the response is sent. There are no long-lived subscriptions to clean up, no inactive queries to evict. `NoOpGcManager` reflects this reality.

**Entity proxies are plain data on the server.** On the client, entities are reactive Proxy objects that track property access for fine-grained re-rendering. On the server, there's no reactivity to track --- entities are serialized as plain data. The proxies are restored on the client after hydration.

**Use SyncQueryStore, not AsyncQueryStore.** On the server, you want synchronous store operations. `AsyncQueryStore` with `IndexedDBPersistentStore` is designed for browser persistence and won't work in a Node environment. `SyncQueryStore` with `MemoryPersistentStore` is the correct choice.

**Isolate clients per request.** This bears repeating: never share a QueryClient across requests. Each request handler, each server component render, must create its own client. Shared state between requests means shared _user data_ between requests.

---

## Next Steps

{% quick-links %}

{% quick-link title="Caching & Refetching" icon="presets" href="/data/caching" description="Configure staleTime, gcTime, and background revalidation" /%}

{% quick-link title="Offline & Persistence" icon="installation" href="/guides/offline" description="Keep your app working without a network connection" /%}

{% quick-link title="Testing" icon="plugins" href="/guides/testing" description="Test queries with mock stores and controlled fetches" /%}

{% quick-link title="Quick start" icon="theming" href="/quickstart" description="Get up and running with Fetchium from scratch" /%}

{% /quick-links %}
