---
title: Error Handling
---

Fetchium draws a deliberate line between errors that should _break_ the UI and errors that should be _absorbed_.

Network failures and server errors break the UI --- they reject the query and set `isRejected` to `true`, because the user needs to know that something went wrong. Parse failures for optional fields and array items, on the other hand, are absorbed silently --- they fall back to `undefined` or are filtered out, because showing _nothing_ is a better default than crashing.

This is the same resilience philosophy described in the [Types guide](/core/types). A 500 from your server is genuinely broken; a new enum value your client doesn't recognize yet is not. Fetchium's error system is designed around this distinction so you can build UIs that degrade gracefully without sacrificing visibility into real failures.

---

## ReactivePromise Error States

Every query in Fetchium returns a `ReactivePromise`, which exposes a small set of properties for handling async state --- including errors:

| Property     | Type      | Description                                                                                        |
| ------------ | --------- | -------------------------------------------------------------------------------------------------- |
| `isRejected` | `boolean` | `true` when the most recent execution failed (after all retries are exhausted)                     |
| `error`      | `unknown` | The error object from the rejection. Only meaningful when `isRejected` is `true`                   |
| `isPending`  | `boolean` | `true` during loading, including retry attempts                                                    |
| `isReady`    | `boolean` | `true` once data has loaded successfully at least once --- stays `true` even across later failures |
| `value`      | `T`       | The most recently resolved value. Available when `isReady` is `true`, even if a later fetch fails  |

The standard pattern for handling errors in components follows directly from these properties:

```tsx {% mode="react" %}
import { useQuery } from 'fetchium/react';

function UserProfile({ userId }: { userId: number }) {
  const result = useQuery(GetUser, { id: userId });

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

```tsx {% mode="signalium" %}
import { fetchQuery } from 'fetchium';
import { component } from 'signalium/react';

const UserProfile = component(({ userId }: { userId: number }) => {
  const result = fetchQuery(GetUser, { id: userId });

  if (result.isRejected) return <div>Error: {result.error.message}</div>;
  if (!result.isReady) return <div>Loading...</div>;

  return (
    <div>
      <h1>{result.value.name}</h1>
      <p>{result.value.email}</p>
    </div>
  );
});
```

Note the order: check `isRejected` _first_, then `isReady`. This ensures that a hard failure is always surfaced to the user, even if stale data exists from a previous successful fetch.

---

## Types of Errors

Not all errors are equal. Fetchium distinguishes between three categories, and each surfaces differently.

### Network errors

These occur when `fetch` itself fails --- the device is offline, DNS resolution fails, the connection times out. The browser throws a `TypeError` (or similar), and Fetchium treats it as a rejection. After retries are exhausted, `isRejected` becomes `true` and `error` contains the original `TypeError`.

Network errors are the most common reason for a query to be in a retrying state. While retries are in progress, `isPending` is `true` and any previously loaded `value` remains available.

### HTTP errors

The server responds, but with a non-success status code (4xx, 5xx). By default, `RESTQuery` treats any response where `response.ok` is `false` as an error. The query rejects with an error that includes the status code and response body.

HTTP errors are particularly useful for distinguishing between client mistakes (400, 404, 422) and server failures (500, 502, 503). You can inspect the error in your component or intercept specific status codes globally via the fetch wrapper (see [Global Error Handling](#global-error-handling-via-the-fetch-wrapper) below).

### Parse errors

These are the most nuanced category. When a response body doesn't match the type definition, the behavior depends on the _context_ of the mismatch:

- **Required fields** --- If a top-level required field fails to parse (e.g. the server returns `null` for a `t.string` field), the entire response is treated as a parse error and the query rejects.
- **Optional fields** --- If an optional field (`t.optional(...)`) fails to parse, it silently falls back to `undefined`. No error is surfaced.
- **Array items** --- If an individual item in an array fails to parse, it is silently filtered out. The rest of the array is returned normally.

This design means that additive API changes --- a new enum value in an array, a new optional field with an unexpected shape --- won't crash older clients. The [Types guide](/core/types) covers this philosophy in depth.

{% callout title="When you want explicit parse errors" type="note" %}
If you need to handle parse failures explicitly rather than silently, wrap the field in `t.result(...)` instead of `t.optional(...)`. This returns a `ParseResult<T>` with a `success` flag and either a `value` or `error`, forcing you to handle the failure case in your code.
{% /callout %}

---

## Retry Configuration

Queries retry failed requests automatically. The defaults are:

| Environment | Default retries |
| ----------- | --------------- |
| Client      | 3               |
| Server      | 0               |

Server-side queries don't retry because SSR has strict time budgets --- it's better to fail fast and let the client handle recovery.

### Configuring retries

Retry behavior is controlled via the `config` field on your query class. The simplest form is a count:

```ts
class GetUser extends RESTQuery {
  params = { id: t.number };

