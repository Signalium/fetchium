---
title: Auth & Headers
---

In most data-fetching libraries, authentication is handled through interceptors, middleware chains, or framework-specific hooks. Fetchium takes a different approach: authentication is handled through the `fetch` function you pass to the `QueryClient`.

This is intentional. Rather than adding a framework-specific interceptor system, Fetchium leverages the web platform's standard `fetch` API. Your auth logic is a _plain JavaScript function_ --- testable, portable, and completely decoupled from the library. You can unit test it without importing Fetchium, reuse it across projects, or swap it out without touching a single query definition.

This page covers the common patterns for adding authentication and custom headers to your Fetchium requests, from the simplest static token all the way through reactive auth state and multi-backend configurations.

---

## Global Headers via a Fetch Wrapper

The simplest and most common pattern is wrapping the native `fetch` with a function that injects your auth token on every request. You pass this wrapper to the `QueryClient` at setup time, and every query uses it automatically.

```ts
function createAuthFetch(getToken: () => string | null) {
  return async (url: RequestInfo, init?: RequestInit) => {
    const token = getToken();
    const headers = new Headers(init?.headers);

    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return fetch(url, { ...init, headers });
  };
}

const client = new QueryClient(store, {
  fetch: createAuthFetch(() => localStorage.getItem('auth_token')),
  baseUrl: 'https://api.example.com',
});
```

Every query that runs through this client will include the `Authorization` header whenever a token is available. If the token is `null` (e.g. the user is logged out), the header is simply omitted.

Notice that `createAuthFetch` accepts a _getter function_ rather than the token directly. This is important --- the token is read at request time, not at client creation time, so it always reflects the current value.

---

## API Key Pattern

If your API uses a static key rather than a user token, the pattern is even simpler:

```ts
const client = new QueryClient(store, {
  fetch: async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-API-Key', process.env.API_KEY!);
    return fetch(url, { ...init, headers });
  },
  baseUrl: 'https://api.example.com',
});
```

This works well for server-side usage or public APIs that require an API key but not user-level authentication.

---

## Reactive Auth with Signalium Signals

In a single-page application, the auth token is not static --- it changes when users log in, log out, or when a refresh token rotates. If you are using Signalium for state management, you can make your auth state _reactive_ so that queries automatically respond to token changes.

```ts
import { signal } from 'signalium';

const authToken = signal<string | null>(null);

function login(token: string) {
  authToken.set(token);
}

function logout() {
  authToken.set(null);
}
```

Then use the signal's value in your fetch wrapper:

```ts
function createReactiveAuthFetch() {
  return async (url: RequestInfo, init?: RequestInit) => {
    const token = authToken.value;
    const headers = new Headers(init?.headers);

    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    return fetch(url, { ...init, headers });
  };
}

const client = new QueryClient(store, {
  fetch: createReactiveAuthFetch(),
  baseUrl: 'https://api.example.com',
});
```

Because `authToken` is a Signalium signal, any reactive computation that reads `authToken.value` establishes a dependency on it. When the token changes --- say, after a login --- active queries that depend on authenticated data will know to refetch with the new credentials.

---

## Per-Query Headers

Sometimes individual queries need headers beyond the global auth token. For example, a file upload endpoint might require a specific `Content-Type`, or a particular API version header.

Fetchium handles this through the `headers` field on your query class:

```ts
class UploadAvatar extends RESTQuery {
  params = {
    userId: t.number,
    contentType: t.string,
  };

  path = `/users/${this.params.userId}/avatar`;
  method = 'PUT';

  headers = {
    'Content-Type': this.params.contentType,
    'X-Upload-Source': 'web-client',
  };

  result = {
    avatarUrl: t.string,
  };
}
```

The layering is straightforward: your global fetch wrapper handles _auth_ (the concern that applies everywhere), and per-query headers handle _API-specific needs_ (the concerns that vary by endpoint). The two are composed naturally --- `headers` from the query class are passed through `init.headers` to your fetch wrapper, which can merge them with auth headers using `new Headers(init?.headers)`.

For dynamic per-query headers that depend on runtime conditions, use the `getHeaders()` method:

```ts
class GetReport extends RESTQuery {
  params = {
    reportId: t.number,
    format: t.optional(t.string),
  };

  path = `/reports/${this.params.reportId}`;

  getHeaders() {
    const headers: Record<string, string> = {};

    if (this.params.format === 'csv') {
      headers['Accept'] = 'text/csv';
    }

    return headers;
  }

  result = {
    data: t.string,
  };
}
```

As described in the [Queries](/core/queries) guide, every field on `RESTQuery` has a corresponding `get*()` method for when you need logic that goes beyond simple references and interpolations.

---

## Handling 401 and Token Refresh

A common requirement is catching `401 Unauthorized` responses, refreshing the auth token, and retrying the original request. Because your fetch wrapper is just a function, this is standard fetch composition --- Fetchium doesn't need a special API for it.

