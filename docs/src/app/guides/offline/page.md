---
title: Offline & Persistence
---

Fetchium has built-in support for offline operation and query persistence. It can detect network status, pause queries when the device goes offline, and persist query results across sessions so your application works even without a connection.

This guide covers the offline and persistence-specific pieces of Fetchium's infrastructure. For the caching time knobs (`staleTime`, `gcTime`, `cacheTime`) and cache invalidation patterns, see [Caching & Refetching](/data/caching).

---

## Network Manager

The `NetworkManager` tracks whether the device is online or offline. It automatically listens to browser `online` and `offline` events, and exposes the current status as a reactive signal so that queries can pause and resume automatically.

### Basic usage

```tsx
import { NetworkManager } from 'fetchium';

const networkManager = new NetworkManager();
```

The network manager is passed to the `QueryClient` constructor:

```tsx
import { QueryClient } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';

const store = new SyncQueryStore(new MemoryPersistentStore());
const networkManager = new NetworkManager();

const client = new QueryClient(store, { fetch }, networkManager);
```

If you do not provide a `NetworkManager`, the `QueryClient` creates one automatically.

### Manual override

For testing or custom scenarios, you can manually override the network status:

```tsx
networkManager.setNetworkStatus(false);
networkManager.setNetworkStatus(true);
networkManager.clearManualOverride();
```

When a manual override is active, the browser's actual connectivity events are ignored.

### Reactive signal

The network manager exposes its status as a reactive signal. You can read it directly in reactive functions:

```tsx
const onlineSignal = networkManager.getOnlineSignal();
```

---

## Network Modes

Each query can configure how it behaves when the device is offline. Set `networkMode` in the query's `config` property:

```tsx
import { RESTQuery, t, NetworkMode } from 'fetchium';

class GetUser extends RESTQuery {
  params = { id: t.id };

  path = `/users/${this.params.id}`;

  result = { id: t.id, name: t.string };

  config = {
    networkMode: NetworkMode.OfflineFirst,
  };
}
```

There are three network modes:

### `NetworkMode.Online` (default)

The query only fetches when the device is online. If the device goes offline while a query is active, the query pauses and resumes automatically when connectivity is restored.

This is the safest default --- it prevents failed requests and unnecessary retries while offline.

### `NetworkMode.Always`

The query fetches regardless of network status. Use this when you have a local server, service worker, or other mechanism that can handle requests even without internet access.

### `NetworkMode.OfflineFirst`

If cached data exists, the query returns it immediately even when offline. When the device comes back online, the query refetches to get fresh data (assuming the data is stale).

This mode is ideal for applications that need to show something to the user even when there is no connection.

{% callout %}
When using `NetworkMode.OfflineFirst`, pair it with a `QueryStore` that persists data across sessions. Otherwise, the cache will be empty on a fresh app launch and there will be nothing to show while offline.
{% /callout %}

### Refetch on reconnect

By default, queries with `NetworkMode.Online` or `NetworkMode.OfflineFirst` refetch stale data when the device reconnects. You can disable this behavior:

```tsx
config = {
  networkMode: NetworkMode.Online,
  refreshStaleOnReconnect: false,
};
```

---

## Query Stores

A query store is responsible for persisting query results and entity data to a durable backend. Fetchium provides two implementations: a synchronous store for in-memory or localStorage-style backends, and an asynchronous store for IndexedDB, AsyncStorage, or cross-worker architectures.

### SyncQueryStore

The `SyncQueryStore` wraps a synchronous key-value store. It is the simplest option and works well for most applications.

```tsx
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';

const store = new SyncQueryStore(new MemoryPersistentStore());
const client = new QueryClient(store, { fetch });
```

The `MemoryPersistentStore` keeps everything in memory --- data is lost when the page is refreshed. For persistence across sessions, implement the `SyncPersistentStore` interface with a durable backend like `localStorage`.

### AsyncQueryStore

The `AsyncQueryStore` is designed for asynchronous storage backends such as IndexedDB or React Native's AsyncStorage. It uses a writer-reader architecture where one instance (the writer) owns the backing store, and other instances (readers) communicate with it via messages.

