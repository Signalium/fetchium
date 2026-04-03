---
name: fetchium
description: Fetchium conventions and mental model for reactive data fetching with normalized entities. Use when working in a codebase that uses the fetchium package.
---

# Fetchium

Fetchium is a reactive data-fetching and entity management library built on Signalium. It uses a standard Query-Mutation split-paradigm, normalized entity caching with identity-stable proxies, and a type DSL for end-to-end typed API shapes.

For detailed documentation on any topic below, read the corresponding file in `node_modules/fetchium/plugin/docs/` (e.g., `node_modules/fetchium/plugin/docs/core/queries.md`).

## Mode Detection

Fetchium supports two React integration modes. **Auto-detect** the mode by checking the codebase for imports:

- If the project imports from `signalium` or `signalium/react` (e.g., `reactive`, `component`, `signal`), use **React + Signalium** patterns.
- Otherwise, default to **React + Hooks** patterns.

The user can also override explicitly (e.g., "use hooks mode" or "use signalium mode"). When in doubt, ask.

## Mental Model

- **Queries** are parameterized requests to _read_ data. They are reactive — they fire automatically when params change, handle caching, deduplication, and refetching.
- **Mutations** are parameterized requests to _change_ data. They are imperative — you call `.run()` explicitly. They declare side effects (creates/updates/deletes) that propagate through the entity store.
- **Entities** are normalized, deduplicated data objects shared across all queries. Each unique `(typename, id)` maps to one identity-stable proxy. Updates to an entity from any source are immediately visible everywhere.

## Import Paths

| Path                    | Exports                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `fetchium`              | `Query`, `RESTQuery`, `fetchQuery`, `Mutation`, `RESTMutation`, `getMutation`, `Entity`, `t`, `QueryClient`, `QueryClientContext`, `registerFormat`, `draft`, `NetworkManager` |
| `fetchium/react`        | `useQuery`                                                                                                                                                                     |
| `fetchium/stores/sync`  | `SyncQueryStore`                                                                                                                                                               |
| `fetchium/stores/async` | `AsyncQueryStore`                                                                                                                                                              |

## Type DSL (`t`)

Always use `t.*` for defining params, results, and entity fields. Never use raw TypeScript interfaces for API response shapes.

| Definition                                                   | TS type                                             |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `t.string`, `t.number`, `t.boolean`, `t.null`, `t.undefined` | Primitives                                          |
| `t.object({ ... })`                                          | `{ ... }`                                           |
| `t.array(type)`                                              | `T[]`                                               |
| `t.record(type)`                                             | `Record<string, T>`                                 |
| `t.union(...types)`                                          | Union                                               |
| `t.optional(type)`                                           | `T \| undefined`                                    |
| `t.nullable(type)`                                           | `T \| null`                                         |
| `t.nullish(type)`                                            | `T \| undefined \| null`                            |
| `t.const(value)`                                             | Literal type                                        |
| `t.enum(...values)`                                          | Union of literals                                   |
| `t.typename(value)`                                          | Discriminator for entity/object unions              |
| `t.id`                                                       | `string \| number` (entity identifier)              |
| `t.entity(EntityClass)`                                      | Normalized entity reference                         |
| `t.liveArray(EntityClass, { constraints })`                  | Reactive array that auto-updates from entity events |
| `t.liveValue(EntityClass, { constraints, ... })`             | Reactive derived value from entity events           |
| `t.format(name)`                                             | Formatted value (e.g., `'date'`, `'date-time'`)     |
| `t.result(type)`                                             | Explicit parse result for error handling            |

### Type DSL Rules

- **Discriminated unions required.** Multi-object unions must have a shared `t.typename(...)` field with unique values per variant.
- **One collection per union.** Unions may contain at most one array type and one record type.
- **Resilience defaults.** Optional fields fall back to `undefined` on parse failure. Arrays silently filter unparseable items by default.

## Entity Conventions

```ts
class User extends Entity {
  __typename = t.typename('User'); // Required: unique type discriminator
  id = t.id; // Required: unique identifier

  name = t.string;
  email = t.string;
}
```

- Entities are **read-only**. Setting a property throws in development mode.
- Entity proxies are **identity-stable**: same `(typename, id)` always returns the same proxy object (`===`).
- Define computed values as getters or methods — methods are auto-memoized via `reactiveMethod`.
- Use `static cache = { gcTime: N }` to control how long unused entities stay in cache (minutes).
- For real-time updates, define `__subscribe(onEvent)` to establish WebSocket/SSE connections.

## Query, Entity, and Mutation Class Rules

Query, Entity, and Mutation classes are **templates**, not normal classes. Field values are **references** captured at definition time.

```ts
class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`; // ✅ String interpolation is ok
  searchParams = { expand: this.params.expand }; // ✅ Direct reference is ok
  result = { name: t.string };
}
```

**Critical rules:**

- Use `get*()` methods (`getPath()`, `getHeaders()`, `getBody()`, `getSearchParams()`, `getConfig()`, `getRequestOptions()`) when you need **dynamic logic** (conditionals, computed values). Fields only support direct references and string interpolation.
- **No arrow functions** for override methods. Arrow functions capture the wrong `this` (the template, not the resolved instance).
- Custom protocols: extend `Query` directly, implement `send()` and `getIdentityKey()`.

## Mutation Conventions

```ts
class UpdateUser extends RESTMutation {
  params = { id: t.id, name: t.string };
  path = `/users/${this.params.id}`;
  method = 'PUT';
  body = { name: this.params.name };
  result = User;

  effects = {
    updates: [[User, { id: this.params.id, name: this.params.name }]],
  };
}
```

- **Prefer entity effects** (`creates`, `updates`, `deletes`) over `invalidates`. Entity effects are precise and work with optimistic updates and live data.
- Use `getEffects()` when effects depend on the **server response** (e.g., server-assigned IDs on create).
- Use `invalidates: [QueryClass]` only as an escape hatch for complex server-side logic.
- `optimisticUpdates = true` for simple, predictable changes (toggling booleans, updating text). Effects apply immediately and roll back on failure.
- Default HTTP method for `RESTMutation` is `POST`.

## React + Hooks Usage

```tsx
import { useQuery } from 'fetchium/react';

function UserProfile() {
  const result = useQuery(GetUser, { id: 42 });

  if (result.isRejected) return <div>Error: {result.error.message}</div>;
  if (!result.isReady) return <div>Loading...</div>;

  return <h1>{result.value.name}</h1>;
}
```

`useQuery` returns `ReactivePromise<QueryResult>` with: `value`, `isReady`, `isPending`, `isResolved`, `isRejected`, `error`. Pass `{ suspended: true/false }` to control whether the query is active.

## React + Signalium Usage

```tsx
import { fetchQuery } from 'fetchium';
import { reactive } from 'signalium';
import { component } from 'signalium/react';

const fetchUserProfile = reactive(async () => {
  const user = await fetchQuery(GetCurrentUser);
  return fetchQuery(GetUserProfile, { user });
});

const UserProfile = component(() => {
  const result = fetchUserProfile();

  if (result.isRejected) return <div>Error: {result.error.message}</div>;
  if (!result.isReady) return <div>Loading...</div>;

  return <h1>{result.value.name}</h1>;
});
```

Use `reactive(async () => {...})` for composing sequential queries. Use `component()` to wrap React components for Signalium reactivity.

## Testing

Use `createMockFetch()` from test utilities with `SyncQueryStore` and `MemoryPersistentStore` for unit tests. React tests use `vitest-browser-react` with `ContextProvider` wrapping `QueryClientContext`.
