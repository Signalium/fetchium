---
title: Testing
---

Testing Fetchium code is straightforward, and that is by design. The entire testing story follows from a single architectural decision: the `QueryClient` accepts its `fetch` function as a parameter. You never need to mock global state, install special test utilities, or patch module internals. You just pass a mock `fetch` that returns the data you want, and everything works.

This is the same principle that makes [Auth & Headers](/guides/auth) simple. The fetch wrapper is the _single point of control_ for all network requests. In production, it adds auth headers. In tests, it returns canned responses. The queries, mutations, and components do not know the difference.

If you are coming from TanStack Query, the pattern is similar --- create a test client, wrap your component in a provider, and assert against the rendered output. The main difference is that Fetchium's client takes a `fetch` function directly, so there is no need for a separate `QueryClientProvider` or test-specific utilities.

---

## Setting Up a Test QueryClient

Every test needs a `QueryClient` backed by an in-memory store. The `MemoryPersistentStore` keeps data in memory only (no disk, no IndexedDB), which is exactly what you want for isolated, repeatable tests.

```ts
import { QueryClient } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';

function createTestClient(mockFetch: typeof fetch) {
  const store = new SyncQueryStore(new MemoryPersistentStore());
  return new QueryClient(store, { fetch: mockFetch });
}
```

This is a minimal client. It has no `baseUrl` (your mock fetch receives the raw path), no auth, and no persistent cache. For most tests, this is all you need.

{% callout title="Destroy the client after each test" type="warning" %}
`QueryClient` manages background timers for refetching and garbage collection. Call `client.destroy()` in your test teardown to avoid timer leaks between tests.

```ts
afterEach(() => {
  client.destroy();
});
```
{% /callout %}

---

## Mocking Fetch

How you mock `fetch` depends on what you are testing. Here are the most common patterns, from simplest to most flexible.

### Static response

If your test only hits one endpoint and you know exactly what it returns, a one-liner is enough:

```ts
const mockFetch = async () =>
  new Response(JSON.stringify({ id: 1, name: 'Alice', email: 'alice@example.com' }));
```

### URL-based routing

When a test exercises multiple queries, route responses by URL:

```ts
const mockFetch = async (url: RequestInfo) => {
  const urlStr = typeof url === 'string' ? url : url.url;

  if (urlStr.includes('/users/')) {
    return new Response(
      JSON.stringify({ id: 1, name: 'Alice', email: 'alice@example.com' }),
    );
  }

  if (urlStr.includes('/posts')) {
    return new Response(
      JSON.stringify([
        { id: 1, title: 'First Post' },
        { id: 2, title: 'Second Post' },
      ]),
    );
  }

  return new Response('Not found', { status: 404 });
};
```

### Fluent mock with `createMockFetch`

For tests that need fine-grained control --- different methods, status codes, delays, or the ability to inspect what was sent --- Fetchium's own test suite uses a `createMockFetch` helper with a fluent API. You can adopt the same pattern in your project:

```ts
import { createMockFetch } from './test-utils';

const mockFetch = createMockFetch();
mockFetch.get('/users/1', { id: 1, name: 'Alice' });
mockFetch.post('/users', { id: 2, name: 'Bob' }, { status: 201 });
mockFetch.get('/users/1', { id: 1, name: 'Alice Updated' }); // queued second response

const client = createTestClient(mockFetch);
```

The helper registers responses by method and URL pattern, records every call for later assertions, and supports options like `{ delay: 100 }` for simulating network latency or `{ error: new Error('Network failure') }` for testing error paths. Fetchium's own test suite uses this exact pattern across hundreds of tests --- see `packages/fetchium/src/__tests__/utils.ts` in the Fetchium source for the full implementation.

---

## Testing Components with `useQuery`

React component tests need a `ContextProvider` wrapping the component under test. This is identical to how you provide the client in your application, just with the test client:

```tsx
import { render } from '@testing-library/react';
import { ContextProvider } from 'signalium/react';
import { QueryClientContext } from 'fetchium';

function renderWithClient(ui: React.ReactElement, client: QueryClient) {
  return render(
    <ContextProvider value={client} context={QueryClientContext}>
      {ui}
    </ContextProvider>,
  );
}
```

With this helper, a full component test looks like this:

```tsx
import { RESTQuery, t } from 'fetchium';
import { useQuery } from 'fetchium/react';

class GetUser extends RESTQuery {
  params = { id: t.number };

  path = `/users/${this.params.id}`;

  result = { name: t.string, email: t.string };
}

function UserProfile({ userId }: { userId: number }) {
  const result = useQuery(GetUser, { id: userId });

  if (!result.isReady) return <div>Loading...</div>;
  if (result.isRejected) return <div>Error: {String(result.error)}</div>;

  return <div data-testid="name">{result.value.name}</div>;
}

it('renders the user name after loading', async () => {
  const mockFetch = async () =>
    new Response(JSON.stringify({ name: 'Alice', email: 'alice@example.com' }));

  const client = createTestClient(mockFetch);

  const { getByText, getByTestId } = renderWithClient(
    <UserProfile userId={1} />,
    client,
  );

  // Initially loading
  expect(getByText('Loading...')).toBeInTheDocument();

  // After the query resolves
  await waitFor(() => {
    expect(getByTestId('name')).toHaveTextContent('Alice');
  });

  client.destroy();
});
```

The query fetches from your mock, resolves, and triggers a re-render --- exactly as it would in production. No special test utilities, no fake timers, no module patching.

---

## Testing Reactive Functions

If you are using Signalium's `reactive()` to compose queries outside of React, you can test those functions directly without rendering any components. The key tools are `testWithClient` (a helper that injects the `QueryClient` context and runs the test inside a watcher) and `await` on the reactive promise.

Here is the pattern used in Fetchium's own test suite:

```ts
import { watchOnce, withContexts } from 'signalium';
import { QueryClient, QueryClientContext } from 'fetchium';

async function testWithClient(
  client: QueryClient,
  fn: () => Promise<void>,
): Promise<void> {
  return withContexts([[QueryClientContext, client]], () => watchOnce(fn));
}
```

`withContexts` injects the `QueryClient` so that `fetchQuery` can find it. `watchOnce` creates a temporary watcher that keeps relays active for the duration of the test, then cleans up automatically. This mirrors how a real component would consume the query --- with an active watcher keeping the subscription alive.

With this helper, a reactive function test looks like:

```ts
import { reactive } from 'signalium';
import { fetchQuery, RESTQuery, t } from 'fetchium';

class GetUser extends RESTQuery {
  params = { id: t.number };

  path = `/users/${this.params.id}`;

  result = { name: t.string, email: t.string };
}

class GetPosts extends RESTQuery {
  params = { userId: t.number };

  path = `/users/${this.params.userId}/posts`;

  result = t.array({ id: t.number, title: t.string });
}

const getUserProfile = reactive(async (userId: number) => {
  const user = await fetchQuery(GetUser, { id: userId });
  const posts = await fetchQuery(GetPosts, { userId });
  return { user, posts };
});

it('fetches user and posts together', async () => {
  const mockFetch = createMockFetch();
  mockFetch.get('/users/1', { name: 'Alice', email: 'alice@example.com' });
  mockFetch.get('/users/1/posts', [
    { id: 1, title: 'First Post' },
    { id: 2, title: 'Second Post' },
  ]);

  const client = createTestClient(mockFetch);

  await testWithClient(client, async () => {
    const result = getUserProfile(1);
    await result;

    expect(result.value!.user.name).toBe('Alice');
    expect(result.value!.posts).toHaveLength(2);
  });

  client.destroy();
});
```

The `await result` line waits for the reactive promise to settle. Once it has, `result.value` contains the resolved data and you can assert against it like any other value.

---

## Testing Mutations

Mutations are tested the same way as queries --- create a client with a mock fetch, run the mutation inside `testWithClient`, and assert on the result. The mock fetch's `calls` array lets you verify that the right request was sent.

```ts
import { RESTMutation, getMutation, t } from 'fetchium';

class CreateUser extends RESTMutation {
  readonly params = { name: t.string, email: t.string };

  readonly path = '/users';
  readonly method = 'POST' as const;
  readonly body = { name: this.params.name, email: this.params.email };

  readonly result = { id: t.number, name: t.string, email: t.string };
}

it('sends the correct request body', async () => {
  const mockFetch = createMockFetch();
  mockFetch.post('/users', { id: 42, name: 'Bob', email: 'bob@example.com' });

  const client = createTestClient(mockFetch);

  await testWithClient(client, async () => {
    const mut = getMutation(CreateUser);
    await mut.run({ name: 'Bob', email: 'bob@example.com' });

    expect(mut.isResolved).toBe(true);
    expect(mut.value?.id).toBe(42);
    expect(mut.value?.name).toBe('Bob');

    // Verify the request
    expect(mockFetch.calls[0].url).toBe('/users');
    expect(mockFetch.calls[0].options.method).toBe('POST');
    expect(JSON.parse(mockFetch.calls[0].options.body as string)).toEqual({
      name: 'Bob',
      email: 'bob@example.com',
    });
  });

  client.destroy();
});
```