```tsx
import { AsyncQueryStore } from 'fetchium/stores/async';

const store = new AsyncQueryStore({
  isWriter: true,
  connect: (handleMessage) => ({
    sendMessage: (msg) => handleMessage(msg),
  }),
  delegate: myAsyncPersistentStore,
});
```

**Writer vs reader:**

- The **writer** (`isWriter: true`) is the only instance that writes to the backing store. It must be provided a `delegate` (an `AsyncPersistentStore` implementation).
- **Readers** (`isWriter: false`) send write operations to the writer via messages and can load data directly from their own delegate (if provided).

This architecture ensures serialized writes even when multiple tabs or workers are involved.

---

## Custom Persistent Stores

To build a custom persistence backend, implement either the `SyncPersistentStore` or `AsyncPersistentStore` interface. Both share the same shape --- the async version wraps each method in a `Promise`.

The store needs to handle three data types: strings (for serialized JSON values), numbers (for timestamps and reference counts), and `Uint32Array` buffers (for entity ID sets and LRU queues).

### Example: localStorage adapter

```tsx
class LocalStoragePersistentStore implements SyncPersistentStore {
  has(key: string): boolean {
    return localStorage.getItem(key) !== null;
  }

  getString(key: string): string | undefined {
    return localStorage.getItem(key) ?? undefined;
  }

  setString(key: string, value: string): void {
    localStorage.setItem(key, value);
  }

  getNumber(key: string): number | undefined {
    const v = localStorage.getItem(key);
    return v !== null ? Number(v) : undefined;
  }

  setNumber(key: string, value: number): void {
    localStorage.setItem(key, String(value));
  }

  getBuffer(key: string): Uint32Array | undefined {
    const v = localStorage.getItem(key);
    if (v === null) return undefined;
    return new Uint32Array(JSON.parse(v));
  }

  setBuffer(key: string, value: Uint32Array): void {
    localStorage.setItem(key, JSON.stringify(Array.from(value)));
  }

  delete(key: string): void {
    localStorage.removeItem(key);
  }

  getAllKeys(): string[] {
    return Object.keys(localStorage);
  }
}
```

{% callout type="warning" %}
`localStorage` has a 5 MB limit in most browsers. For larger datasets, consider using IndexedDB via the `AsyncQueryStore` instead.
{% /callout %}

For complete API details on both store types, see the [stores/sync](/api/stores-sync) and [stores/async](/api/stores-async) API reference pages.

---

## Putting It All Together

Here is a complete example that sets up a `QueryClient` with persistence and network awareness for an offline-capable application:

```tsx
import { QueryClient, NetworkManager } from 'fetchium';
import { SyncQueryStore } from 'fetchium/stores/sync';

const store = new SyncQueryStore(new LocalStoragePersistentStore());
const networkManager = new NetworkManager();

const client = new QueryClient(store, {
  fetch: globalThis.fetch,
  baseUrl: 'https://api.example.com',
}, networkManager);
```

With this setup:

- Query results are persisted to `localStorage` and survive page refreshes
- Queries automatically pause when the device goes offline and resume when it reconnects
- Unused queries are evicted from memory after their `gcTime` expires, but their persisted data remains in `localStorage` for the next session

Configure individual queries for offline behavior:

```tsx
class GetDashboard extends RESTQuery {
  path = '/dashboard';

  result = { stats: t.object({ visits: t.number }) };

  config = {
    networkMode: NetworkMode.OfflineFirst,
    staleTime: 60_000,
  };
}
```

---

## Next Steps

{% quick-links %}

{% quick-link title="Caching & Refetching" icon="presets" href="/data/caching" description="Understand staleTime, gcTime, cacheTime, and cache invalidation patterns" /%}

{% quick-link title="stores/sync API" icon="plugins" href="/api/stores-sync" description="Full API reference for the synchronous query store" /%}

{% quick-link title="stores/async API" icon="theming" href="/api/stores-async" description="Full API reference for the asynchronous query store" /%}

{% /quick-links %}
