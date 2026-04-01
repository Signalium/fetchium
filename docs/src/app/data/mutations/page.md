---
title: Mutations
---

In the [Queries](/core/queries) guide, we established that Fetchium is built on the well-known Query-Mutation split: queries _read_ data, mutations _change_ it. We've now covered queries, types, and entities in depth. This guide covers the other half --- mutations.

Like queries, mutations in Fetchium are _protocol-agnostic_ at the fundamental level. The base `Mutation` class makes no assumptions about HTTP, REST, or any particular transport. `RESTMutation` is a built-in adapter for JSON REST APIs, just as `RESTQuery` is for queries. The abstract mutation concept is simpler than you might expect: a mutation accepts parameters, performs some action that changes data, and then declares what _side effects_ that action had on the data model.

Those side effects are the heart of the system.

---

## The Three Side Effects

When data changes on your server, exactly one of three things happened to an entity:

1. **Create** --- a new entity was born
2. **Update** --- an existing entity's data changed
3. **Delete** --- an entity was removed

These three operations are the fundamental vocabulary of data mutation. Every write operation your application performs --- creating a user, editing a post title, removing a comment, toggling a like --- ultimately reduces to one or more of these three effects on your entity model.

Fetchium's mutation system is built around this insight. When you define a mutation, you don't just describe the network request --- you _declare_ which entities are created, updated, or deleted as a result. Fetchium then propagates those declarations through the entire reactive system:

- **Entity proxies** update in place, so every component displaying that entity sees the new data
- **Live arrays** add or remove entities based on create/delete events
- **Live values** recompute their aggregates via the `onCreate`, `onUpdate`, `onDelete` reducers

This is the _declarative_ philosophy at work. You describe _what changed_, and Fetchium handles the mechanics of propagating that change everywhere it needs to go. You never need to manually invalidate queries, update cache entries, or re-fetch lists. The entity normalization system does the heavy lifting.

{% callout title="Coming from TanStack Query?" type="note" %}
In TanStack Query, after a mutation you typically call `queryClient.invalidateQueries()` to mark related queries as stale and trigger refetches. This is an _imperative_ approach --- you call it in your `onSuccess` callback and must know which queries to invalidate.

Fetchium takes a _declarative_ approach. Your first tool is entity effects: declare which entities were created, updated, or deleted, and every query referencing those entities updates automatically through normalization. For cases where entity effects are not sufficient, you can use the `invalidates` effect to mark specific query classes as stale --- but you declare this on the mutation class itself, not in an imperative callback.
{% /callout %}

---

## Defining a Mutation

As with queries, we'll use the built-in `RESTMutation` adapter for our examples. It handles JSON serialization, content-type headers, and path interpolation for REST APIs. For other protocols, you can extend the base `Mutation` class directly --- see [Custom Mutations](#custom-mutations) below.

```tsx
import { RESTMutation, t } from 'fetchium';

class CreateUser extends RESTMutation {
  params = { name: t.string, email: t.string };
  path = '/users';
  method = 'POST';
  body = { name: this.params.name, email: this.params.email };
  result = { id: t.number, name: t.string, email: t.string };
}
```

