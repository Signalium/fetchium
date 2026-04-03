---
description: Teach Fetchium concepts with thorough explanations, canonical examples, and documentation links. Use when the user wants to learn about Fetchium, understand how something works, or get a conceptual explanation.
---

# Fetchium Teach

Enter teaching mode. Provide thorough, accurate explanations of Fetchium concepts using the full documentation. Prioritize depth and clarity over brevity.

## Mode

If `$ARGUMENTS` contains "hooks" or "signalium", use that mode for all examples. Otherwise, auto-detect by checking the codebase for `signalium` or `signalium/react` imports. If Signalium is detected, show Signalium-style examples; otherwise default to React + Hooks examples.

## Instructions

1. **Read the docs first.** Before answering any question, read the relevant documentation files from `node_modules/fetchium/plugin/docs/`. The full documentation is available there as markdown files. Always ground your answers in the actual docs.

2. **Use canonical examples.** Use the examples from the documentation, not invented ones. The docs contain carefully crafted examples that demonstrate correct patterns and avoid common pitfalls.

3. **Link to the docs site.** For every concept you explain, include a link to the relevant page on the Fetchium docs site. Use these base URLs:

   | Topic | URL |
   |---|---|
   | Quick start | https://fetchium.dev/quickstart |
   | Project setup | https://fetchium.dev/setup/project-setup |
   | Queries | https://fetchium.dev/core/queries |
   | Types | https://fetchium.dev/core/types |
   | Entities | https://fetchium.dev/core/entities |
   | Mutations | https://fetchium.dev/data/mutations |
   | Live Data | https://fetchium.dev/data/live-data |
   | Caching & Refetching | https://fetchium.dev/data/caching |
   | Auth & Headers | https://fetchium.dev/guides/auth |
   | Error Handling | https://fetchium.dev/guides/error-handling |
   | Offline & Persistence | https://fetchium.dev/guides/offline |
   | Testing | https://fetchium.dev/guides/testing |
   | REST Queries | https://fetchium.dev/reference/rest-queries |
   | Pagination | https://fetchium.dev/reference/pagination |
   | Streaming | https://fetchium.dev/reference/streaming |
   | Why Signalium? | https://fetchium.dev/reference/why-signalium |
   | API: fetchium | https://fetchium.dev/api/fetchium |
   | API: fetchium/react | https://fetchium.dev/api/fetchium-react |
   | API: stores/sync | https://fetchium.dev/api/stores-sync |
   | API: stores/async | https://fetchium.dev/api/stores-async |

4. **Explain the mental model.** When appropriate, connect specific features to the broader Fetchium philosophy:
   - **Query-Mutation split**: queries read (reactive, automatic), mutations write (imperative, explicit)
   - **Entity normalization**: each `(typename, id)` maps to one proxy; updates propagate everywhere automatically
   - **Identity-stable proxies**: same entity always returns the same object reference across all queries
   - **Declarative effects**: mutations declare what changed (creates/updates/deletes), Fetchium handles propagation
   - **Resilience to API evolution**: optional fields fall back gracefully, arrays filter unparseable items, discriminated unions enable safe polymorphism
   - **Protocol agnosticism**: `RESTQuery`/`RESTMutation` are adapters; the core `Query`/`Mutation` classes work with any transport

5. **Compare to other libraries when asked.** When users ask how Fetchium compares to TanStack Query, Apollo, SWR, or similar libraries, highlight:
   - **vs TanStack Query**: Fetchium uses declarative mutation effects instead of imperative `onSuccess` callbacks. Entity normalization means updates propagate automatically without manual cache management. Queries are class-based definitions (protocol-agnostic) rather than inline hook calls.
   - **vs Apollo Client**: Similar entity normalization goals, but Fetchium is not tied to GraphQL. Fetchium's type DSL replaces GraphQL's type system for REST APIs. No code generation step needed.
   - **vs SWR**: SWR is focused on simple key-based caching. Fetchium adds entity normalization, typed query definitions, mutation effects, live data, and protocol adapters.

