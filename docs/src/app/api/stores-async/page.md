---
title: fetchium/stores/async
description: API reference for the asynchronous query store.
---

# fetchium/stores/async

Asynchronous query store implementation for Fetchium. Designed for multi-threaded or cross-context architectures (e.g., Web Workers, Service Workers, React Native bridge) where storage operations must be serialized through a message channel.

```ts
import { AsyncQueryStore } from 'fetchium/stores/async';
import type {
  AsyncQueryStoreConfig,
  AsyncPersistentStore,
  StoreMessage,
} from 'fetchium/stores/async';
```

---

## Classes

### `AsyncQueryStore`

Implements the `QueryStore` interface with an asynchronous message-passing architecture. Operates in one of two modes:

- **Writer mode** (`isWriter: true`): Receives messages from readers and processes them serially against an `AsyncPersistentStore` delegate. Must be provided a `delegate`.
- **Reader mode** (`isWriter: false`): Sends all write operations as messages to the writer via the `sendMessage` channel. Does not perform storage operations directly.

Both modes share the same `QueryStore` interface so they can be used interchangeably with `QueryClient`.

#### Constructor

```ts
new AsyncQueryStore(config: AsyncQueryStoreConfig)
```

| Parameter | Type                    | Description                                 |
| --------- | ----------------------- | ------------------------------------------- |
| `config`  | `AsyncQueryStoreConfig` | Configuration object (see interface below). |

#### Methods

| Method              | Signature                                                                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `loadQuery`         | `(queryDef: QueryDefinition, queryKey: number): Promise<CachedQuery \| undefined>`                             | Loads a cached query. Only works when a `delegate` is available (writer mode). Returns `undefined` if no delegate, if the entry has expired, or if it does not exist. Preloads referenced entities.                                                                                                                                                                                           |
| `saveQuery`         | `(queryDef: QueryDefinition, queryKey: number, value: unknown, updatedAt: number, refIds?: Set<number>): void` | Dispatches a save-query message. In writer mode, enqueues for serial processing. In reader mode, sends via `sendMessage`.                                                                                                                                                                                                                                                                     |
| `saveEntity`        | `(entityKey: number, value: unknown, refIds?: Set<number>): void`                                              | Dispatches a save-entity message.                                                                                                                                                                                                                                                                                                                                                             |
| `mergeEntity`       | `(entityKey: number, fields: unknown, refIds?: Set<number>): void`                                             | Dispatches a save-entity message with `merge: true`; the writer merges `fields` over the stored record, if there is one (see `SyncQueryStore.mergeEntity`).                                                                                                                                                                                                                                   |
| `activateQuery`     | `(queryDef: QueryDefinition, queryKey: number): void`                                                          | Dispatches an activate-query message to update the LRU queue. A queue persisted with a different `maxCount` is resized by the writer: growing reallocates it, shrinking evicts the keys that no longer fit.                                                                                                                                                                                   |
| `deleteQuery`       | `(queryKey: number): void`                                                                                     | Dispatches a delete-query message.                                                                                                                                                                                                                                                                                                                                                            |
| `purgeStaleQueries` | `(): Promise<void>`                                                                                            | Scans all stored query classes and removes expired entries. In writer mode it runs through the same serial queue as the messages, after everything queued before it; a reader with its own `delegate` runs it directly. Only operates when a `delegate` is available.                                                                                                                         |
| `onDelete`          | `(listener: (key: number) => void): () => void`                                                                | Writer mode only. Registers a listener called with the key of every record the writer drops on its own (an LRU eviction, a reference-count cascade, a purge) or fails to write. Returns an unsubscribe function.                                                                                                                                                                              |
| `onPersisted`       | `(listener: (key: number) => void): () => void`                                                                | Writer mode only. Registers a listener called with the key of every entity record a queued write has stored. Returns an unsubscribe function.                                                                                                                                                                                                                                                 |
| `isSettled`         | `(): boolean`                                                                                                  | Whether every operation handed to the writer has been applied (nothing queued, nothing mid-flight). Always `true` in reader mode.                                                                                                                                                                                                                                                             |
| `hasEntity`         | `(key: number): boolean \| undefined`                                                                          | Writer mode only. Whether the delegate holds a record for the key, answered from a set the writer reads from the delegate when it starts (alongside its queue, not ahead of it) and keeps current with every write it queues and every deletion it performs. `undefined` for a key it has not written itself until that read lands; after a read that keeps failing, nothing is assumed held. |

---

## Interfaces

### `AsyncQueryStoreConfig`

Configuration for constructing an `AsyncQueryStore`.

```ts
interface AsyncQueryStoreConfig {
  isWriter: boolean;
  connect: (handleMessage: (msg: StoreMessage) => void) => {
    sendMessage: (msg: StoreMessage) => void;
  };
  delegate?: AsyncPersistentStore;
}
```

