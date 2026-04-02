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

## Identity Keys

Each query instance is identified by a identity key, which determines its cache identity. Two query instances with the same identity key share the same cache entry and are deduplicated --- only one network request is made at a time.

By default, `RESTQuery` computes the key as:

```
${method}:${interpolatedPath}
```

For example, `GetUser` with `{ id: 42 }` produces the key `GET:/users/42`.

### Custom identity keys

Override `getIdentityKey()` when the default key doesn't capture all the inputs that make a query unique:

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

  getIdentityKey() {
    return `search:${this.params.query}:${this.params.filters?.role ?? 'all'}`;
  }
}
```

This is useful when search params or body fields affect the response but don't appear in the path.

---

## Dynamic Config with getConfig()

For runtime-dependent configuration, override `getConfig()`. This is useful when caching, network behavior, or retry logic should vary based on the query's params or other runtime state:

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

When both a static `config` field and `getConfig()` are defined, the method takes priority. See the [Caching & Refetching](/data/caching) guide for details on `staleTime` and `gcTime`, the [Offline & Persistence](/guides/offline) guide for network modes, and the [Error Handling](/guides/error-handling) guide for retry configuration.
