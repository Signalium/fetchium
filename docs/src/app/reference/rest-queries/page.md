---
title: REST Queries Reference
---

This page covers the advanced configuration options for `RESTQuery`. For the fundamentals --- params, result, defining queries, and the query class rules --- see the [Queries](/core/queries) guide.

---

## Override Methods

Every static field on `RESTQuery` has a corresponding `get*()` method for dynamic logic. When both a static field and a `get*` method are defined, the method takes priority.

```tsx
class GetUserPosts extends RESTQuery {
  params = {
    userId: t.number,
    status: t.optional(t.string),
  };
  path = `/users/${this.params.userId}/posts`;
  result = {
    posts: t.array(t.object({ title: t.string, body: t.string })),
  };

  getSearchParams() {
    const status = this.params.status;
    return status ? { status } : undefined;
  }
}
```

### Method reference

| Method                | Returns                       | Description                        |
| --------------------- | ----------------------------- | ---------------------------------- |
| `getPath()`           | `string \| undefined`         | Dynamic path override              |
| `getMethod()`         | `string`                      | Dynamic HTTP method                |
| `getSearchParams()`   | `Record \| undefined`         | Dynamic search params              |
| `getBody()`           | `Record \| undefined`         | Dynamic request body               |
| `getHeaders()`        | `HeadersInit \| undefined`    | Dynamic request headers            |
| `getRequestOptions()` | `RequestOptions \| undefined` | Dynamic fetch options              |
| `getConfig()`         | `ConfigOptions \| undefined`  | Dynamic cache/retry/network config |

---

## Storage Keys

Each query instance is identified by a storage key, which determines its cache identity. Two query instances with the same storage key share the same cache entry and are deduplicated --- only one network request is made at a time.

By default, `RESTQuery` computes the key as:

```
${method}:${interpolatedPath}
```

For example, `GetUser` with `{ id: 42 }` produces the key `GET:/users/42`.

### Custom storage keys

Override `getStorageKey()` when the default key doesn't capture all the inputs that make a query unique:

```tsx
class SearchUsers extends RESTQuery {
  params = {
    query: t.string,
    filters: t.optional(t.object({ role: t.string })),
  };
  path = '/users/search';
  result = {
    users: t.array(t.object({ name: t.string, email: t.string })),
    total: t.number,
  };

  getStorageKey() {
    return `search:${this.params.query}:${this.params.filters?.role ?? 'all'}`;
  }
}
```

This is useful when search params or body fields affect the response but don't appear in the path.

---

## Network Modes

The `networkMode` config option controls when Fetchium fires requests relative to network connectivity.

| Mode                       | Description                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `NetworkMode.Online`       | (default) Only fetch when the browser is online. Pauses when offline, resumes on reconnect. |
| `NetworkMode.Always`       | Fetch regardless of network status. Useful for local APIs or service workers.         |
| `NetworkMode.OfflineFirst` | Serve cached data immediately, then refetch in the background when online.            |

```tsx
import { RESTQuery, t, NetworkMode } from 'fetchium';

class GetDashboard extends RESTQuery {
  path = '/dashboard';
  result = { stats: t.object({ visits: t.number }) };

  config = {
    networkMode: NetworkMode.OfflineFirst,
  };
}
```

The `refreshStaleOnReconnect` option (default `true`) controls whether stale queries are automatically refetched when connectivity returns.

---

## Retry Configuration

By default, queries retry 3 times on the client and 0 times on the server. You can customize this with the `retry` config option.

### Simple retry count

```tsx
config = {
  retry: 5, // retry up to 5 times
};
```

Set `retry: false` or `retry: 0` to disable retries entirely.

### Detailed retry config

For control over delay strategy, pass a config object:

```tsx
config = {
  retry: {
    retries: 3,
    retryDelay: (attempt) => 1000 * Math.pow(2, attempt), // exponential backoff
  },
};
```

---

## Dynamic Config with getConfig()

For runtime-dependent configuration, override `getConfig()`. This is useful when caching or network behavior should vary based on the query's params or other runtime state:

```tsx
class GetDashboard extends RESTQuery {
  path = '/dashboard';
  result = { stats: t.object({ visits: t.number }) };

  getConfig() {
    return {
      staleTime: 60_000,
      gcTime: 30,
      networkMode: NetworkMode.OfflineFirst,
    };
  }
}
```

When both a static `config` field and `getConfig()` are defined, the method takes priority.