```ts
function createAuthFetchWithRefresh(
  getToken: () => string | null,
  refreshToken: () => Promise<string>,
  setToken: (token: string) => void,
) {
  let refreshPromise: Promise<string> | null = null;

  return async (url: RequestInfo, init?: RequestInit): Promise<Response> => {
    const token = getToken();
    const headers = new Headers(init?.headers);

    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    const response = await fetch(url, { ...init, headers });

    if (response.status === 401 && token) {
      // Deduplicate concurrent refresh attempts
      if (!refreshPromise) {
        refreshPromise = refreshToken().finally(() => {
          refreshPromise = null;
        });
      }

      const newToken = await refreshPromise;
      setToken(newToken);

      // Retry with the new token
      headers.set('Authorization', `Bearer ${newToken}`);
      return fetch(url, { ...init, headers });
    }

    return response;
  };
}
```

A few things to note in this pattern:

- **Deduplication**: If multiple queries receive 401s simultaneously (common after a token expires), only one refresh request is made. The others await the same promise.
- **Single retry**: The request is retried exactly once with the new token. If the retry also fails, the error propagates normally.
- **No Fetchium-specific code**: This function knows nothing about queries or signals. You could use it with plain `fetch` calls in a completely different project.

Wire it into your client the same way:

```ts
const client = new QueryClient(store, {
  fetch: createAuthFetchWithRefresh(
    () => authToken.value,
    () => api.refreshSession(),
    (token) => authToken.set(token),
  ),
  baseUrl: 'https://api.example.com',
});
```

---

## Multiple API Backends

If your application talks to multiple APIs with different auth schemes --- for instance, your own backend with JWT auth and a third-party service with an API key --- you have two options.

### Separate QueryClients

The cleanest approach is creating a dedicated `QueryClient` for each backend:

```ts
const appClient = new QueryClient(appStore, {
  fetch: createAuthFetch(() => authToken.value),
  baseUrl: 'https://api.myapp.com',
});

const analyticsClient = new QueryClient(analyticsStore, {
  fetch: async (url, init) => {
    const headers = new Headers(init?.headers);
    headers.set('X-API-Key', ANALYTICS_API_KEY);
    return fetch(url, { ...init, headers });
  },
  baseUrl: 'https://analytics.example.com',
});
```

Each client has its own store, auth, and base URL. Queries associated with each client are completely independent. In React, you would provide each client through its own `ContextProvider`.

### Per-query `baseUrl`

If you only need to override the URL for a few queries and the auth scheme is the same, you can set `baseUrl` on individual queries via `requestOptions`:

```ts
class GetAnalytics extends RESTQuery {
  params = { eventType: t.string };
  path = `/events/${this.params.eventType}`;

  requestOptions = {
    baseUrl: 'https://analytics.example.com',
  };

  result = {
    count: t.number,
  };
}
```

This query will use the alternate base URL but still go through the same `QueryClient` and its fetch wrapper. This works well when the auth requirements are shared but the hosts differ.

---

{% callout title="Why no interceptors?" type="note" %}
If you are coming from Axios, you may be used to interceptors --- a middleware chain that processes requests and responses. Fetchium deliberately avoids this pattern.

Interceptors introduce ordering complexity (which interceptor runs first?), make testing harder (you have to mock the interceptor chain), and add a layer of abstraction that obscures what your code actually does. A plain fetch wrapper achieves the same thing: you can inspect requests, modify headers, handle errors, retry, and log --- all in a single function with an obvious control flow.

This is a deliberate design decision. Fetchium favors _composition over configuration_. Instead of learning a framework-specific interceptor API, you compose standard JavaScript functions. The result is code that is easier to read, easier to test, and easier to change.
{% /callout %}

---

## Summary

| Pattern | When to use |
| -------------------------------- | ------------------------------------------------------------------ |
| Global fetch wrapper | Auth that applies to all requests (JWT, session cookies, API keys) |
| Reactive signal token | SPAs where auth state changes at runtime (login/logout) |
| Per-query `headers` | Endpoint-specific headers (content types, API versions) |
| `getHeaders()` method | Dynamic per-query headers based on runtime conditions |
| 401 catch + refresh + retry | Token expiration with automatic renewal |
| Multiple `QueryClient` instances | Different APIs with different auth schemes or stores |
| Per-query `requestOptions.baseUrl` | Same auth, different host |

The common thread is that Fetchium does not own your auth logic. It provides the _seam_ --- the `fetch` option on `QueryClient` --- and you fill it with whatever your application needs. This keeps the library small, your auth testable, and your options open.

---

## Next Steps

{% quick-links %}

{% quick-link title="Queries" icon="presets" href="/core/queries" description="Learn how to define queries, configure caching, and fetch data" /%}

{% quick-link title="Error Handling" icon="warning" href="/guides/error-handling" description="Handle network failures, retries, and error boundaries" /%}

{% quick-link title="Testing" icon="installation" href="/guides/testing" description="Test your queries, auth wrappers, and components" /%}

{% quick-link title="Offline & Persistence" icon="plugins" href="/guides/offline" description="Keep your app working without a network connection" /%}

{% /quick-links %}
