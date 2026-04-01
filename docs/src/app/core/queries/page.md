---
title: Queries
---

Fetchium is founded on the well-established Query-Mutation split-paradigm of modern data fetching libraries, wherein:

- **Queries** are parameterized requests to _read_ data without changing its state
- **Mutations** are parameterized requests to _change the state_ of that data

This pattern works across many different protocols and standards, including:

- **REST APIs**, with GET requests as Queries and POST/PATCH/PUT/DELETE requests as Mutations
- **GraphQL**, which has this exact split itself built into the types of the query language
- **JSON-RPC** and **gRPC** have no _formal_ distinction between read and write RPCs - but these can layered on top manually and fit into this paradigm nicely

Fetchium currently supports JSON REST APIs as they are the lowest common denominator across the web ecosystem, but it is built from the ground up to support _any_ of them with a simple, easily expandable class-based adapter system.

More importantly, Fetchium handles caching, deduplication, and refetching behind the scenes. And when your results include [Entities](/core/entities) and Live Collections, Fetchium also handles normalization and incremental streaming updates.

## Defining a Query

All queries fundamentally require two user defined fields: _params_ and _result_.

- `params` defines what the caller must provide.
- `result` defines the response shape that is returned.

These are defined using a type-validation-DSL, `t`, which is discussed more in the next section. For now, we'll only use simple type validators like `t.number` or `t.string` which are self-explanatory.

Here is a basic example using RESTQuery.

```tsx
import { RESTQuery, t } from 'fetchium';

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
import { RESTQuery, t } from 'fetchium';

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

The same distinction applies to query _results_. Internally, `RESTQuery` exposes its response on `this.response` (which can be used for things like controlling retry or polling behavior based on if the response was successful or errored), but this response gets parsed by the `this.result` definition, and exposed externally.

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
  __fetchMore(): Promise<Q['result']>;
};

declare function useQuery<Q extends Query>(
  query: Q,
  params: Q['params'],
  opts?: {
    suspended?: boolean;
  },
): ReactivePromise<QueryResult<Q>>;
```

The reason `__refetch` and `__fetchMore` are defined on the _result_ of the query and not the `ReactivePromise` is about composability, which leads us into usage within Signalium.

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

Now that you understand the basics of defining and using Queries, let's dive into _query types_ and _parsing_.

## Next Steps

{% quick-links %}

{% quick-link title="Types" icon="presets" href="/core/types" description="The full type system for params, results, and entity fields" /%}

{% quick-link title="Entities" icon="plugins" href="/core/entities" description="Normalized entity caching and identity-stable proxies" /%}

{% quick-link title="Mutations" icon="theming" href="/core/mutations" description="Create, update, and delete data with optimistic updates" /%}

{% quick-link title="REST Queries Reference" icon="installation" href="/reference/rest-queries" description="Override methods, storage keys, network modes, and retry config" /%}

{% /quick-links %}
