---
title: fetchium/stores/sync
description: API reference for the synchronous query store.
---

# fetchium/stores/sync

Synchronous query store implementation for Fetchium. Provides in-memory and pluggable persistent storage with LRU cache eviction and reference-counted entity cleanup.

```ts
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import type { SyncPersistentStore } from 'fetchium/stores/sync';
```

---

## Classes

### `SyncQueryStore`

Implements the `QueryStore` interface using a synchronous key-value backend. Manages an LRU queue per query class and automatically evicts the oldest entries when the queue exceeds `maxCount`. Entity data is reference-counted; entities are cascade-deleted when their reference count reaches zero.

#### Constructor

```ts
new SyncQueryStore(kv: SyncPersistentStore)
```

| Parameter | Type                  | Description                                 |
| --------- | --------------------- | ------------------------------------------- |
| `kv`      | `SyncPersistentStore` | The underlying synchronous key-value store. |

#### Methods

| Method                     | Signature                                                                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadQuery`                | `(queryDef: QueryDefinition, queryKey: number): CachedQuery \| undefined`                                      | Loads a cached query by key. Returns `undefined` if the cache entry has expired (beyond `cacheTime`) or does not exist. Also preloads referenced entities.                                                                                                                                                                                                                                                                                            |
| `saveQuery`                | `(queryDef: QueryDefinition, queryKey: number, value: unknown, updatedAt: number, refIds?: Set<number>): void` | Persists a query result, its timestamp, and entity reference IDs. Activates the query in the LRU queue.                                                                                                                                                                                                                                                                                                                                               |
| `saveEntity`               | `(entityKey: number, value: unknown, refIds?: Set<number>, rest?: string): void`                               | Persists an entity's serialized data and its child entity references. Manages reference counts for nested entities. `rest`, when given, is a JSON object body of fields the record already held that no class applied to the in-memory entity declares; it is written with the value so the write does not delete them.                                                                                                                               |
| `mergeEntity`              | `(entityKey: number, fields: unknown, refIds?: Set<number>): void`                                             | Merges `fields` over the stored record, or writes them as the record if none is stored.                                                                                                                                                                                                                                                                                                                                                               |
| `activateQuery`            | `(queryDef: QueryDefinition, queryKey: number): void`                                                          | Moves a query to the front of its class's LRU queue, evicting the oldest entry when full.                                                                                                                                                                                                                                                                                                                                                             |
| `deleteQuery`              | `(queryKey: number): void`                                                                                     | Deletes a query's stored value, reference IDs, and decrements reference counts for all referenced entities.                                                                                                                                                                                                                                                                                                                                           |
| `purgeStaleQueries`        | `(): void`                                                                                                     | Scans all query classes and removes those whose `lastUsedAt` timestamp exceeds their `cacheTime`. Called automatically on `QueryClient` construction.                                                                                                                                                                                                                                                                                                 |
| `onDelete`                 | `(listener: (key: number) => void): () => void`                                                                | Calls `listener` with each record the store deletes on its own (eviction, cascade, purge). Returns an unsubscribe function.                                                                                                                                                                                                                                                                                                                           |
| `hasEntity`                | `(key: number): boolean`                                                                                       | Whether a record is stored for `key`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `readEntity`               | `(entityKey: number): Record<string, unknown> \| undefined`                                                    | The stored record of an entity, parsed, or `undefined`. The client reads it once, before the first write of an entity whose record may hold fields of another class of its typename, so that write keeps them.                                                                                                                                                                                                                                        |
| `getEntityFieldNames`      | `(typename: string): readonly string[] \| undefined`                                                           | The top-level field names the entity classes of `typename` declared, in this session or an earlier one (stored under `sq:meta:fields:<typename>`). A name no class has declared for 30 days is forgotten.                                                                                                                                                                                                                                             |
| `addEntityFieldNames`      | `(typename: string, fields: readonly string[]): void`                                                          | Records that a class of `typename` declares `fields`. Called once per class and client; writes only when a name is new or its time is over a day old.                                                                                                                                                                                                                                                                                                 |
| `entityFieldNamesComplete` | `(): boolean`                                                                                                  | Whether the remembered field names cover every record in the store. `false` for 30 days after this version first opens the store, since records an earlier version wrote may hold fields of a class not registered since. `true` after `clear()`. While `false`, an entity built from streamed events is merged into its stored record instead of replacing it.                                                                                       |
| `clear`                    | `(): void`                                                                                                     | Deletes every cached query, entity record and queue (`sq:doc:` keys) and reports each record to `onDelete` listeners, so a client over the store drops the fields it kept from those records. Wipe the cache with this, not on the `kv` directly: a client is not told about records deleted under it, and its next write of an entity of a typename two classes share puts the other class's deleted fields back. Field names (`sq:meta:`) are kept. |

---

### `MemoryPersistentStore`

In-memory implementation of `SyncPersistentStore`. Stores all data in a plain JavaScript object. Suitable for development, testing, and applications that do not need persistence across sessions.

#### Constructor

```ts
new MemoryPersistentStore();
```

No parameters. Creates an empty store.

#### Methods

Implements all methods of `SyncPersistentStore` (see interface below).

---

## Interfaces

### `SyncPersistentStore`

The interface for synchronous key-value storage backends. Implement this to plug in custom storage (e.g., `localStorage`, synchronous SQLite, shared memory).

```ts
interface SyncPersistentStore {
  has(key: string): boolean;

