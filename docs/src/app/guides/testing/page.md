---
title: Testing
---

Fetchium ships a dedicated `fetchium/testing` package that gives you type-safe query mocking, automatic data generation from your type definitions, entity factories, and test variation knobs for exploring structural edge cases. You never need to understand Signalium internals, mock global state, or patch module imports. Just set up your mocks, write your tests, and let Fetchium handle the wiring.

---

## Quick Start

Every test starts with a `MockClient`. It wraps a `QueryClient` with an in-memory store and a mock fetch router so your queries resolve against canned data instead of a real server.

```ts
import { MockClient } from 'fetchium/testing';

const mock = new MockClient();
afterEach(() => mock.reset());
afterAll(() => mock.destroy());
```

`mock.reset()` clears all mocked routes and request history between tests. `mock.destroy()` tears down the underlying client and timers.

{% callout title="Always destroy the client" type="warning" %}
`QueryClient` manages background timers. Call `mock.destroy()` in your test teardown to avoid timer leaks.
{% /callout %}

---

## Setting Up Your Test Harness

`MockClient` provides a `QueryClient` via `mock.client`. You plug this into your own render utility alongside your app's providers --- auth, theme, i18n, routing, or whatever your app needs:

```tsx
// test-utils.tsx
import { render } from '@testing-library/react';
import { ContextProvider } from 'signalium/react';
import { QueryClientContext } from 'fetchium';

export function renderApp(
  ui: React.ReactElement,
  { client }: { client: QueryClient },
) {
  return render(
    <ContextProvider contexts={[[QueryClientContext, client]]}>
      {ui}
    </ContextProvider>,
  );
}
```

If your app has additional providers, add them here. Fetchium has no opinions about your provider stack --- it only needs `QueryClientContext` to be present.

---

## Mocking Queries

Register mock responses with `mock.when()`. The response shape is type-checked against the query's `result` definition:

```ts
import { Entity, t } from 'fetchium';
import { RESTQuery } from 'fetchium/rest';

class User extends Entity {
  __typename = t.typename('User');
  id = t.id;
  name = t.string;
  email = t.string;
  avatar = t.optional(t.string);
}

class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { user: t.entity(User) };
}

// In your test:
mock.when(GetUser, { id: 1 }).respond({
  user: mock.entity(User, { name: 'Alice', email: 'alice@example.com' }),
});
```

### Auto-generated responses

If you do not care about the exact field values, `.auto()` generates a complete valid response from the query's type definitions:

```ts
mock.when(GetUser, { id: 1 }).auto();
```

You can pass partial overrides that are deep-merged into the generated data:

```ts
mock.when(GetUser, { id: 1 }).auto({
  user: { name: 'Alice' },
});
```

### Catch-all routes

Omit params to match any request for that query class:

```ts
mock.when(GetUser).auto();
```

### Sequential responses

Chain `.thenRespond()` to queue multiple responses:

```ts
mock
  .when(GetUser, { id: 1 })
  .respond({ user: mock.entity(User, { name: 'V1' }) })
  .thenRespond({ user: mock.entity(User, { name: 'V2' }) });
```

The first fetch returns V1, the second returns V2. Subsequent fetches reuse the last response.

### Error states

```ts
mock.when(GetUser, { id: 999 }).error(404);
mock.when(GetUser, { id: 1 }).networkError('connection refused');
```

### Simulated latency

```ts
mock.when(GetUser, { id: 1 }).delay(500).auto();
```

### Raw escape hatch

`.raw()` bypasses type checking entirely, for testing how your app handles unexpected data:

```ts
mock.when(GetUser, { id: 1 }).raw({ incomplete: true });
```

---

## Generating Test Data

### `mock.entity()`

Generates a plain JSON object matching an entity's type definition. Fields are auto-filled with debuggable sequential values (`"name_1"`, `"email_2"`, etc.), and you override whatever matters for your test:

```ts
const alice = mock.entity(User, { name: 'Alice' });
// => { __typename: 'User', id: '1', name: 'Alice', email: 'email_1' }

const bob = mock.entity(User, { name: 'Bob', email: 'bob@test.com' });
// => { __typename: 'User', id: '2', name: 'Bob', email: 'bob@test.com' }
```

IDs auto-increment per typename, so each entity gets a unique identity.

### Entity Factories

