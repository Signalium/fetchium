# fetchium

## 0.4.2

### Patch Changes

- 117531d: Add `getTopic()` to `TopicQuery` for parity with `getPath()` on `RESTQuery`. The static `topic` template only supports fixed-shape topics, so consumers with variable-segment-count or conditionally-shaped topics had to hand-author one query class per shape. Subclasses can now override `getTopic()` to compute the topic dynamically at execution time over the resolved params (e.g. `'layout:' + this.params.segments.map(encodeURIComponent).join(':')`); when defined it takes precedence over the `topic` field. The `topic` field is now optional, matching `path?` on `RESTQuery`. Existing queries that define `topic` as a static template continue to work unchanged.

## 0.4.1

### Patch Changes

- f7aaa5c: Fix reactive `getConfig()` not reacting to error responses when the response body fails to parse against the result schema. Previously `runQuery` only called `reconcileSubscription` after `applyData` succeeded, so a 404 (or any other status) whose body did not match the entity shape would throw inside `parseEntities`, skip the reconcile, and leave the running subscriber installed against stale config. The reconcile call is now in a `finally` block so it fires after every fetch attempt, regardless of whether parsing succeeds.

## 0.4.0

### Minor Changes

- 088a23b: **Breaking:** `getConfig()` is now memoized via a `reactiveSignal` instead of being recomputed on every fetch; it only re-runs when a signal consumed inside notifies. Existing implementations that read mutable execution-context state directly (most commonly `this.response`) silently return stale config after first evaluation, because plain field reads track no signals. To react to new responses, wrap the read in a `reactiveSignal` thunk that consumes the newly-exposed `this.responseNotifier` (a Signalium `Notifier` on the execution context, fired by `RESTQueryAdapter` after each request): `reactiveSignal(() => { this.responseNotifier.consume(); return this.response?.ok; }).value`. `getConfig()` implementations that don't read mutable ctx state continue to work unchanged.

## 0.3.1

### Patch Changes

- 82bcd70: Fix entity reactivity across the React boundary. The entity proxy's `get` trap was short-circuiting all symbol-keyed property access to `undefined`, which blocked Signalium's `registerCustomSnapshot` from finding its handler (stored under a private symbol on the prototype). Symbol gets now resolve via `Reflect.get` against the entity prototype. With that in place, the per-class `ensureEntitySnapshotRegistered` bookkeeping is no longer needed — Signalium's prototype-chain resolution makes a single registration on the `Entity` base class apply to all user-defined entity subclasses.

## 0.3.0

### Minor Changes

- 7288ebf: Upgrade to Signalium v3 and React 19.

  ### Peer dependency bumps
  - `signalium` peer is now `>=3.0.0` (was `>=2.1.7`).
  - `react` peer is now `>=19.0.0` (was `>=18.3.1`). Required by Signalium v3 for `React.cache` and React 19's thenable handling in `<Suspense>`.

  ### API changes
  - `QueryPromise<T>` now resolves to `ReactivePromise<QueryResult<T>>`. In Signalium v3 `ReactivePromise<T>` is itself the discriminated union (the v2 `DiscriminatedReactivePromise<T>` alias has been removed upstream), so `if (p.isReady)` narrows `p.value` to `T` directly without the previous extra type gymnastics. No call-site changes are required for code that already used `QueryPromise<T>`.
  - `useQuery` is now a thin wrapper around v3's deep-by-default `useReactive`. The previous hand-rolled `cloneDeep` proxy implementation has been removed — Signalium v3 provides structurally-shared snapshots natively, so `React.memo` on subtree props now correctly skips re-renders when the underlying data is unchanged.

  ### Internal
  - Registers a custom Signalium snapshot for entity proxies (`registerCustomSnapshot`), so `useReactive` / `useQuery` correctly walk into entities at the React boundary and re-render on field changes.
  - All `useReactive(fn, ...args)` call sites in tests updated to the v3 thunk form `useReactive(() => fn(...args))`.
  - `SuspendSignalsProvider` references replaced with `PauseSignalsProvider` (renamed upstream in v3).

## 0.2.4

### Patch Changes

