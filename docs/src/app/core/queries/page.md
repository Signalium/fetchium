---
title: Queries
---

Fetchium is founded on the well-established Query-Mutation split-paradigm of modern data fetching libraries, wherein:

- **Queries** are parameterized requests to _read_ data without changing its state
- **Mutations** are parameterized requests to _change the state_ of that data

This distinction is not about HTTP methods --- it's about _usage patterns_. From the frontend's perspective, the key differences are:

1. **Queries are automatic and cached.** They run when you access them, their results are cached and deduplicated, and they refetch automatically when they become stale. If a user visits a page that needs data, a query fetches it.
2. **Mutations are manual and ephemeral.** They only run when you explicitly call `.run()`, their results are not cached, and they never run automatically. A mutation fires in response to a _user action_ --- clicking a button, submitting a form, confirming a dialog.

This is a more fundamental split than GET vs POST. In REST, a `POST` endpoint that returns data in a read-only, cacheable way (e.g. a complex search with a request body, or an endpoint that uses `POST` for legacy reasons) is still a _Query_ from Fetchium's perspective --- it should be modeled with `RESTQuery` and `method = 'POST'`, because you want caching, deduplication, and automatic refetching. Conversely, a `DELETE` that removes a resource is a _Mutation_, even though the endpoint might return the deleted resource.

The rule of thumb: **if a user visits a page and needs to see data, that's a query. If a user takes an action that changes data, that's a mutation.**

This pattern works across many different protocols:

- **REST APIs** --- most GET requests are queries, most POST/PUT/DELETE are mutations, but not always (complex searches via POST are queries)
- **GraphQL** --- has this exact split built into the language (`query` vs `mutation`)
- **JSON-RPC** and **gRPC** --- have no formal distinction, but the query/mutation pattern maps cleanly onto read vs write operations