For richer test data, register a factory with custom generators:

```ts
mock.define(User, {
  name: (seq) => `User ${seq}`,
  email: (seq, fields) =>
    `${fields.name.toLowerCase().replace(' ', '.')}@test.com`,
});

const alice = mock.entity(User, { name: 'Alice' });
// => { __typename: 'User', id: '1', name: 'Alice', email: 'alice@test.com' }
```

Generator functions receive a `seq` counter (auto-incrementing per typename) and a `fields` object containing previously generated field values, for derived data.

Factories are also used by `.auto()` when it generates entities for query responses.

### Standalone usage

For Storybook or other contexts outside `MockClient`:

```ts
import { entity, defineFactory } from 'fetchium/testing';

const user = entity(User, { name: 'Alice' });

const UserFactory = defineFactory(User, {
  name: (seq) => `User ${seq}`,
});
UserFactory.build({ name: 'Alice' });
UserFactory.buildMany(5);
```

---

## Testing Components

A complete component test:

```tsx
import { MockClient } from 'fetchium/testing';
import { renderApp } from '../test-utils';

const mock = new MockClient();
afterEach(() => mock.reset());
afterAll(() => mock.destroy());

it('renders the user name after loading', async () => {
  mock.when(GetUser, { id: 1 }).respond({
    user: mock.entity(User, { name: 'Alice', email: 'alice@example.com' }),
  });

  const { getByTestId } = renderApp(<UserProfile userId={1} />, {
    client: mock.client,
  });

  await waitFor(() => {
    expect(getByTestId('name')).toHaveTextContent('Alice');
  });
});
```

---

## Testing Mutations

Mutations are mocked the same way. You can inspect what was sent using `mock.calls`:

```ts
import { getMutation, t } from 'fetchium';
import { RESTMutation } from 'fetchium/rest';

class CreateUser extends RESTMutation {
  readonly params = { name: t.string, email: t.string };
  readonly path = '/users';
  readonly method = 'POST' as const;
  readonly body = { name: this.params.name, email: this.params.email };
  readonly result = { user: t.entity(User) };
}

it('sends the correct request body', async () => {
  mock.when(CreateUser).respond({
    user: mock.entity(User, { name: 'Bob', email: 'bob@example.com' }),
  });

  // ... trigger the mutation in your component or reactive code ...

  expect(mock.wasCalled(CreateUser)).toBe(true);
  expect(mock.lastCall(CreateUser)?.body).toEqual({
    name: 'Bob',
    email: 'bob@example.com',
  });
});
```

### Entity effects

Because Fetchium normalizes entities, a mutation that returns updated entity data automatically updates any query that references the same entity:

```ts
it('mutation updates the entity visible in queries', async () => {
  mock.when(GetUser, { id: 1 }).respond({
    user: mock.entity(User, { id: '1', name: 'Alice' }),
  });
  mock.when(UpdateUser).respond({
    user: mock.entity(User, { id: '1', name: 'Alice Updated' }),
  });

  // Fetch the user, then mutate.
  // The query's data reflects the update automatically.
});
```

---

## Summary

| What you are testing             | Tools needed                    | Pattern                                             |
| -------------------------------- | ------------------------------- | --------------------------------------------------- |
| React components with `useQuery` | `MockClient` + your `renderApp` | `mock.when().respond()`, render, assert             |
| Mutations                        | `MockClient`                    | `mock.when(Mutation).respond()`, check `mock.calls` |
| Entity effects after mutation    | `MockClient` + entity query     | Mock both, verify query data reflects mutation      |
| Error states                     | `MockClient`                    | `.error()` or `.networkError()`                     |

The core idea is always the same: create a `MockClient`, set up your mocks, plug `mock.client` into your providers, and assert.

---

## Next Steps

{% quick-links %}

{% quick-link title="Queries" icon="plugins" href="/core/queries" description="Learn how to define queries and use them in components" /%}

{% quick-link title="Entities" icon="theming" href="/core/entities" description="Understand normalized entities and identity-stable proxies" /%}

{% quick-link title="Mutations" icon="presets" href="/data/mutations" description="Define mutations with entity effects and optimistic updates" /%}

{% quick-link title="Error Handling" icon="warning" href="/guides/error-handling" description="Handle network failures, retries, and error boundaries" /%}

{% /quick-links %}