- 49c1207: `queryClient.invalidateQueries(...)` now refetches any currently-mounted consumer of the matched queries, matching the React Query / SWR contract. Previously `markStale()` only reset `updatedAt`, so an active consumer kept showing stale data until it remounted; now `markStale()` also kicks a debounced refetch on the active relay (deduped against any in-flight fetch). Unmounted queries are still just marked stale: the next activation picks up the refetch via the existing stale-on-activate path.

## 0.2.3

### Patch Changes

- c024d0a: `TopicQuery` subclasses now inherit their adapter from the base, and `QueryClient.getAdapter()` resolves an abstract adapter class on a query to a consumer-registered concrete subclass. Generated and hand-authored `TopicQuery` classes no longer need a per-class `static adapter` override. In dev, ambiguous registrations (more than one adapter that matches the same lookup) throw with a clear error.

## 0.2.2

### Patch Changes

- 306cb3c: Allow concrete adapter subclasses with required constructor args to be assigned to `static adapter` without casts
- f1145c8: Fix relay not recovering after deactivation during in-flight refetch
- 8b327ae: Accept `NoOpNetworkManager` in `QueryClientConfig.networkManager` without a cast, mirroring the existing `gcManager` pattern

## 0.2.1

### Patch Changes

- a498bc9: Fix withRetry and sleep using AbortSignal APIs unavailable on Hermes (React Native)

## 0.2.0

### Minor Changes

- 2107b32: Rename *Controller to *Adapter across the entire API surface. `QueryController`, `RESTQueryController`, and `TopicQueryController` are now `QueryAdapter`, `RESTQueryAdapter`, and `TopicQueryAdapter`. The `static controller` property on Query/Mutation classes is now `static adapter`, and the `controllers` option on `QueryClient` is now `adapters`.

## 0.1.1

### Patch Changes

- 610f77f: Export `TypeDefSymbol` so downstream consumers can emit `.d.ts` files without TS4029 errors when using `TypeDef<T>` in public type positions, such as when extending `Entity`.

## 0.1.0

### Minor Changes

- c92035c: Initial pre-release of Fetchium

## 1.1.2

### Patch Changes

- 0b6b650: Add setSuspended API for more explicit suspension support

## 1.1.1

### Patch Changes

- bb0a5a9: Fix entity proxies not being created for preloaded entities from cache, and `__entityRef` not being resolved in proxy get handler. This fixes validation errors when accessing nested entities loaded from persistent cache.

## 1.1.0

### Minor Changes

- af443c5: Add request body support to query() function

  Queries can now send JSON request bodies for POST requests, enabling read-like operations that require complex data structures (e.g., fetching prices for an array of tokens).

  **New features:**
  - Added `body` field to query definitions for specifying request body schema
  - Body parameters are automatically serialized as JSON with `Content-Type: application/json` header
  - Body params work alongside path params and search params
  - All query features (caching, staleTime, deduplication) work with body queries

  **API changes:**
  - Query methods are now restricted to `GET` and `POST` only (PUT, PATCH, DELETE should use `mutation()`)

  **Example:**

  ```typescript
  const getPrices = query(() => ({
    path: '/prices',
    method: 'POST',
    body: {
      tokens: t.array(t.string),
    },
    searchParams: {
      currency: t.string,
    },
    response: {
      prices: t.array(t.object({ token: t.string, price: t.number })),
    },
    cache: { staleTime: 30_000 },
  }));

  // Usage: POST /prices?currency=USD with body: {"tokens":["ETH","BTC"]}
  const result = getPrices({ tokens: ['ETH', 'BTC'], currency: 'USD' });
  ```

## 1.0.18

### Patch Changes

- 395730a: Fix entity cache keys to include shapeKey, preventing stale entity validation errors after schema changes

## 1.0.17

### Patch Changes

- b244daa: Fix infinite query cache hydration and Hermes Uint32Array compatibility
  - Fix Hermes (React Native) compatibility by spreading Set to Array before Uint32Array conversion, which prevents empty refIds buffers
  - Fix infinite query cache loading by properly handling the array of pages when parsing entities, ensuring entity proxies resolve correctly after app restart

## 1.0.16

### Patch Changes

- 4a3bc06: Fix union parseValue check

## 1.0.15

### Patch Changes

- a95ed74: Ensure entities have a unique prototype
- aa50869: Fix Record parsing and reorganize/expand parsing tests

## 1.0.14

### Patch Changes