  getString(key: string): string | undefined;
  setString(key: string, value: string): void;

  getNumber(key: string): number | undefined;
  setNumber(key: string, value: number): void;

  getBuffer(key: string): Uint32Array | undefined;
  setBuffer(key: string, value: Uint32Array): void;

  delete(key: string): void;

  getAllKeys(): string[];
}
```

| Method       | Signature                                 | Description                                                                                 |
| ------------ | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| `has`        | `(key: string): boolean`                  | Returns `true` if the key exists in the store.                                              |
| `getString`  | `(key: string): string \| undefined`      | Retrieves a string value by key.                                                            |
| `setString`  | `(key: string, value: string): void`      | Stores a string value.                                                                      |
| `getNumber`  | `(key: string): number \| undefined`      | Retrieves a numeric value by key.                                                           |
| `setNumber`  | `(key: string, value: number): void`      | Stores a numeric value.                                                                     |
| `getBuffer`  | `(key: string): Uint32Array \| undefined` | Retrieves a `Uint32Array` buffer by key. Used for LRU queues and entity reference ID lists. |
| `setBuffer`  | `(key: string, value: Uint32Array): void` | Stores a `Uint32Array` buffer.                                                              |
| `delete`     | `(key: string): void`                     | Deletes a key and its associated value.                                                     |
| `getAllKeys` | `(): string[]`                            | Returns all keys in the store. Used by `purgeStaleQueries` to scan for expired entries.     |

---

## Storage key layout

Internally, `SyncQueryStore` uses the following key prefixes in the underlying `SyncPersistentStore`:

| Prefix / Pattern  | Value type    | Description                                         |
| ----------------- | ------------- | --------------------------------------------------- |
| `v:{id}`          | `string`      | JSON-serialized value for a query or entity.        |
| `u:{id}`          | `number`      | `updatedAt` timestamp (ms since epoch) for a query. |
| `r:{id}`          | `Uint32Array` | Entity reference IDs for a query or entity.         |
| `rc:{id}`         | `number`      | Reference count for an entity.                      |
| `q:{queryDefId}`  | `Uint32Array` | LRU queue buffer for a query class.                 |
| `lu:{queryDefId}` | `number`      | Last-used timestamp for a query class.              |
| `ct:{queryDefId}` | `number`      | Cache time (minutes) for a query class.             |

---

## Example

```ts
import { QueryClient } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { RESTQueryAdapter } from 'fetchium/rest';

// Create an in-memory store
const store = new SyncQueryStore(new MemoryPersistentStore());

// Create the query client
const client = new QueryClient({
  store,
  adapters: [
    new RESTQueryAdapter({
      fetch: globalThis.fetch,
      baseUrl: 'https://api.example.com',
    }),
  ],
});
```
