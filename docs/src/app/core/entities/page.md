---
title: Entities
---

Queries may be the foundation of Fetchium's data model, but _entities_ are its connective tissue. They provide **normalized, deduplicated data objects** that are shared across _all_ queries. When the same entity (identified via typename + id) is returned by multiple queries, they all share the same object reference -- meaning updates to an entity from any source are immediately visible everywhere.

---

## Defining an Entity

To define an entity, extend the `Entity` class and declare fields using the type DSL. Every entity must have a typename and an ID, defined with `t.typename` and `t.id` respectively.

```tsx
import { Entity, t } from 'fetchium';

class User extends Entity {
  __typename = t.typename('User');
  id = t.id;

  name = t.string;
  email = t.string;
  avatar = t.optional(t.string);
  createdAt = t.format('date-time');
}
```

Every entity is uniquely identified by the combination of its **typename** and **id**. The typename is used in a variety of cases, including _type discrimination_ for unions, streaming updates, and normalization and deduplication.

Entities can be referenced using `t.entity` in queries or in other entities:

```ts
class User extends Entity {
  __typename = t.typename('User');
  id = t.id;

  name = t.string;
}

class Post extends Entity {
  __typename = t.typename('Post');
  id = t.id;

  title = t.string;
  author = t.entity(User);
}

class GetPost extends RESTQuery {
  params = {
    id: t.string,
  };

  path = `/posts/${this.params.id}`;

  result = {
    post: t.entity(Post),
  };
}
```

{% callout type="warning" %}
Entities are **read-only**. Attempting to set a property on an entity will throw an error in development mode. To update entity data, use mutations or streaming updates.
{% /callout %}

---

## Signalium Feature: Identity-Stable Proxies

When Fetchium parses a query response, it does not return plain JavaScript objects for entities. Instead, it returns **Proxy objects** that are tied to the normalized entity store.

The key property of these proxies is **identity stability**: for any given `(typename, id)` pair, Fetchium always returns the **same proxy object**. This has several important consequences:

- **Reference equality across queries.** If `GetUser` and `GetPostWithAuthor` both return User #42, the `user` object in both results is the exact same proxy (`===`).
- **Automatic updates.** When an entity's data changes (from a refetch, mutation, or stream), the proxy reflects the new data immediately. Any component or reactive function reading from that proxy sees the update.
- **Safe to store in state.** You can save an entity proxy in local state or pass it as a prop. It will never go stale -- it always points to the latest data in the cache.

```tsx
// Two different queries returning the same user
const { user } = await fetchQuery(GetUser, { id: '1' });
const { post } = await fetchQuery(GetPostWithAuthor, { postId: '5' });

// If post #5's author is user #1, these are the exact same object
user === post.author; // true
```

Each proxy object is backed by a single signal, which is notified whenever the entity is updated. Entanglement of these signals is _lazy_, meaning that if you do not use any properties, you do not pay the cost:

```tsx
const getPostTitle = reactive(async () => {
  const { post } = await fetchQuery(GetPostWithAuthor, { postId: '5' });

  if (post.showAuthor) {
    // Author signal is entangled if this branch is taken
    return `${post.title} - by ${post.author.name}`;
  }

  // Author signal is ignored if this one is taken
  return post.title;
});
```

### React Behavior

When crossing the boundary between Fetchium/Signalium into React via `useQuery` or `useReactive`, the value is _deeply cloned_ with _structural sharing_. This means that duplicate objects will be created for each reactive barrier, and values will be _eagerly_ entangled.

While this is somewhat less performant, it is also inline with React's expectations for state management, and structural sharing prevents excessive invalidation from optimizations by `useMemo`, `React.memo`, and the React compiler.

---

## Nested Entities

Entities can reference other entities using `t.entity(EntityClass)`. Nested entities are also normalized and deduplicated -- they follow all the same rules as top-level entities.

```tsx
class Comment extends Entity {
  __typename = t.typename('Comment');
  id = t.id;

  body = t.string;
  author = t.entity(User);
}

class Post extends Entity {
  __typename = t.typename('Post');
  id = t.id;

  title = t.string;
  body = t.string;
  author = t.entity(User);
  comments = t.array(t.entity(Comment));
}
```

In this example, if a `Post` and one of its `Comment`s reference the same `User`, both `post.author` and `comment.author` will be the same proxy object. Updating that user's name via any query will update it in both places.

```tsx
class GetPost extends RESTQuery {
  params = { id: t.id };

  path = `/posts/${this.params.id}`;

  result = { post: t.entity(Post) };
}

// After fetching:
const post = result.post;
const firstComment = post.comments[0];

// If the post author and first comment author are the same user:
post.author === firstComment.author; // true
post.author.name; // "Alice"
firstComment.author.name; // "Alice" (same object)
```

---

## Entity Methods

You can define methods directly on entity classes. Methods have access to the entity's fields via `this` and are automatically wrapped with `reactiveMethod` for memoization -- meaning the same arguments produce the same result without recomputation.

