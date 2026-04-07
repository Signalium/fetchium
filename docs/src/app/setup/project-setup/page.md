---
title: Project Setup
---

The [Quick Start](/quickstart) gets you from zero to a running query in five steps. This page goes deeper --- it explains _what_ each piece of the setup does, _why_ it exists, and how to configure it for a real production application.

If you are coming from libraries like TanStack Query or SWR, you may be used to creating a client object and passing it through React context. Fetchium follows a similar pattern, but with a few key differences: the `QueryClient` is _not_ a React-specific concept (it works in any JavaScript environment), it delegates persistence to a _pluggable store_, and it uses Signalium's context system rather than React's built-in `createContext`.

---

## The QueryClient

The `QueryClient` is the central coordinator of a Fetchium application. It manages:

- **Query instances** --- deduplicating in-flight requests, caching results, scheduling refetches
- **The entity store** --- normalizing, deduplicating, and storing entities by typename + id
- **Garbage collection** --- evicting unused queries and entities from memory
- **Network awareness** --- pausing and resuming queries based on connectivity

Every Fetchium operation --- `fetchQuery`, `useQuery`, `getMutation` --- looks up the `QueryClient` from a Signalium context. If no client is found, these calls will throw.

### Creating a QueryClient

The `QueryClient` constructor takes a single config object. The only required field is `store`:

```tsx
import { QueryClient } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { RESTQueryAdapter } from 'fetchium/rest';

const client = new QueryClient({
  store: new SyncQueryStore(new MemoryPersistentStore()),
  adapters: [
    new RESTQueryAdapter({
      fetch: globalThis.fetch,
      baseUrl: 'https://api.example.com',
    }),
  ],
});
```

The store is responsible for _persistent_ caching --- saving query results and entity data so they survive page refreshes, app restarts, or being evicted from the in-memory cache. `MemoryPersistentStore` keeps everything in memory (data is lost on refresh), which is perfect for development and tests. For production persistence, implement the `SyncPersistentStore` interface with a durable backend like `localStorage`, or use the `AsyncQueryStore` with IndexedDB. See the [Offline & Persistence](/guides/offline) guide for details.

### QueryClientConfig options

| Option     | Type             | Default                      | Description                                                                                                                  |
| ---------- | ---------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `store`    | `QueryStore`     | `SyncQueryStore` (in-memory) | Persistent storage backend for query results and entity data. Defaults to an in-memory store — data is lost on page refresh. |
| `adapters` | `QueryAdapter[]` | `[]`                         | Transport adapters. Register a `RESTQueryAdapter` to configure `fetch`, `baseUrl`, and headers for REST queries.             |
| `log`      | `object`         | `console`                    | A logger with `warn` and `error` methods. Fetchium uses `log.warn` for non-fatal parse failures.                             |

### Auto-instantiation

Both the store and adapters have sensible defaults, so the minimal `QueryClient` requires no configuration at all:

```tsx
// Fully minimal — in-memory store, RESTQueryAdapter auto-instantiated on first use
const client = new QueryClient();
```

- `store` defaults to `SyncQueryStore(MemoryPersistentStore)` — data lives in memory and is lost on page refresh
- Adapters are auto-instantiated from their base class the first time a query of that type runs. `RESTQueryAdapter` has a no-arg constructor that defaults to `globalThis.fetch`

Once you need a `baseUrl`, auth headers, persistent storage, or a custom fetch wrapper, pass explicit options.

### The RESTQueryAdapter

`RESTQueryAdapter` is the transport layer for all REST queries and mutations. It accepts:

| Option    | Type       | Default            | Description                                                                                                                                                     |
| --------- | ---------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch`   | `Function` | `globalThis.fetch` | The fetch function used for all network requests. Pass a custom wrapper for auth headers, logging, or testing.                                                  |
| `baseUrl` | `string`   | `''`               | Prepended to every query path. Set this to your API root (`https://api.example.com`) so your query paths can be relative (`/users/42` instead of the full URL). |