  path = `/users/${this.params.id}`;

  result = { name: t.string };

  config = {
    retry: 5,
  };
}
```

For more control, pass an object with `retries` and an optional `retryDelay` function:

```ts
class GetUser extends RESTQuery {
  params = { id: t.number };

  path = `/users/${this.params.id}`;

  result = { name: t.string };

  config = {
    retry: {
      retries: 3,
      retryDelay: (attempt) => 1000 * Math.pow(2, attempt),
    },
  };
}
```

The default retry delay uses exponential backoff --- each successive attempt waits longer than the last (roughly 1s, 2s, 4s, ...). This avoids hammering a struggling server with rapid retries.

To disable retries entirely:

```ts
config = {
  retry: false,
};
```

### Mutations do not retry

Mutations have retries disabled by default. This is a deliberate safety decision --- retrying a `POST` or `DELETE` that may have partially succeeded on the server can cause duplicate writes or unintended side effects. If you need retry behavior on a mutation, you can opt in explicitly, but the default is `retry: false`.

---

## The Relationship Between Errors and Retries

Retries and error states interact in a specific way that is important to understand:

1. A query fails its initial fetch attempt.
2. `isPending` remains `true` while retries are in progress. If the query had previously loaded data, `isReady` stays `true` and `value` still holds the last successful result.
3. If a retry succeeds, the query resolves normally --- `isResolved` becomes `true`, `value` updates, and the error is cleared.
4. If all retries are exhausted, the _final_ error is surfaced: `isRejected` becomes `true` and `error` is set.

This means your UI can continue showing stale data while retries happen in the background. A common pattern is to show a subtle "refreshing" indicator alongside the existing content, and only show the error state if the query has _never_ loaded successfully:

```tsx {% mode="react" %}
function UserProfile({ userId }: { userId: number }) {
  const result = useQuery(GetUser, { id: userId });

  if (result.isRejected && !result.isReady) {
    return <div>Failed to load: {result.error.message}</div>;
  }

  if (!result.isReady) return <div>Loading...</div>;

  return (
    <div>
      {result.isRejected && (
        <div className="warning">
          Could not refresh data. Showing cached results.
        </div>
      )}
      <h1>{result.value.name}</h1>
      <p>{result.value.email}</p>
    </div>
  );
}
```

---

## Global Error Handling via the Fetch Wrapper

Sometimes you need to intercept errors _before_ they reach individual queries --- for instance, redirecting to a login page on a 401, refreshing an auth token, or logging all failures to a telemetry service.

The `RESTQueryAdapter` accepts a `fetch` function, which is the standard place to add global error handling. You can wrap the native `fetch` with your own logic:

```ts
function createFetchWithErrorHandling(baseFetch: typeof fetch) {
  return async (url: RequestInfo, init?: RequestInit) => {
    const response = await baseFetch(url, init);

    if (response.status === 401) {
      // Redirect to login, refresh token, etc.
    }

    if (response.status === 403) {
      // Handle forbidden access
    }

    return response;
  };
}
```

Then pass it when constructing the client:

```tsx
import { QueryClient, QueryClientContext } from 'fetchium';
import { SyncQueryStore, MemoryPersistentStore } from 'fetchium/stores/sync';
import { RESTQueryAdapter } from 'fetchium/rest';
import { ContextProvider } from 'signalium/react';

const store = new SyncQueryStore(new MemoryPersistentStore());
const customFetch = createFetchWithErrorHandling(fetch);
const client = new QueryClient({
  store,
  adapters: [new RESTQueryAdapter({ fetch: customFetch })],
});