Mutation classes follow the same _template_ rules as query classes (see the [Query Class Rules](/core/queries#query-class-rules) section). Field values are _references_, not evaluated values. `this.params.name` captures a reference that Fetchium resolves when the mutation is executed. The same rules apply: use fields for direct references and string interpolations, use `get*()` methods when you need dynamic logic.

{% callout %}
If you omit the `body` field, no request body is sent. This is the correct behavior for `DELETE` requests and other mutations that don't need a body. If your mutation needs to send data, always wire `body` explicitly from `this.params`.
{% /callout %}

### Path interpolation

Path interpolation works the same as queries --- use template literal syntax with `this.params`:

```tsx
class UpdateUser extends RESTMutation {
  params = { id: t.id, name: t.string };
  path = `/users/${this.params.id}`;
  method = 'PUT';
  body = { name: this.params.name };
  result = { id: t.number, name: t.string };
}
```

### Default method

The default HTTP method for `RESTMutation` is `POST`. You can set it to `'POST'`, `'PUT'`, `'DELETE'`, or `'PATCH'`.

### Dynamic overrides

For cases where you need more control, `RESTMutation` supports dynamic override methods, just like `RESTQuery`:

| Method                | Overrides        | Description                                                         |
| --------------------- | ---------------- | ------------------------------------------------------------------- |
| `getPath()`           | `path`           | Dynamically compute the request URL                                 |
| `getMethod()`         | `method`         | Dynamically compute the HTTP method                                 |
| `getBody()`           | `body`           | Dynamically compute the request body                                |
| `getRequestOptions()` | `requestOptions` | Dynamically compute fetch options (e.g., `baseUrl`, custom headers) |

---

## Executing Mutations

Mutations are executed using the `getMutation()` function, which returns a `ReactiveTask`. Unlike queries (which are reactive and fire automatically when their params change), mutations are _imperative_ --- you call `.run()` explicitly when the user takes an action.

```tsx {% mode="react" %}
import { getMutation } from 'fetchium';

function CreateUserForm() {
  const createUser = getMutation(CreateUser);

  const handleSubmit = async (data) => {
    const result = await createUser.run({ name: data.name, email: data.email });
    console.log('Created:', result);
  };

  return <form onSubmit={handleSubmit}>...</form>;
}
```

```tsx {% mode="signalium" %}
import { getMutation } from 'fetchium';
import { component } from 'signalium/react';

const CreateUserForm = component(() => {
  const createUser = getMutation(CreateUser);

  const handleSubmit = async (data) => {
    const result = await createUser.run({ name: data.name, email: data.email });
    console.log('Created:', result);
  };

  return <form onSubmit={handleSubmit}>...</form>;
});
```

The `ReactiveTask` object exposes properties for tracking the mutation state:

| Property      | Type                          | Description                           |
| ------------- | ----------------------------- | ------------------------------------- |
| `run(params)` | `(params) => Promise<Result>` | Execute the mutation                  |
| `isPending`   | `boolean`                     | `true` while the request is in flight |
| `isResolved`  | `boolean`                     | `true` after the request succeeds     |
| `isRejected`  | `boolean`                     | `true` if the request failed          |
| `value`       | `Result \| undefined`         | The resolved result, if available     |
| `error`       | `Error \| undefined`          | The error, if the request failed      |

Because the task is reactive, reading `isPending`, `isResolved`, or `value` inside a reactive context (a `component()` or `reactive()` function) will automatically re-render when the mutation state changes. This makes it straightforward to show loading spinners, disable buttons, or display success/error states.

---

## Declaring Effects

Effects are how you tell Fetchium what changed in your data model after a mutation succeeds. There are two ways to declare them: statically on the class, or dynamically via the `getEffects()` method.

### Static effects

Define effects directly on the mutation class using the `effects` property. Each effect type (`creates`, `updates`, `deletes`) is an array of tuples: `[EntityClass, data]`.

```tsx
class UpdateUserName extends RESTMutation {
  params = { id: t.id, name: t.string };
  path = `/users/${this.params.id}`;
  method = 'PUT';
  body = { name: this.params.name };
  result = User;

  effects = {
    updates: [[User, { id: this.params.id, name: this.params.name }]],
  };
}
```

When this mutation succeeds, Fetchium fires an _update_ event for the `User` entity with the matching `id`. Every component displaying that user re-renders with the new name. Every live collection containing that user reflects the change. No manual intervention needed.

### Dynamic effects with `getEffects()`

For effects that depend on the _server response_ (not just the input params), override the `getEffects()` method. Inside this method you have access to `this.params` (the input) and `this.result` (the parsed response):

```tsx
class CreatePost extends RESTMutation {
  params = { title: t.string, body: t.string };
  path = '/posts';
  method = 'POST';
  result = Post;

  getEffects() {
    return {
      creates: [[Post, this.result]],
    };
  }
}
```

This is common for `creates` effects, where the server assigns an `id` and possibly other fields (timestamps, defaults) that you don't know until the response arrives.

{% callout %}
Effects are processed _after_ the response is validated. If the mutation request fails, no effects are applied.
{% /callout %}

### How effects flow through the system

When a mutation fires a `creates` event:

1. The new entity is added to the entity store
2. Any active live array watching that entity type (and whose constraints match) automatically includes the new entity
3. Any live value watching that entity type fires its `onCreate` reducer

When a mutation fires an `updates` event:

1. The existing entity proxy's data is updated in place
2. Components reading the changed properties re-render
3. Any live value watching that entity type fires its `onUpdate` reducer

When a mutation fires a `deletes` event:

1. The entity is removed from the entity store
2. Any live array containing that entity removes it
3. Any live value watching that entity type fires its `onDelete` reducer

This is what makes Fetchium's mutation system _declarative_ rather than _imperative_. You declare the effects once, and the propagation is automatic.

### Invalidating queries

The three entity effects (`creates`, `updates`, `deletes`) handle the _majority_ of post-mutation updates. But sometimes a mutation's impact is too complex or too broad to express as individual entity changes. A bulk reorder, a server-side computation that affects many entities at once, or a complex aggregation that you cannot predict from the input --- in these cases, it's simpler to tell Fetchium: "these queries are now stale, refetch them."

That's what `invalidates` does. It marks matching query instances as _stale_, so they refetch on the next read:

```tsx
class ReorderItems extends RESTMutation {
  params = { listId: t.id, order: t.array(t.id) };
  path = `/lists/${this.params.listId}/reorder`;
  method = 'PUT';
  body = { order: this.params.order };
  result = { success: t.boolean };

  effects = {
    invalidates: [GetListItems],
  };
}
```

Unlike entity effects (which target _entities_ by typename), `invalidates` targets _query classes_. Passing a query class with no params invalidates _all_ active instances of that class.

You can also target specific instances by providing a _param subset_ --- a partial set of params that must match:

```tsx
class BulkUpdateUserPosts extends RESTMutation {
  params = { userId: t.id, status: t.string };
  path = `/users/${this.params.userId}/posts/bulk-update`;
  method = 'POST';
  body = { status: this.params.status };
  result = { count: t.number };

  effects = {
    invalidates: [[GetUserPosts, { userId: this.params.userId }]],
  };
}
```

This invalidates all `GetUserPosts` instances where `userId` matches the mutation's `userId` param, but leaves `GetUserPosts` instances for _other_ users untouched. The matching is a _subset_ check: if the instance has `{ userId: 42, status: 'published' }` and the subset is `{ userId: 42 }`, it matches. Any params not mentioned in the subset are ignored.

You can combine entity effects and query invalidation in the same mutation:

```tsx
effects = {
  updates: [[User, { id: this.params.userId, name: this.params.name }]],
  invalidates: [GetLeaderboard],
};
```

Here, the entity effect surgically updates the user's name everywhere it appears, while `invalidates` handles the leaderboard --- whose rankings may shift in ways you can't predict from the input alone.

{% callout title="invalidates is the escape hatch" type="note" %}
Entity effects should be your _first choice_ for post-mutation updates. They are precise, efficient, and work with optimistic updates and live collections. Use `invalidates` when entity effects are not sufficient --- when the mutation's impact on the data model is too complex, too broad, or depends on server-side logic you don't want to replicate on the client.
{% /callout %}

---

## Optimistic Updates

Optimistic updates let you apply mutation effects _immediately_, before the server responds. This makes your UI feel instant for predictable operations.

Set `optimisticUpdates = true` on the mutation class:

```tsx
class ToggleLike extends RESTMutation {
  params = { postId: t.id, liked: t.boolean };
  path = `/posts/${this.params.postId}/like`;
  method = 'PUT';
  body = { liked: this.params.liked };
  result = Post;
  optimisticUpdates = true;

  effects = {
    updates: [[Post, { id: this.params.postId, liked: this.params.liked }]],
  };
}
```

When you execute this mutation:

1. The effects are applied to the entity store _immediately_ --- the UI updates before any network request
2. The network request is sent in the background
3. If the request succeeds, the optimistic data is replaced with the real server response
4. If the request fails, the optimistic changes are _rolled back_ to the previous state

Optimistic updates work _because_ effects are declarative. Fetchium knows exactly what data was changed (the entity, the fields, the values), so it can snapshot the previous state and restore it on failure. This would not be possible with an imperative cache manipulation API.

{% callout type="warning" %}
Optimistic updates work best for simple, predictable changes --- toggling a boolean, incrementing a counter, updating a text field. For complex mutations where the server may transform the data significantly (e.g., generating slugs, computing derived fields), consider waiting for the real response instead.
{% /callout %}

{% callout type="warning" %}
If a mutation with optimistic updates fails, the rollback restores the entity to its previous state. Make sure your UI handles the error case gracefully --- for example, by showing a toast notification or retry button.
{% /callout %}

---

## Custom Mutations

`RESTMutation` is an adapter for JSON REST APIs. But mutations as a concept are protocol-agnostic. When your use case doesn't fit REST --- GraphQL, file uploads, WebSocket messages, RPC calls --- you extend the base `Mutation` class directly and implement the `send()` method.

This is _not_ an escape hatch or a workaround. It is the intended way to support any protocol. `RESTMutation` is itself just one implementation of `Mutation` with `send()` pre-built for HTTP/JSON. You can build your own adapters the same way.

```tsx
import { Mutation, t } from 'fetchium';

class UploadAvatar extends Mutation {
  params = { userId: t.id, file: t.any };
  result = { url: t.string };

  getIdentityKey() {
    return 'upload-avatar';
  }

  async send() {
    const formData = new FormData();
    formData.append('file', this.params.file);

    const response = await this.context.fetch(
      `/users/${this.params.userId}/avatar`,
      {
        method: 'POST',
        body: formData,
        signal: this.signal,
      },
    );

    this.response = response;
    return response.json();
  }
}
```

Inside `send()`, you have access to:

- **`this.params`** --- the validated input params
- **`this.context`** --- the `QueryContext` with `fetch`, `log`, and `baseUrl`
- **`this.signal`** --- an `AbortSignal` for cancellation
- **`this.response`** --- set this to the raw `Response` object if you want to access it in `getEffects()`

Custom mutations participate in the same effects system as `RESTMutation`. You can define `effects` or `getEffects()` on any mutation class, and the entity store, live collections, and components will react to them identically.

---

## Retry Configuration

By default, mutations do _not_ retry on failure. This is deliberate --- retrying a `POST` that creates a resource could result in duplicates, and retrying a `DELETE` might fail because the resource is already gone. The safe default is to fail and let the application decide what to do.

If you have an idempotent mutation where retries are safe, you can configure retry behavior using the `config` property:

```tsx
class UpdateUserName extends RESTMutation {
  params = { id: t.id, name: t.string };
  path = `/users/${this.params.id}`;
  method = 'PUT';
  body = { name: this.params.name };
  result = User;

  config = {
    retry: {
      retries: 3,
      retryDelay: (attempt) => 1000 * Math.pow(2, attempt),
    },
  };
}
```

The `retry` option accepts:

| Value                  | Behavior                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `false`                | Never retry (default for mutations)                          |
| A number (e.g., `3`)   | Retry up to that many times with default exponential backoff |
| A `RetryConfig` object | Full control over retry count and delay strategy             |

For more details on retry configuration, see the [Error Handling](/guides/error-handling) guide.

---

## Identity Keys

Every mutation has a identity key that uniquely identifies it. For `RESTMutation`, the default identity key is derived from the method and path:

```
POST:/users
PUT:/users/42
```

You can override this by implementing `getIdentityKey()`:

```tsx
class CreateUser extends RESTMutation {
  params = { name: t.string, email: t.string };
  path = '/users';
  method = 'POST';
  result = { id: t.number, name: t.string, email: t.string };

  getIdentityKey() {
    return 'create-user';
  }
}
```

The identity key is used internally to deduplicate mutation definitions. Two mutation classes with the same identity key will share the same underlying mutation instance within a `QueryClient`.

---

## Next Steps

{% quick-links %}

{% quick-link title="Live Data" icon="installation" href="/data/live-data" description="See how mutation effects flow through live arrays and live values" /%}

{% quick-link title="Caching & Refetching" icon="presets" href="/data/caching" description="Understand cache invalidation patterns and when to use __refetch()" /%}

{% quick-link title="Entities" icon="plugins" href="/core/entities" description="How entity normalization enables automatic cross-query updates" /%}

{% quick-link title="Error Handling" icon="theming" href="/guides/error-handling" description="Handle mutation failures, retries, and error states" /%}

{% /quick-links %}