`fetch` is the _single point of control_ for how Fetchium makes network requests. Every REST query and mutation flows through this function, which means you can add authentication, logging, retry logic, or any other cross-cutting concern in one place. We cover this in depth in the [Auth & Headers](/guides/auth) guide.

{% callout title="Why pass fetch explicitly?" type="note" %}
You might wonder why Fetchium asks you to pass `fetch` instead of just using the global. The reason is _testability_ and _universality_. By accepting `fetch` as a parameter, Fetchium works identically in browsers, Node.js, Deno, and test environments. In tests, you pass a mock fetch. On the server, you pass Node's fetch. In the browser, you pass a wrapper that adds auth headers. The interface is always the same.
{% /callout %}

### Providing the client to your app

The `QueryClient` is made available to your component tree through Signalium's `ContextProvider`. This is analogous to React's `Context.Provider`, but works with Signalium's reactive context system:

```tsx
import { QueryClient, QueryClientContext } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { RESTQueryAdapter } from 'fetchium/rest';
import { ContextProvider } from 'signalium/react';

const client = new QueryClient({
  store: new SyncQueryStore(new MemoryPersistentStore()),
  adapters: [
    new RESTQueryAdapter({
      fetch: globalThis.fetch,
      baseUrl: 'https://api.example.com',
    }),
  ],
});

function App() {
  return (
    <ContextProvider value={client} context={QueryClientContext}>
      <YourApp />
    </ContextProvider>
  );
}
```

Any component or reactive function inside this provider can now call `useQuery`, `fetchQuery`, or `getMutation`, and they will automatically find the client.

{% callout title="If you are using Signalium mode" type="note" %}
When using `component()` from `signalium/react`, the `ContextProvider` is the standard way to provide contexts. If you are using `useQuery` with plain React hooks, you still need the `ContextProvider` --- the hook reads from the Signalium context internally.
{% /callout %}

---

## The Babel Transform

Signalium includes a Babel transform that enables two features:

1. **Async reactivity** --- rewriting `async` functions used with `reactive()` into generator-based coroutines, so Signalium can track dependencies across `await` boundaries
2. **Callback tracking** --- wrapping callback arguments for reactive tracking inside event handlers

The transform is _optional_ if you only use `useQuery` with plain React hooks. It becomes _necessary_ when you use Signalium's `reactive()` with `async` functions, which is one of the most powerful patterns for composing queries.

### Vite + React

```js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { signaliumPreset } from 'signalium/transform';

export default defineConfig({
  plugins: [
    react({
      babel: {
        presets: [signaliumPreset()],
      },
    }),
  ],
});
```

### Next.js

```js
// next.config.js
const withSignalium = require('signalium/transform/next');

module.exports = withSignalium({
  // your Next.js config
});
```

### Generic Babel config

```js
// babel.config.js
import { signaliumPreset } from 'signalium/transform';

module.exports = {
  presets: [
    '@babel/preset-env',
    '@babel/preset-react',
    '@babel/preset-typescript',
    signaliumPreset(),
  ],
};
```

The transform only affects code that uses Signalium APIs (`reactive`, `relay`, `task`). Standard async/await outside of reactive contexts is untouched. For a deeper look at what the transform does and when you need it, see [Why Signalium?](/reference/why-signalium).

---

## Project Structure

Fetchium does not enforce a particular file layout, but after working with it across projects, a pattern has emerged that works well.

### Recommended layout

```
src/
  api/
    client.ts          # QueryClient creation and configuration
    entities/           # Entity class definitions
      User.ts
      Post.ts
      Comment.ts
    queries/            # Query class definitions
      GetUser.ts
      GetPosts.ts
      GetFeed.ts
    mutations/          # Mutation class definitions
      CreatePost.ts
      UpdateUser.ts
    reactive/           # Shared reactive functions (Signalium mode)
      useUserProfile.ts
      useFeed.ts
  components/
    ...
```