function App() {
  return (
    <ContextProvider contexts={[[QueryClientContext, client]]}>
      <YourApp />
    </ContextProvider>
  );
}
```

This approach keeps error handling centralized. Individual queries don't need to know about auth flows or telemetry --- they just see a normal `Response` or a rejection.

---

## Parse Failure Logging

Non-fatal parse failures (optional fields falling back to `undefined`, array items being filtered out) happen silently by default. In production, you'll likely want to know about them --- a sudden spike in parse failures can indicate a breaking API change that technically doesn't crash but does degrade the user experience.

Fetchium routes these warnings through `QueryContext.log.warn`. You can plug in a custom logger when creating the `QueryClient`:

```ts
const client = new QueryClient({
  store,
  log: {
    warn: (message: string, ...args: unknown[]) => {
      console.warn(message, ...args);
      telemetry.trackWarning('parse_failure', { message, args });
    },
    error: (message: string, ...args: unknown[]) => {
      console.error(message, ...args);
      telemetry.trackError('query_error', { message, args });
    },
  },
});
```

The `log.warn` handler receives structured information about what field failed, what value was received, and what type was expected. This gives you enough context to set up alerts for unusual patterns without adding try/catch blocks throughout your codebase.

---

## React Error Boundaries

React's error boundary system provides a last-resort catch for unhandled exceptions during rendering. Fetchium's `ReactivePromise` is designed to work _alongside_ error boundaries, but with an important distinction.

### Default behavior: explicit error handling

By default, reading properties on a `ReactivePromise` does _not_ throw. When a query fails, `isRejected` becomes `true` and `error` is set, but no exception is raised. This is deliberate --- it gives you full control over how errors are presented in your UI.

```tsx
const result = useQuery(GetUser, { id: 42 });

// No exception thrown. You check the state explicitly:
if (result.isRejected) {
  return <ErrorMessage error={result.error} />;
}
```

### Opting into throw behavior

If you _want_ error boundaries to catch query failures --- for example, when using React Suspense or when you prefer a centralized error UI --- you can read `.value` directly. Reading `.value` on a rejected `ReactivePromise` throws the error, which will propagate up to the nearest error boundary.

```tsx
import { ErrorBoundary } from 'react-error-boundary';

function UserProfile({ userId }: { userId: number }) {
  const result = useQuery(GetUser, { id: userId });

  // This throws if the query is rejected,
  // which the ErrorBoundary above will catch
  const user = result.value;

  return (
    <div>
      <h1>{user.name}</h1>
    </div>
  );
}

function App() {
  return (
    <ErrorBoundary fallback={<div>Something went wrong.</div>}>
      <UserProfile userId={42} />
    </ErrorBoundary>
  );
}
```

This is a conscious opt-in. The default explicit-checking pattern (`isRejected` + `error`) is recommended for most use cases because it gives you the most flexibility. Error boundaries are best reserved for catching truly unexpected failures that shouldn't be handled inline.

---

## Summary

| Error type             | Behavior                            | Surfaces as                     |
| ---------------------- | ----------------------------------- | ------------------------------- |
| Network error          | Retried, then rejected              | `isRejected: true`, `error` set |
| HTTP error (4xx/5xx)   | Retried (by default), then rejected | `isRejected: true`, `error` set |
| Parse error (required) | Query rejects                       | `isRejected: true`, `error` set |
| Parse error (optional) | Falls back to `undefined`           | Silent, logged via `log.warn`   |
| Parse error (array)    | Item filtered out                   | Silent, logged via `log.warn`   |
| Mutation failure       | Not retried by default              | `isRejected: true`, `error` set |

---

## Next Steps

{% quick-links %}

{% quick-link title="Types" icon="presets" href="/core/types" description="The resilient type system and parse behavior that drives error handling" /%}

{% quick-link title="Queries" icon="plugins" href="/core/queries" description="Query definitions, caching, retry, and configuration options" /%}

{% quick-link title="Offline & Persistence" icon="installation" href="/guides/offline" description="Network detection, offline mode, and persistent query storage" /%}

{% quick-link title="REST Queries Reference" icon="theming" href="/reference/rest-queries" description="Full field reference including retry, staleTime, and network modes" /%}

{% /quick-links %}