- 7462836: Add mutation support
- 84265ca: Add API resilience features:
  - Array filtering for parse failures
  - Undefined fallback for optional types
  - `t.result` wrapper for handling and exposing parse errors directly
- f07ed0e: Add separate dev-mode and prod-mode builds
- 093cbb2: Add baseUrl and ability to override baseUrl + other request options
- Updated dependencies [f07ed0e]
  - signalium@2.1.6

## 1.0.13

### Patch Changes

- d2d633e: Ensure Entity methods can call other methods

## 1.0.12

### Patch Changes

- f3e1ef0: Fix case-insensitive enum type inference
- 11116da: Add more tests for shapeKey and fix some small issues
- 0219742: Fix initialization error handling
- Updated dependencies [985abb0]
  - signalium@2.1.5

## 1.0.11

### Patch Changes

- 7f94377: Fixup format registry and add global format type registry
- d1f9def: Add ability to defined cached methods to entities
- e0a4844: Add ability for Entities to subscribe to streams when in use
- 6b961f0: Add support for Signal query parameters and debounced updates
- Updated dependencies [2cf6766]
  - signalium@2.1.4

## 1.0.10

### Patch Changes

- 24495ac: Add t.enum.caseInsensitive()
- 047d4dc: Allow all primitive types in search params
- 9b2c2f3: Add extend to Entity and Object typedefs
- c8fc4b8: Allow typenames to be optional on entities
- 0245106: Add streamOrphans and optimisticInserts

## 1.0.9

### Patch Changes

- 9257412: Add t.optional/t.nullable/t.nullish
- Updated dependencies [7350348]
- Updated dependencies [c78b461]
  - signalium@2.1.2

## 1.0.8

### Patch Changes

- f76ade3: Add support for stream and infinite queries for useQuery results

## 1.0.7

### Patch Changes

- 82e7818: Add useQuery for reading query results. Calling `useReactive` on a query result
  will cause the result itself to entangle, but not the value of the result (e.g.
  the entities inside the result). This can lead to cases where the result is not
  re-rendered when the entities inside the result change. By cloning the result,
  we effectively reify it and force it to flatten, entangling all of the nested
  entities with that read from React.

## 1.0.6

### Patch Changes

- c883a52: Add no-op implementations of MemoryEvictionManager, RefetchManager, and NetworkManager for SSR environments. These can be injected into QueryClient constructor to avoid creating timers and event listeners in server-side rendering contexts.

## 1.0.5

### Patch Changes

- 00ae954: Signalium:
  - Add support for Sets, Maps, and Dates in the `hashValue` function
    - Note: This may cause some _minor_ differences in reactive functions that receive these types as parameters, they should essentially run less often in those cases. The impact of this should be minimal, so we're not considering it a breaking change.

  Query:
  - Add shape checking to make sure that if the shape of a query is changed, the query key will change as well, preventing stale data with a different shape from being returned from the query store
  - Fix an issue where shrinking the `maxCount` of a query would cause an error when trying to activate the query

- Updated dependencies [00ae954]
  - signalium@2.1.1

## 1.0.4

### Patch Changes

- e202f05: Fix package.json main export

## 1.0.3

### Patch Changes

- cfe249d: Export QueryClientContext

## 1.0.2

### Patch Changes

- 5f34de3: Add exports for entity and registerFormat

## 1.0.1

### Patch Changes

- 39d3df8: Export type definitions for queries

## 1.0.0

### Minor Changes

- 1a94943: Add NetworkManager and network mode options
- 0f609e4: Adds infinite query, includes some minor breaking API changes
- 4c35e93: Add Stream Query support
- f59a776: Add async store and split out stores into separate import paths

### Patch Changes

- Updated dependencies [e64597d]
- Updated dependencies [4c35e93]
  - signalium@2.1.0

## 0.1.0

### Minor Changes

- 919ecd9: Remove unused decoders dependency and prepare for initial pre-release

## 0.0.2

### Patch Changes

- 6eddfdc: Adds `staleTime`, `gcTime`, and `refetchInterval` options to queries.
- Updated dependencies [6eddfdc]
  - signalium@2.0.9

## 0.0.1

### Patch Changes

- e6c39ee: Initial Signalium Query release
- Updated dependencies [e6c39ee]
  - signalium@2.0.7