```tsx
class User extends Entity {
  __typename = t.typename('User');
  id = t.id;

  firstName = t.string;
  lastName = t.string;
  age = t.number;

  get fullName() {
    return `${this.firstName} ${this.lastName}`;
  }

  greet() {
    return `Hello, ${this.name}!`;
  }

  isAdult() {
    return this.age >= 18;
  }
}
```

Methods work on entity proxies just like regular methods:

```tsx
const user = result.user;
user.fullName; // "Alice Smith"
user.greet(); // "Hello, Alice!"
user.isAdult(); // true
```

---

## Entity Cache Configuration

You can control how long unused entities stay in memory using the static `cache` property on the entity class. The `gcTime` option specifies the number of **minutes** an entity remains in the cache after it is no longer referenced by any active query.

```tsx
class User extends Entity {
  static cache = { gcTime: 5 }; // Keep in cache for 5 minutes after last use

  __typename = t.typename('User');
  id = t.id;

  name = t.string;
}
```

| `gcTime` value        | Behavior                                                             |
| --------------------- | -------------------------------------------------------------------- |
| `undefined` (default) | Entity is evicted immediately when no queries reference it           |
| `0`                   | Entity is evicted on the next tick                                   |
| `5`                   | Entity stays in cache for 5 minutes after last reference is released |
| `Infinity`            | Entity is never garbage collected                                    |

{% callout %}
Cache configuration is set at the entity class level, not per-query. All instances of `User` share the same GC policy.
{% /callout %}

---

## Deduplication in Practice

One of the most powerful features of Fetchium's entity system is automatic deduplication. Here is a concrete example showing how it works across multiple queries.

Consider a social feed where you fetch a list of posts and also fetch individual user profiles:

```tsx
class User extends Entity {
  __typename = t.typename('User');
  id = t.id;

  name = t.string;
  avatar = t.string;
}

class Post extends Entity {
  __typename = t.typename('Post');
  id = t.id;

  title = t.string;
  author = t.entity(User);
}

class GetFeed extends RESTQuery {
  path = '/feed';

  result = { posts: t.array(t.entity(Post)) };
}

class GetUser extends RESTQuery {
  params = { id: t.id };

  path = `/users/${this.params.id}`;

  result = { user: t.entity(User) };
}
```

```tsx {% mode="react" %}
function Feed() {
  const result = useQuery(GetFeed);

  if (!result.isReady) return <div>Loading...</div>;

  return (
    <div>
      {result.value.posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </div>
  );
}

function UserProfile() {
  const result = useQuery(GetUser, { id: '1' });

  if (!result.isReady) return <div>Loading...</div>;

  // If user #1 also authored a post in the feed, this is the SAME proxy.
  // Updating the user's name here updates it in the feed too.
  return <h1>{result.value.user.name}</h1>;
}
```

```tsx {% mode="signalium" %}
const Feed = component(() => {
  const { posts } = fetchQuery(GetFeed);

  return (
    <div>
      {posts.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </div>
  );
});

const UserProfile = component(() => {
  const { user } = fetchQuery(GetUser, { id: '1' });

  // If user #1 also authored a post in the feed, this is the SAME proxy.
  // Updating the user's name here updates it in the feed too.
  return <h1>{user.name}</h1>;
});
```

If the feed response includes posts authored by User #1, and you also fetch User #1 directly via `GetUser`, both queries share the same `User` proxy. A mutation that updates User #1's name will be reflected in both the feed and the profile -- with no manual cache invalidation needed.

---

## Subscriptions

Entities can subscribe to real-time updates by defining a `__subscribe` method. When an entity proxy is actively being read by a reactive context (a component, a watcher, etc.), Fetchium will call `__subscribe` to establish a real-time connection.

```tsx
class User extends Entity {
  __typename = t.typename('User');
  id = t.id;

  name = t.string;
  email = t.string;

  __subscribe(onEvent) {
    // Connect to a WebSocket, SSE stream, or other real-time source
    const ws = new WebSocket(`/ws/users/${this.id}`);

    ws.onmessage = (msg) => {
      const data = JSON.parse(msg.data);
      onEvent({
        type: 'update',
        typename: 'User',
        data: { id: this.id, ...data },
      });
    };

    // Return a cleanup function
    return () => ws.close();
  }
}
```

The `__subscribe` method receives an `onEvent` callback. Call it with a mutation event whenever the entity changes. Fetchium will merge the update into the entity store, and all proxies will reflect the new data.

The cleanup function returned from `__subscribe` is called when the entity is no longer being actively observed (i.e., no components or watchers are reading it).

{% callout %}
The `__subscribe` method is only called when the entity is being actively consumed in a reactive context. If no component or reactive function is reading the entity's properties, the subscription will not be established (or will be torn down if it was previously active).
{% /callout %}

For more details on real-time streaming patterns, see the [Streaming guide](/reference/streaming).