| Property   | Type                                                                                           | Description                                                                                                                                                                                                     |
| ---------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isWriter` | `boolean`                                                                                      | Whether this instance is the writer (processes storage operations) or a reader (sends messages to the writer).                                                                                                  |
| `connect`  | `(handleMessage: (msg: StoreMessage) => void) => { sendMessage: (msg: StoreMessage) => void }` | Called during construction. Receives a `handleMessage` callback for incoming messages and must return an object with a `sendMessage` function for outgoing messages. This is the bidirectional message channel. |
| `delegate` | `AsyncPersistentStore \| undefined`                                                            | The async persistent storage backend. **Required for writers**, not used by readers.                                                                                                                            |

---

### `AsyncPersistentStore`

The interface for asynchronous key-value storage backends. All methods return Promises. Implement this to plug in async storage (e.g., IndexedDB, AsyncStorage, SQLite with async bridge).

```ts
interface AsyncPersistentStore {
  has(key: string): Promise<boolean>;

  getString(key: string): Promise<string | undefined>;
  setString(key: string, value: string): Promise<void>;

  getNumber(key: string): Promise<number | undefined>;
  setNumber(key: string, value: number): Promise<void>;

  getBuffer(key: string): Promise<Uint32Array | undefined>;
  setBuffer(key: string, value: Uint32Array): Promise<void>;

  delete(key: string): Promise<void>;

  getAllKeys(): Promise<string[]>;
}
```

| Method       | Signature                                          | Description                                    |
| ------------ | -------------------------------------------------- | ---------------------------------------------- |
| `has`        | `(key: string): Promise<boolean>`                  | Returns `true` if the key exists in the store. |
| `getString`  | `(key: string): Promise<string \| undefined>`      | Retrieves a string value by key.               |
| `setString`  | `(key: string, value: string): Promise<void>`      | Stores a string value.                         |
| `getNumber`  | `(key: string): Promise<number \| undefined>`      | Retrieves a numeric value by key.              |
| `setNumber`  | `(key: string, value: number): Promise<void>`      | Stores a numeric value.                        |
| `getBuffer`  | `(key: string): Promise<Uint32Array \| undefined>` | Retrieves a `Uint32Array` buffer by key.       |
| `setBuffer`  | `(key: string, value: Uint32Array): Promise<void>` | Stores a `Uint32Array` buffer.                 |
| `delete`     | `(key: string): Promise<void>`                     | Deletes a key and its associated value.        |
| `getAllKeys` | `(): Promise<string[]>`                            | Returns all keys in the store.                 |

---

### `StoreMessage`

The message types sent between reader and writer instances. This is a discriminated union on the `type` field.

```ts
type StoreMessage =
  | {
      type: 0; // SaveQuery
      queryDefId: string;
      queryKey: number;
      value: unknown;
      updatedAt: number;
      cacheTime: number;
      maxCount?: number; // absent from readers built before 0.6; the writer then keeps the queue's size
      refIds?: number[];
    }
  | {
      type: 1; // SaveEntity
      entityKey: number;
      value: unknown;
      refIds?: number[];
      merge?: boolean; // `value` holds only some fields: merge them over the stored record
    }
  | {
      type: 2; // ActivateQuery
      queryDefId: string;
      queryKey: number;
      cacheTime: number;
      maxCount?: number;
    }
  | {
      type: 3; // DeleteQuery
      queryKey: number;
    };
```

| Type value | Name            | Description                                                     |
| ---------- | --------------- | --------------------------------------------------------------- |
| `0`        | `SaveQuery`     | Persist a query result with its metadata and entity references. |
| `1`        | `SaveEntity`    | Persist an entity's data and child references.                  |
| `2`        | `ActivateQuery` | Move a query to the front of the LRU queue.                     |
| `3`        | `DeleteQuery`   | Delete a query and decrement its entity reference counts.       |

---

## Architecture

```
┌─────────────────┐         messages          ┌─────────────────────┐
│  Main Thread     │  ───────────────────────> │  Worker Thread      │
│  (Reader)        │                           │  (Writer)           │
│                  │  <─────────────────────── │                     │
│  AsyncQueryStore │      sendMessage          │  AsyncQueryStore    │
│  isWriter=false  │                           │  isWriter=true      │
│                  │                           │  delegate=IndexedDB │
└─────────────────┘                           └─────────────────────┘
```

- The **reader** (main thread) calls `saveQuery`, `saveEntity`, etc. These are serialized as `StoreMessage` objects and sent to the writer via `sendMessage`.
- The **writer** (worker thread) receives messages and processes them serially against the `AsyncPersistentStore` delegate. Serial processing prevents race conditions.
- `loadQuery` reads directly from the delegate (only available on the writer). For reader-side cache loading, load from the writer during initialization.

---

## Example: Web Worker setup

**Main thread (reader):**

```ts
import { QueryClient } from 'fetchium';
import { AsyncQueryStore } from 'fetchium/stores/async';
import { RESTQueryAdapter } from 'fetchium/rest';

const worker = new Worker('./store-worker.js');

const store = new AsyncQueryStore({
  isWriter: false,
  connect(handleMessage) {
    worker.onmessage = (e) => handleMessage(e.data);
    return {
      sendMessage: (msg) => worker.postMessage(msg),
    };
  },
});

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

**Worker thread (writer):**

```ts
import { AsyncQueryStore } from 'fetchium/stores/async';
import { MyIndexedDBStore } from './my-indexeddb-store';

const store = new AsyncQueryStore({
  isWriter: true,
  delegate: new MyIndexedDBStore(),
  connect(handleMessage) {
    self.onmessage = (e) => handleMessage(e.data);
    return {
      sendMessage: (msg) => self.postMessage(msg),
    };
  },
});
```