6. **Teach Signalium when relevant.** Only cover Signalium concepts if the user is using Signalium (detected via imports) or explicitly asks about it. When teaching Signalium in the context of Fetchium:
   - **Why Signalium over Hooks**: Signals eliminate the combinatorial complexity of composing multiple async operations. With Hooks, chaining two queries requires managing `isReady`/`isRejected` for both and combining their states. With Signalium's `reactive(async () => {...})`, you write sequential `await` calls and get a single `ReactivePromise` back.
   - **Key Signalium primitives**:
     - `signal(value)` — a reactive value. Reading it inside a reactive context creates a dependency.
     - `reactive(() => {...})` — a derived computation that re-runs when its dependencies change. The synchronous version returns the computed value; the async version returns a `ReactivePromise`.
     - `component(() => {...})` — wraps a React component in a reactive context. The component re-renders only when the signals it reads change, not on every parent render.
     - `watcher(() => {...})` — runs a side effect when dependencies change (similar to `useEffect` but dependency-tracked automatically).
   - **Fetchium + Signalium integration**: `fetchQuery()` returns a `ReactivePromise` that can be awaited inside `reactive(async () => {...})`. Multiple sequential queries compose naturally. `component()` replaces the need for `useQuery` — just call `fetchQuery()` directly inside the component body.
   - **Reference**: Point users to `node_modules/fetchium/plugin/docs/reference/why-signalium.md` for the full explanation and to the Signalium docs at https://signalium.dev for the framework itself.

7. **Provide glossary on request.** Key Fetchium terms:
   - **Entity**: A normalized data object with identity (`typename` + `id`), stored as a proxy in the entity store
   - **Query**: A parameterized read request. Class-based definition with `params` and `result`
   - **Mutation**: A parameterized write request with declared side effects (`creates`/`updates`/`deletes`)
   - **Type DSL (`t`)**: Fetchium's schema language for describing JSON shapes, used for params, results, and entity fields
   - **ReactivePromise**: The return type of queries — wraps an async value with `isReady`, `isPending`, `isResolved`, `isRejected`, `value`, `error`
   - **ReactiveTask**: The return type of `getMutation()` — wraps an imperative action with `.run()` and status properties
   - **LiveArray**: A reactive array of entities that auto-updates from entity events (creates/deletes)
   - **LiveValue**: A reactive derived value that auto-updates from entity events via reducers
   - **Identity-stable proxy**: The Proxy object returned for each entity — same `(typename, id)` always returns the same object
   - **Entity effects**: The `creates`/`updates`/`deletes` declarations on mutations that drive automatic cache updates
   - **QueryClient**: The central coordinator managing query instances, entity store, cache, and context

## Documentation Files

All documentation files are at `node_modules/fetchium/plugin/docs/`:

| File | Content |
|---|---|
| `quickstart.md` | Getting started guide |
| `setup/project-setup.md` | Project configuration |
| `core/queries.md` | Query definitions, class rules, usage with Hooks and Signalium |
| `core/types.md` | Full type DSL reference, union rules, format system |
| `core/entities.md` | Entity definitions, proxies, methods, subscriptions, deduplication |
| `data/mutations.md` | Mutation definitions, effects, optimistic updates, custom mutations |
| `data/live-data.md` | LiveArray, LiveValue, constraints, reducers |
| `data/caching.md` | Cache configuration, stale time, refetching |
| `guides/auth.md` | Authentication patterns, headers, context |
| `guides/error-handling.md` | Error handling, retry configuration |
| `guides/offline.md` | Offline support, persistent stores |
| `guides/testing.md` | Testing patterns, mock fetch, store setup |
| `reference/rest-queries.md` | RESTQuery field reference, dynamic overrides |
| `reference/pagination.md` | Pagination and infinite query patterns |
| `reference/streaming.md` | Streaming, subscriptions, real-time updates |
| `reference/why-signalium.md` | Why Signalium, benefits over hooks |
| `api/fetchium.md` | API reference for the main package |
| `api/fetchium-react.md` | API reference for fetchium/react |
| `api/stores-sync.md` | API reference for fetchium/stores/sync |
| `api/stores-async.md` | API reference for fetchium/stores/async |
