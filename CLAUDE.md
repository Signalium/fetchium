# Fetchium

Reactive data-fetching and entity management library built on [Signalium](https://github.com/Signalium/signalium). Monorepo with the core package plus a docs site.

## Repository structure

```
packages/
  fetchium/   Core library (the published package)
docs/         Documentation site (Next.js + Markdoc)
```

Package manager: **npm** workspaces. Task runner: **turbo**.

## Commands

```sh
# From repo root
npm run test          # all tests via turbo
npm run build         # all packages via turbo
npm run check-types   # tsc --noEmit for all packages
npm run lint          # eslint + prettier

# From packages/fetchium
npm test              # all vitest projects (unit + react)
npm run test:unit     # non-React tests only (node env, fast)
npm run test:react    # browser tests (Playwright via @vitest/browser)
npm run dev:unit      # watch mode for unit tests
npm run check-types   # tsc --noEmit
```

React tests run in a **real browser** (Playwright/Chromium, headless). Unit tests run in Node. Both use vitest.

## Global compile-time constant

`IS_DEV` is a global boolean replaced at build time:

- In tests and dev builds: `true`
- In production builds: `false`, all `if (IS_DEV)` blocks are tree-shaken

Declared in `packages/fetchium/src/globals.d.ts`. Do NOT import it — it's a bare global.

---

## Package: fetchium

### Entry points

| Import path             | Source                    |
| ----------------------- | ------------------------ |
| `fetchium`              | `src/index.ts`           |
| `fetchium/react`        | `src/react/index.ts`     |
| `fetchium/stores/sync`  | `src/stores/sync.ts`     |
| `fetchium/stores/async` | `src/stores/async.ts`    |

### Key source files

| File                       | Purpose                                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `query.ts`                 | `Query` base class, `fetchQuery()`, `QueryDefinition`                                                             |
| `QueryResult.ts`           | `QueryInstance` — manages a single query's lifecycle (relay, fetch, cache, refetch)                               |
| `QueryClient.ts`           | `QueryClient` — central coordinator. Manages query instances, entity store, cache, context                        |
| `proxy.ts`                 | `Entity` base class, `createEntityProxy()` — Proxy-based entity objects with lazy parsing                         |
| `parseEntities.ts`         | Entity extraction during response parsing — normalizes entities into the store                                    |
| `EntityMap.ts`             | `PreloadedEntityRecord` type, entity store data structures                                                        |
| `typeDefs.ts`              | `t` type DSL (`t.string`, `t.entity()`, `t.array()`, etc.), `ValidatorDef`, `reifyShape()`                        |
| `types.ts`                 | TypeScript types: `Mask` enum, `EntityDef`, `ObjectDef`, `QueryResult<T>`, `QueryPromise<T>`                      |
| `mutation.ts`              | `Mutation` base class, `getMutation()`                                                                            |
| `NetworkManager.ts`        | Online/offline detection via signal                                                                               |
| `MemoryEvictionManager.ts` | Schedules query eviction after deactivation                                                                       |
| `RefetchManager.ts`        | Periodic refetch for stale queries                                                                                |

### Entity system

Entities are normalized: each unique `(typename, id, shapeKey)` maps to one `PreloadedEntityRecord` in the entity store.

The entity proxy (`createEntityProxy`):

1. On property access: calls `notifier.consume()` (reactive tracking), activates relay if present, parses/caches the value
2. Handles `__entityRef` hydration for nested entities loaded from cache
3. Wraps methods via `reactiveMethod()`
4. Implements `CONSUME_DEEP` using `subEntityPaths` for efficient deep traversal with cycle protection

### Query lifecycle

1. `fetchQuery(QueryClass, params)` → gets/creates a `QueryInstance` (memoized by query key)
2. `QueryInstance` creates a `relay()` that manages the query subscription
3. On activation: loads from cache, then fetches if stale, sets up refetch intervals and stream subscriptions
4. Data is parsed via `parseEntities()` which normalizes entities into the store and returns proxied objects
5. For object-shaped responses, a persistent query proxy is created once; updates swap the underlying `_data` and fire `_notifier`

### Test patterns

- **Unit tests** (`src/__tests__/`): Use `createMockFetch()` from `utils.ts`, `SyncQueryStore` with `MemoryPersistentStore`
- **React tests** (`src/react/__tests__/`): Use `vitest-browser-react`, `ContextProvider` with `QueryClientContext`
- The signalium Babel preset is applied in `vitest.config.ts` for async transform support

### Build

Vite library build producing ESM + CJS, with development/production variants. `signalium` and its subpaths are external dependencies.

---

## Docs site (`docs/`)

Next.js 14 static export site using Markdoc for content, Tailwind CSS 4 for styling. Has its own eslint config (`next/core-web-vitals`) and prettier config (with `prettier-plugin-tailwindcss`).

Deployed to GitHub Pages via `.github/workflows/deploy.yml`.
