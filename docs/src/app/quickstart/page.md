---
title: Getting started
---

Fetchium is a reactive data-fetching library built on [Signalium](/reference/why-signalium). It gives you class-based query definitions, automatic entity normalization and caching, a type DSL for describing API shapes, and first-class React integration --- all driven by Signalium's fine-grained reactivity engine.

With Fetchium you define your API surface as plain classes. The library handles fetch deduplication, caching, staleness, background refetching, offline support, and entity identity so your components stay simple and your data stays consistent.

---

## Quick Start Guide {% #getting-started %}

### 1. Install the packages

```bash
# Using npm
npm install fetchium signalium

# Using yarn
yarn add fetchium signalium

# Using pnpm
pnpm add fetchium signalium
```

### 2. Setup the Babel transform

Signalium requires a Babel transform to enable async reactivity. Add it to your bundler config so that async dependency tracking works correctly.

#### Vite + React

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

#### babel.config.js

```js
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

### 3. Create a QueryClient and wrap your app

Every Fetchium app needs a `QueryClient` backed by a store. The client manages query instances, the entity cache, and network state. Wrap your component tree in a `ContextProvider` so that queries can find the client.

```tsx
import { QueryClient, QueryClientContext } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { ContextProvider } from 'signalium/react';

const store = new SyncQueryStore(new MemoryPersistentStore());
const client = new QueryClient(store, { fetch });

function App() {
  return (
    <ContextProvider value={client} context={QueryClientContext}>
      <YourApp />
    </ContextProvider>
  );
}
```

{% callout title="Want to go deeper?" type="note" %}
This minimal setup is enough to get started. For a complete guide to configuring `baseUrl`, auth headers, persistent stores, and project structure, see [Project Setup](/setup/project-setup).
{% /callout %}

### 4. Define an Entity and a Query

Entities describe the shape of your API resources. Queries describe how to fetch them. Both use the `t` type DSL for field definitions.

```tsx
import { RESTQuery, t, Entity } from 'fetchium';

class User extends Entity {
  __typename = t.typename('User');
  id = t.id;
  name = t.string;
  email = t.string;
}

class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { user: t.entity(User) };
}
```

`t.typename` and `t.id` identify the entity for normalization and deduplication. `path` uses template literal interpolation with `this.params` to embed parameter values. `t.entity(User)` tells Fetchium to parse and normalize the response as a `User` entity.

### 5. Use the query in a component

```tsx {% mode="react" %}
import { useQuery } from 'fetchium/react';

function UserProfile({ userId }: { userId: number }) {
  const result = useQuery(GetUser, { id: userId });

  if (!result.isReady) return <div>Loading...</div>;
  if (result.isRejected) return <div>Error: {result.error.message}</div>;

  return (
    <div>
      <h1>{result.value.user.name}</h1>
      <p>{result.value.user.email}</p>
    </div>
  );
}
```

```tsx {% mode="signalium" %}
import { fetchQuery } from 'fetchium';
import { component } from 'signalium/react';

const UserProfile = component(({ userId }: { userId: number }) => {
  const result = fetchQuery(GetUser, { id: userId });

  if (!result.isReady) return <div>Loading...</div>;
  if (result.isRejected) return <div>Error: {result.error.message}</div>;

  return (
    <div>
      <h1>{result.value.user.name}</h1>
      <p>{result.value.user.email}</p>
    </div>
  );
});
```

Both approaches return a `ReactivePromise` with properties like `value`, `error`, `isPending`, `isReady`, `isResolved`, and `isRejected`. The component re-renders automatically when the query state changes.

---

## Next Steps

{% quick-links %}

{% quick-link title="Project Setup" icon="installation" href="/setup/project-setup" description="Configure baseUrl, auth, stores, and project structure for production" /%}

{% quick-link title="Queries" icon="presets" href="/core/queries" description="Deep dive into query definitions, the template system, and usage patterns" /%}

{% quick-link title="Entities" icon="plugins" href="/core/entities" description="Understand normalized entity caching and identity-stable proxies" /%}

{% quick-link title="Auth & Headers" icon="theming" href="/guides/auth" description="Add authentication tokens and custom headers to your requests" /%}

{% /quick-links %}