Fetchium ships built-in adapters for JSON REST APIs (`RESTQuery` / `RESTMutation` from `fetchium/rest`) and topic-based streaming (`TopicQuery` from `fetchium/topic`). REST is the lowest common denominator across the web ecosystem, while TopicQuery provides a declarative way to integrate with message buses, WebSockets, and other pub/sub systems --- see [Streaming](/core/streaming) for details. Fetchium is built from the ground up to support _any_ protocol with a simple, easily expandable class-based adapter system --- see [Custom Queries](#custom-queries) and [Custom Mutations](/data/mutations#custom-mutations).

More importantly, Fetchium handles caching, deduplication, and refetching behind the scenes. And when your results include [Entities](/core/entities) and [Live Data](/data/live-data), Fetchium also handles normalization and incremental streaming updates.

## Defining a Query

All queries fundamentally require two user defined fields: _params_ and _result_.

- `params` defines what the caller must provide.
- `result` defines the response shape that is returned.

These are defined using a type-validation-DSL, `t`, which is discussed more in the next section. For now, we'll only use simple type validators like `t.number` or `t.string` which are self-explanatory.

Here is a basic example using RESTQuery.

```tsx
import { t } from 'fetchium';
import { RESTQuery } from 'fetchium/rest';

class GetUser extends RESTQuery {
  params = {
    id: t.number,
  };

  path = `/users/${this.params.id}`;

  result = {
    name: t.string,
    email: t.string,
  };
}
```

In this query definition, you can see the `params` and `result` being constructed with the `t` type DSL. You can also see `path`, which is a REST-specific field, and which references `this.params.id` in the interpolation.

This might seem a bit odd to you, since presumably `t.number` is not the _actual_ ID of the user we're attempting to fetch - it's a type definition. So, what is going on here?

The reality is that `Query` classes are not _normal_ classes - they are _templates_. Users are never meant to create one like a normal class (e.g. `new GetUser(params)`) Instead, Fetchium creates a single instance of the class to capture the expected parameter and result types, and to capture the _parameterized_ versions of the other fields.

In this way, parameters can be passed in a _typesafe manner_ to any other field in the class:

```ts
import { t } from 'fetchium';
import { RESTQuery } from 'fetchium/rest';

class GetUser extends RESTQuery {
  params = {
    id: t.number,
    includeTags: t.boolean,
    apiKey: t.string,
  };

  path = `/users/${this.params.id}`;

  searchParams = {
    includeTags: this.params.includeTags,
  };

  headers = {
    'X-API-KEY': this.params.apiKey,
  };

  result = {
    name: t.string,
    email: t.string,
    tags: t.optional(t.array(t.string)),
  };
}
```

The full list of options provided by `RESTQuery` is available below, but there are two main reasons for this separation of concerns:

1. Parameters should not be connected to the _specifics_ of your Queries. You should be able to change if a parameter is passed as a search param, a path param, a header, or so on, without having to change every _usage_ of the query.
2. More broadly, this distinction allows you to keep your Queries _protocol agnostic_. If you decide to switch from REST to GraphQL or gRPC in the future, none of your usage sites need to change.

The same distinction applies to query _results_. Internally, `RESTQuery` exposes the raw HTTP response on `this.response` after each fetch completes (which can be used in `getConfig()` for things like controlling retry or polling behavior based on whether the response was successful or errored). Externally, the result gets parsed by the `this.result` definition and exposed as the query's value.

This brings us to the next topic: Using Queries.

## Query Usage

Fetchium is built on [Signalium](/reference/why-signalium), which is a framework-agnostic signal-based reactivity framework. As such, it supports usage with _any_ JavaScript framework and in any context. Fetchium can be used on clients and servers, in Vue or Svelte or Angular, and so on.

That said, Fetchium is primarily focused on _client-side_ data fetching, and **React** support is built-in as it is the most commonly used JavaScript framework today. There are two main ways that Fetchium can be used in React: With Hooks, or with Signalium.

### Usage with React Hooks

For Hooks usage, you can use `useQuery` to fetch a query:

```tsx
import { useQuery } from 'fetchium/react';

export function UserProfile() {
  const result = useQuery(GetUser, { id: 42 });

  if (result.isRejected) return <div>Error: {result.error.message}</div>;
  if (!result.isReady) return <div>Loading...</div>;

  return (
    <div>
      <h1>{result.value.name}</h1>
      <p>{result.value.email}</p>
    </div>
  );
}
```

This works like any other Hook and can be a drop-in replacement for most other query libraries (aside from differences in query definitions). Queries return a _reactive promise_, which is a formalized data structure for making any asynchronous action reactive:

```ts
interface ReactivePromise<T> {
  // The current value of the promise
  value: T | undefined;

  // Whether or not the promise has loaded a value
  // at least once. Use this for type narrowing on `value`
  isReady: boolean;

  // Whether or not the promise is currently loading.
  // Will be true if the promise reloads for any reason,
  // even if a value already exists, so isReady should be
  // preferred unless you want to sync in the background.
  isPending: boolean;

  // Whether or not the promise resolved on its most
  // recent execution.
  isResolved: boolean;

  // Whether or not the promise rejected on its most
  // recent execution.
  isRejected: boolean;

  // If the promise rejected, the error that it rejected with.
  error: unknown;
}
```

`useQuery` returns a `ReactivePromise<QueryResult>`, which is the _result_ of the query and some additional properties:

```ts
type QueryResult<Q extends Query> = Q['result'] & {
  __refetch(): Promise<Q['result']>;
  __fetchNext(): Promise<Q['result']>;
};

declare function useQuery<Q extends Query>(
  query: Q,
  params: Q['params'],
  opts?: {
    suspended?: boolean;
  },
): ReactivePromise<QueryResult<Q>>;
```

The reason `__refetch` and `__fetchNext` are defined on the _result_ of the query and not the `ReactivePromise` is about composability, which leads us into usage within Signalium.

### Usage with React + Signalium

Fetchium can be used entirely without Signalium. If you want to integrate Fetchium into an existing React app and just want to keep your existing Hooks and state management, that will _always_ be supported as a first-class citizen.

However, Signalium provides some DX and performance benefits over Hooks. For instance, it's a fairly common to need to chain together two different requests in sequence:

```tsx
import { useQuery } from 'fetchium/react';
import { GetCurrentUser, GetUserProfile } from './queries';

export function UserProfile() {
  const userResult = useQuery(GetCurrentUser);
  const userProfileResult = useQuery(
    GetUserProfile,
    { user },
    { suspended: !user },
  });

  if (userResult.isRejected || userProfileResult.isRejected) {
    const message =
      userResult.error?.message ||
      userProfileResult.error?.message;

    return <div>
	    Error: {message}
	</div>;
  }

  if (!userResult.isReady || !userProfileResult.isReady) {
	return <div>Loading...</div>;
  }


  return (
    <div>
      <h1>{userProfileResult.value.name}</h1>
      <p>{userProfileResult.value.email}</p>
    </div>
  );
}
```

This can be abstracted with a `useUserProfile` hook, but ultimately you still have to deal with the _combinatorial_ complexity of handling multiple requests at the same time.

With Signalium, we can use an async reactive function to simplify.

```tsx
import { fetchQuery } from 'fetchium';
import { reactive } from 'signalium';
import { component } from 'signalium/react';
import { GetCurrentUser, GetUserProfile } from './queries';

const fetchUserProfile = reactive(async () => {
  const user = await fetchQuery(GetCurrentUser);

  return fetchQuery(GetUserProfile, { user });
});

export const UserProfile = component(() => {
  const result = fetchUserProfile();

  if (result.isRejected) return <div>Error: {result.error.message}</div>;
  if (!result.isReady) return <div>Loading...</div>;

  return (
    <div>
      <h1>{result.value.name}</h1>
      <p>{result.value.email}</p>
    </div>
  );
}
```

In the near future, we intend to make _async components_ work as well through integration with React Suspense:

```tsx
import { fetchQuery } from 'fetchium';
import { component } from 'signalium/react';
import { GetCurrentUser, GetUserProfile } from './queries';

export const UserProfile = component(async () => {
  const user = await fetchQuery(GetCurrentUser);
  const profile = await fetchQuery(GetUserProfile, { user });

  return (
    <div>
      <h1>{profile.name}</h1>
      <p>{profile.email}</p>
    </div>
  );
}
```

If you are interested in the benefits of using Signalium as a replacement for Hooks in your codebase, read the [Signalium](/reference/why-signalium) docs for more information. The remainder of this guide will show examples in both Hooks and Signalium formats based on the toggle at the top of the left-side navigation menu.

## Query Class Rules

Because Fetchium processes query classes as _definitions_ before creating real instances, there are two straightforward rules to keep in mind.

### Field values are references

When you access `this.params` in a class field, Fetchium records a _reference_ to that path - it doesn't evaluate the actual value yet. Real values are filled in later when an instance is created at fetch time. There are exactly two value uses of references in class fields:

1. As a direct reference to the exact value
2. As a string interpolation

You can define your own fields for reused values and logic as well, as long as they follow these rules.

```ts
class GetUser extends RESTQuery {
  params = {
    id: t.number,
    includeTags: t.optional(t.boolean),
    apiKey: t.string,
  };

  // ✅ This is a string interpolation, which is ok
  path = `/users/${this.params.id}`;

  // ✅ This is a direct reference on an object, which is also ok
  searchParams = {
    includeTags: this.params.includeTags,
  };

  // ✅ This is a string interpolation for a custom field, which is ok
  apiKeyHeader = `Bearer: ${this.params.apiKey}`;

  // ✅ Custom fields also have to follow these rules when referenced
  // in other fields. This is ok, because we are just referencing the
  // apiKeyHeader field and not doing any conditional logic with it.
  headers = {
    'X-API-KEY': this.apiKeyHeader,
  };

  result = {
    name: t.string,
  };
}
```

This means you can't use _logic_ in field assignments, because the reference will always be truthy. Instead, you have to use methods, which run with the _resolved_ fields:

```tsx
class GetUser extends RESTQuery {
  params = {
    id: t.optional(t.number),
    slug: t.optional(t.string),
  };

  // 🛑 Don't do this - this.params.id is a reference object,
  // which is always truthy, so this will always pick the first branch
  path = this.params.id ? `/users/${this.params.id}` : `/users/by-slug`;

  // ✅ This is ok, getPath is called with the real values resolved
  getPath() {
    return this.params.id
      ? `/users/${this.params.id}`
      : `/users/by-slug/${this.params.slug}`;
  }

  result = {
    name: t.string,
  };
}
```

By convention, every field provided by `RESTQuery` and other query implementations has a corresponding `get*` method. So for `path` there is `getPath`, for `headers` there is `getHeaders`, etc.

{% callout title="API design by TypeScript limitations" type="note" %}
The original API design for this feature allowed getters in place of fields, so `get path() {}` would work as well. The issue was that TypeScript does not allow this specific combination on abstract classes at the moment. See [this issue](https://github.com/microsoft/TypeScript/issues/40635) for more information.
{% /callout %}

### Avoid arrow functions for dynamic logic

Methods can resolve the actual values because JavaScript allows us to _bind_ them to the current context. Arrow functions, unfortunately, do not allow rebinding. As such, any arrow function defined within a class body will capture the `this` of the class definition itself, which will return references instead of direct values.

```tsx
class Example extends RESTQuery {
  params = {
    id: t.number,
  };

  path = `/items/${this.params.id}`;

  result = {
    name: t.string,
  };

  // ✅ regular method, called against the instance
  getSearchParams() {
    return { expanded: true };
  }

  // 🛑 arrow function, captures the wrong `this`
  getSearchParams = () => {
    return { expanded: true };
  };
}
```

All of the APIs for Fetchium have been defined with this in mind, including more advanced and nesting configurations. When in doubt, and when you need dynamic logic, simply switch to the `get*` method at the top level.

For instance, let's say we wanted to add an optional polling refresh to a query. The `subscribe` option on config normally allows us to add a subscription configuration (of which polling is one option, more on that in the [REST Queries reference](/reference/rest-queries)). We can pass in an exact polling time by reference like so:

```ts
class GetUser extends RESTQuery {
  params = {
    id: t.number,
    pollInterval: t.optional(t.number),
  };

  path = `/items/${this.params.id}`;

  result = {
    name: t.string,
  };

  config = {
    subscribe: poll({ interval: this.params.pollInterval }),
  };
}
```

But let's say we wanted to provide a _dynamic_ polling interval based on the query response. We can't use conditional logic in the _field_ version of `config`, but we can in the _method_ version:

```ts
class GetUser extends RESTQuery {
  params = {
    id: t.number,
  };

  path = `/items/${this.params.id}`;

  result = {
    name: t.string,
  };

  getConfig() {
    const lastResponseOk = this.response?.ok ?? true;

    // If the last response was ok, poll quickly. Else, poll
    // slowly - the service might be having trouble.
    const interval = lastResponseOk ? 1_000 : 10_000;

    return {
      subscribe: poll({ interval }),
    };
  }
}
```

### Field reference

Here is a quick reference of the fields that are available for configuration on `RESTQuery`:

| Field            | Type                      | Default | Description                                                                                   |
| ---------------- | ------------------------- | ------- | --------------------------------------------------------------------------------------------- |
| `method`         | `string`                  | `'GET'` | HTTP method                                                                                   |
| `path`           | `string`                  | ---     | URL path with template literal param interpolation                                            |
| `searchParams`   | `Record<string, unknown>` | ---     | Query string parameters                                                                       |
| `body`           | `Record<string, unknown>` | ---     | JSON request body (auto-sets Content-Type header)                                             |
| `headers`        | `HeadersInit`             | ---     | Additional request headers                                                                    |
| `requestOptions` | `QueryRequestOptions`     | ---     | Fetch options like `credentials`, `mode`, `cache`, `baseUrl`                                  |
| `config`         | `QueryConfigOptions`      | ---     | Various options for advanced query configuration, such as `subscribe`, `staleTime`, and more. |

Each of these has a corresponding `get*()` method (`getPath()`, `getSearchParams()`, `getBody()`, etc.) for when you need dynamic logic.

For a more in depth guide to query configuration, see the [REST Queries reference](/reference/rest-queries) page.

---

## Custom Queries

`RESTQuery` is an adapter for JSON REST APIs. But queries as a concept are protocol-agnostic. When your use case doesn't fit REST --- GraphQL, gRPC, WebSockets, local databases, or any other data source --- you build a **`QueryAdapter`** that handles the transport, and a **`Query`** subclass that stays purely declarative.

The split follows the same logic as the rest of Fetchium: the _definition_ (params, result, identity) lives on the `Query` class; the _transport_ (how to actually fetch data) lives on the adapter.

### Defining an adapter

A `QueryAdapter` handles sending requests on behalf of queries that declare it. Extend `QueryAdapter` and implement `send(ctx, signal)`:

```ts
import { QueryAdapter } from 'fetchium';
import type { Query } from 'fetchium';

class DBQueryAdapter extends QueryAdapter {
  async send(ctx: Query, signal: AbortSignal): Promise<unknown> {
    const q = ctx as DBQuery;
    const db = await openDatabase();
    return db.get(q.collection, q.id);
  }
}
```

Inside `send()`:

- **`ctx`** --- the query execution context, cast to your query type; all fields are resolved to their real values (not references)
- **`signal`** --- an `AbortSignal` for cancellation, passed automatically by the query lifecycle
- **`this.queryClient`** --- the registered `QueryClient`; call `this.queryClient.getContext()` to access `log` and any other context properties you passed at setup

Register the adapter when creating the `QueryClient`:

```ts
new QueryClient({
  store,
  adapters: [new DBQueryAdapter()],
});
```

### Defining the query class

The query class is purely declarative. It declares `static adapter` to point at the adapter, defines `params`, `result`, and `getIdentityKey()`, and can include any additional fields your adapter reads:

```ts
import { Query, t } from 'fetchium';

abstract class DBQuery extends Query {
  static override adapter = DBQueryAdapter;

  abstract collection: string;
  abstract id: unknown;

  getIdentityKey() {
    return `db:${this.collection}:${String(this.id)}`;
  }
}

class GetUser extends DBQuery {
  params = { id: t.number };

  collection = 'users';
  id = this.params.id;

  result = { name: t.string, email: t.string };
}
```

### Building a protocol adapter

Here is a more complete example --- a GraphQL adapter:

```ts
import { QueryAdapter, Query, t } from 'fetchium';

// Adapter: owns the transport
class GraphQLAdapter extends QueryAdapter {
  async send(ctx: Query, signal: AbortSignal): Promise<unknown> {
    const q = ctx as GraphQLQuery;
    const { log } = this.queryClient!.getContext();

    const response = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: q.query,
        variables: q.variables,
      }),
      signal,
    });

    const json = await response.json();

    if (json.errors?.length) {
      log?.error?.('GraphQL error', json.errors[0]);
      throw new Error(json.errors[0].message);
    }

    return json.data;
  }
}

// Base query class: purely declarative
abstract class GraphQLQuery extends Query {
  static override adapter = GraphQLAdapter;

  abstract query: string;
  abstract variables?: Record<string, unknown>;

  getIdentityKey() {
    return `graphql:${this.query}:${JSON.stringify(this.variables ?? {})}`;
  }
}
```

Individual queries extend _your_ base class, not `RESTQuery`:

```ts
class GetUser extends GraphQLQuery {
  params = { id: t.number };

  query = `query GetUser($id: Int!) { user(id: $id) { name email } }`;
  variables = { id: this.params.id };

  result = { user: t.object({ name: t.string, email: t.string }) };
}
```

Custom queries participate in all the same systems as `RESTQuery` --- caching, entity normalization, live data, refetching, and pagination (via `sendNext()` and `hasNext()` on the adapter). The `Query` base class provides the full reactive lifecycle; your adapter only needs to implement the transport.

{% callout title="The identity key" type="note" %}
`getIdentityKey()` returns a value that uniquely identifies this query's _definition_. Two query instances with the same identity key and the same params share the same cache entry and are deduplicated. For `RESTQuery`, the default is `${method}:${path}`. For custom adapters, choose a key that captures all the inputs that make a query unique.
{% /callout %}

---

Now that you understand the basics of defining and using Queries, let's dive into _query types_ and _parsing_.

## Next Steps

{% quick-links %}

{% quick-link title="Types" icon="presets" href="/core/types" description="The full type system for params, results, and entity fields" /%}

{% quick-link title="Entities" icon="plugins" href="/core/entities" description="Normalized entity caching and identity-stable proxies" /%}

{% quick-link title="Mutations" icon="theming" href="/data/mutations" description="Create, update, and delete data with optimistic updates" /%}

{% quick-link title="REST Queries Reference" icon="installation" href="/reference/rest-queries" description="Override methods, identity keys, and dynamic configuration" /%}

{% /quick-links %}