The key principle is _separation of data definitions from UI_. Your entity and query classes are plain TypeScript --- they have no dependency on React, no JSX, no component logic. This makes them testable, reusable across frameworks, and easy to reason about independently.

### Entity files

Each entity gets its own file. Entities tend to be referenced across many queries and mutations, so isolating them prevents circular imports:

```ts
// src/api/entities/User.ts
import { Entity, t } from 'fetchium';

export class User extends Entity {
  __typename = t.typename('User');
  id = t.id;

  name = t.string;
  email = t.string;
  avatar = t.optional(t.string);
}
```

### Query files

Queries import from entities and define the API surface:

```ts
// src/api/queries/GetUser.ts
import { t } from 'fetchium';
import { RESTQuery } from 'fetchium/rest';
import { User } from '../entities/User';

export class GetUser extends RESTQuery {
  params = { id: t.number };

  path = `/users/${this.params.id}`;

  result = { user: t.entity(User) };
}
```

### The client file

A single file creates and exports the `QueryClient`. This is the place to configure `baseUrl`, auth wrappers, and logging:

```ts
// src/api/client.ts
import { QueryClient } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { RESTQueryAdapter } from 'fetchium/rest';

export const queryClient = new QueryClient({
  store: new SyncQueryStore(new MemoryPersistentStore()),
  adapters: [
    new RESTQueryAdapter({
      fetch: globalThis.fetch,
      baseUrl: import.meta.env.VITE_API_URL ?? 'https://api.example.com',
    }),
  ],
});
```

### Shared reactive functions (Signalium mode)

If you are using Signalium, shared `reactive()` functions that compose multiple queries live in their own directory. These form a _reactive data layer_ between your raw API queries and your components:

```ts
// src/api/reactive/useUserProfile.ts
import { reactive } from 'signalium';
import { fetchQuery } from 'fetchium';
import { GetUser } from '../queries/GetUser';
import { GetUserPosts } from '../queries/GetUserPosts';

export const getUserProfile = reactive((userId: number) => {
  const user = fetchQuery(GetUser, { id: userId });
  const posts = fetchQuery(GetUserPosts, { userId });
  return { user, posts };
});
```

This is not required --- you can call `fetchQuery` directly in components --- but extracting these functions keeps your components focused on rendering, and the reactive functions are automatically memoized and shared across consumers.

---

## Development vs Production

Fetchium uses a compile-time constant `IS_DEV` to enable additional runtime checks in development:

- **Parse validation warnings** --- detailed logs when response data doesn't match your type definitions
- **Entity write protection** --- throws when you accidentally try to mutate an entity property directly (entities are read-only)
- **Reference validation** --- catches common mistakes like using conditional logic in class field definitions

In production builds, all `IS_DEV` code paths are tree-shaken, so there is zero runtime cost.

Fetchium's `package.json` uses [conditional exports](https://nodejs.org/api/packages.html#conditional-exports) to serve different bundles:

- The `development` condition serves the development build (with `IS_DEV = true`)
- The `production` condition (and the default) serves the production build (with `IS_DEV = false`)

Most bundlers (Vite, webpack, esbuild) resolve the `development` condition automatically when running in development mode. If your dev server is not picking up development warnings, check that your bundler's resolve conditions include `'development'`.

---

## Next Steps

With your project set up, you are ready to start defining your API surface:

{% quick-links %}

{% quick-link title="Queries" icon="presets" href="/core/queries" description="Learn how to define queries, use them in components, and understand the template system" /%}

{% quick-link title="Auth & Headers" icon="installation" href="/guides/auth" description="Add authentication tokens and custom headers to your requests" /%}

{% quick-link title="Error Handling" icon="theming" href="/guides/error-handling" description="Handle failures gracefully with retries, error states, and global interceptors" /%}

{% quick-link title="Testing" icon="plugins" href="/guides/testing" description="Set up a test QueryClient and mock your API layer" /%}

{% /quick-links %}