### Verifying entity effects

Mutations often update entities that other queries depend on. To test this, set up both the query and the mutation, then verify that the query's data reflects the mutation's effect.

```ts
import { Entity, RESTQuery, RESTMutation, fetchQuery, getMutation, t } from 'fetchium';

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

class UpdateUser extends RESTMutation {
  readonly params = { id: t.number, name: t.string };

  readonly path = `/users/${this.params.id}`;
  readonly method = 'PATCH' as const;
  readonly body = { name: this.params.name };

  readonly result = { user: t.entity(User) };
}

it('mutation updates the entity visible in queries', async () => {
  const mockFetch = createMockFetch();
  mockFetch.get('/users/1', { user: { __typename: 'User', id: '1', name: 'Alice', email: 'alice@example.com' } });
  mockFetch.patch('/users/[id]', { user: { __typename: 'User', id: '1', name: 'Alice Updated', email: 'alice@example.com' } });

  const client = createTestClient(mockFetch);

  await testWithClient(client, async () => {
    // Fetch the user
    const query = fetchQuery(GetUser, { id: 1 });
    await query;
    expect(query.value!.user.name).toBe('Alice');

    // Mutate
    const mut = getMutation(UpdateUser);
    await mut.run({ id: 1, name: 'Alice Updated' });

    // The entity is normalized --- the query's data reflects the update
    expect(query.value!.user.name).toBe('Alice Updated');
  });

  client.destroy();
});
```

Because Fetchium normalizes entities by typename and id, the mutation response updates the _same_ entity instance that the query returned. This is automatic --- you do not need to manually invalidate or refetch anything.

---

## Vitest Setup

Fetchium's own test suite uses [vitest](https://vitest.dev) with the Signalium Babel preset applied through `vitest.config.ts`. If your tests use `async` reactive functions (which are rewritten to generators for dependency tracking), you need the Babel preset in your test pipeline too.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import { signaliumPreset } from 'signalium/transform';

export default defineConfig({
  plugins: [
    {
      name: 'signalium',
      config: () => ({
        esbuild: false,
      }),
    },
  ],
  test: {
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
  // Apply the Signalium Babel preset so async reactive functions work
  // The exact integration depends on your build setup --- see the
  // Project Setup guide for Vite and babel.config.js examples.
});
```

{% callout title="When is the preset required?" type="note" %}
The Signalium Babel preset is only necessary if your test code (or code under test) uses `async` functions with `reactive()`, `relay()`, or `task()`. If you only use `useQuery` with plain React hooks and your queries are simple class definitions, the preset is not needed for tests.

If you are seeing unexpected behavior where `await` inside a reactive function does not re-track dependencies, the missing Babel preset is the most likely cause. See [Project Setup](/setup/project-setup) for configuration details.
{% /callout %}

---

## Summary

| What you are testing | Tools needed | Pattern |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------------------------- |
| React components with `useQuery` | `renderWithClient` + mock fetch | Wrap in `ContextProvider`, assert on rendered output |
| Reactive functions with `fetchQuery` | `testWithClient` + mock fetch | Inject context with `withContexts`, await the reactive promise |
| Mutations | `testWithClient` + mock fetch | `getMutation()` → `mut.run()`, assert on `mut.value` |
| Entity effects after mutation | `testWithClient` + mock fetch + entity query | Run query, run mutation, assert query data reflects the update |
| Error states | Mock fetch with `{ error }` or 4xx status | Assert `isRejected` and `error` on the result |

The core idea is always the same: create a `QueryClient` with a mock `fetch`, run your code, and assert. No global mocks, no special test modes, no framework-specific utilities. The `fetch` parameter is the seam that makes it all work.

---

## Next Steps

{% quick-links %}

{% quick-link title="Auth & Headers" icon="installation" href="/guides/auth" description="The same fetch wrapper pattern that powers testing also powers authentication" /%}

{% quick-link title="Error Handling" icon="warning" href="/guides/error-handling" description="Handle network failures, retries, and error boundaries in your components" /%}

{% quick-link title="Project Setup" icon="presets" href="/setup/project-setup" description="Configure the Babel preset, stores, and QueryClient for your project" /%}

{% quick-link title="Queries" icon="plugins" href="/core/queries" description="Learn how to define queries, use them in components, and understand the template system" /%}

{% /quick-links %}
