---
title: Streaming
---

Fetchium supports real-time updates through multiple streaming mechanisms --- query-level subscriptions, topic-based streaming, entity subscriptions, polling, and custom transports. Because all streaming integrates directly with Fetchium's entity event system, incoming data flows through the same normalization and live data pipelines as mutations --- live arrays update, live values recompute, and components re-render automatically.

---

## Mutation Events

All streaming data flows through the same `MutationEvent` type used by mutations. There are three event types:

### Create

Signals that a new entity was created. The `data` object must include the entity's `id` field.

```tsx
{
  type: 'create',
  typename: 'Message',
  data: { id: '42', text: 'Hello!', channelId: 1 }
}
```

When a `create` event fires, any live array watching the given typename (and whose constraints match the entity's data) will automatically add the new entity.

### Update

Signals that an existing entity's data changed. Fetchium merges the incoming data with the entity's current cached state.

```tsx
{
  type: 'update',
  typename: 'Message',
  data: { id: '42', text: 'Hello! (edited)' }
}
```

Partial updates are supported --- you only need to include the fields that changed, plus the `id`. Any component reading the updated fields will re-render; components reading only unchanged fields will not.

### Delete

Signals that an entity was removed. The `data` field is the entity's ID (string or number).

```tsx
{
  type: 'delete',
  typename: 'Message',
  data: '42'
}
```

When a `delete` event fires, the entity is removed from any live arrays that contain it, and live values with `onDelete` reducers are updated.

---

## Query Subscriptions

Queries can opt into real-time updates by providing a `subscribe` function in their config. This is a low-level hook that activates when the query activates and cleans up when it deactivates.

```tsx
class GetPrices extends RESTQuery {
  path = '/prices';

  result = {
    prices: t.liveArray(Price),
  };

  getConfig() {
    return {
      subscribe: (onEvent) => {
        const ws = new WebSocket('ws://api.example.com/prices');

        ws.onmessage = (e) => {
          onEvent(JSON.parse(e.data));
        };

        return () => ws.close(); // cleanup
      },
    };
  }
}
```

The `subscribe` function receives an `onEvent` callback that accepts `MutationEvent` objects and returns a cleanup function. Fetchium calls `subscribe` when the query activates (a component reads it) and calls the cleanup function when the query deactivates (all observers disconnect).

{% callout %}
The `subscribe` config is a low-level building block. For polling, use the built-in `poll()` helper. For topic-based streaming (WebSocket message buses, SSE, pub/sub), use [TopicQuery](#topic-queries) --- which provides a declarative, adapter-based approach.
{% /callout %}

### Polling

For simpler real-time needs --- or when WebSocket infrastructure is not available --- Fetchium supports polling as a subscription mechanism. Import `poll` from `fetchium/subscriptions/polling` and assign it to the `subscribe` config option:

```tsx
import { poll } from 'fetchium/subscriptions/polling';

class GetNotifications extends RESTQuery {
  path = '/notifications';

  result = {
    notifications: t.liveArray(Notification),
  };

  config = {
    subscribe: poll({ interval: 5000 }),
  };
}
```

When a component is reading from this query, Fetchium re-fetches the endpoint at the configured interval. The response is diffed against the entity cache, and any changes flow through the entity event system --- live arrays and live values update automatically.

{% callout %}
Polling follows the same demand-driven lifecycle as all subscriptions. Fetchium only polls while at least one component or reactive function is reading from the query. When all observers disconnect, polling stops.
{% /callout %}

### Polling vs. push subscriptions

|                         | Polling                              | Push subscriptions                          |
| ----------------------- | ------------------------------------ | ------------------------------------------- |
| **Transport**           | HTTP (re-fetches the same endpoint)  | Any (WebSocket, SSE, custom)                |
| **Latency**             | Bounded by interval                  | Near real-time                              |
| **Server requirements** | None (standard REST endpoint)        | Server must push events                     |
| **Best for**            | Low-frequency updates, simple setups | High-frequency updates, chat, collaboration |

Both mechanisms feed into the same entity event system, so you can mix and match. Use polling for some queries and push subscriptions for others --- the live data layer does not care where events originate.

---

## Topic Queries

For applications with a centralized message bus --- a single WebSocket connection, an SSE endpoint, a pub/sub system --- `TopicQuery` provides a declarative adapter. Instead of manually wiring `subscribe` callbacks per query, you define _topics_ and let an adapter manage the connection lifecycle.

### Defining a topic query

A topic query extends `TopicQuery` and provides a `topic` field and a `result` shape. Import from `fetchium/topic`:

```tsx
import { t } from 'fetchium';
import { TopicQuery } from 'fetchium/topic';

class GetPrices extends TopicQuery {
  topic = 'prices:live';

  result = {
    prices: t.liveArray(Price),
  };
}
```

Topics can be parameterized using `this.params`, just like paths in `RESTQuery`:

```tsx
class GetBalances extends TopicQuery {
  params = { walletId: t.string };

  topic = `balances:${this.params.walletId}`;

  result = {
    balances: t.liveArray(Balance),
  };
}
```

The identity key for a topic query is `topic:${topic}` --- two queries with the same topic and params share the same cache entry and are deduplicated.

### Implementing an adapter

The `TopicQueryAdapter` is the bridge between your message bus and Fetchium. Extend it and implement two abstract methods:

```tsx
import { TopicQueryAdapter } from 'fetchium/topic';

class MyStreamAdapter extends TopicQueryAdapter {
  private ws: WebSocket;

  constructor(url: string) {
    super();
    this.ws = new WebSocket(url);

    this.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === 'topic-data') {
        // Initial data for a topic
        this.fulfillTopic(msg.topic, msg.data);
      } else if (msg.type === 'topic-error') {
        // Topic subscription failed
        this.rejectTopic(msg.topic, new Error(msg.error));
      } else if (msg.type === 'event') {
        // Ongoing mutation event
        this.sendMutationEvent(msg.event);
      }
    };
  }

  subscribe(topic: string): void {
    this.ws.send(JSON.stringify({ action: 'subscribe', topic }));
  }

  unsubscribe(topic: string): void {
    this.ws.send(JSON.stringify({ action: 'unsubscribe', topic }));
    this.clearTopic(topic);
  }
}
```

The adapter has several protected helper methods:

| Method                      | Description                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| `fulfillTopic(topic, data)` | Resolve the query with initial data. Can be called before or after the query activates.                |
| `rejectTopic(topic, error)` | Reject the query with an error. Can be called before or after the query activates.                     |
| `sendMutationEvent(event)`  | Push a `MutationEvent` through Fetchium's entity event system.                                         |
| `clearTopic(topic)`         | Clear buffered state for a topic. Call this in `unsubscribe` to reset for the next subscription cycle. |
| `clearAll()`                | Clear all buffered topic state. Useful when resetting the connection.                                  |

### Registering the adapter

Pass the adapter to `QueryClient` in the `adapters` array, the same way you register a `RESTQueryAdapter`:

```tsx
import { QueryClient } from 'fetchium';
import { RESTQueryAdapter } from 'fetchium/rest';

const queryClient = new QueryClient({
  adapters: [
    new RESTQueryAdapter({ baseUrl: '/api' }),
    new MyStreamAdapter('ws://api.example.com/stream'),
  ],
});
```

Topic query classes that extend `TopicQuery` directly resolve to the registered `MyStreamAdapter` automatically. Internally, `TopicQuery` declares `static adapter = TopicQueryAdapter` (the abstract base), and `QueryClient` looks up registered adapters by `instanceof` match, so any subclass of `TopicQueryAdapter` you register fulfills the lookup.

{% callout title="One streaming adapter per QueryClient" %}
Register at most one `TopicQueryAdapter` subclass on a given `QueryClient`. If your app needs multiple streaming protocols, create a separate `QueryClient` for each. Dev builds throw if more than one registered adapter satisfies the same lookup.
{% /callout %}

### Pre-fulfillment

A powerful feature of the adapter is that `fulfillTopic` can be called _before_ the query activates. If your message bus proactively sends data for topics it knows the page will need, the adapter can buffer that data:

```tsx
// Data arrives from the stream before any component subscribes
this.fulfillTopic('prices:live', { prices: [...] });

// Later, when a component mounts and reads GetPrices,
// the query resolves immediately with the buffered data
```

This enables smart pre-fetching strategies where the server pushes data ahead of the UI without any explicit prefetch calls.

### Lifecycle

The full lifecycle of a topic query:

1. **Component reads the query** --- Fetchium calls `send()` on the adapter, which creates a deferred promise and calls your `subscribe(topic)` implementation.
2. **Adapter subscribes** --- Your implementation connects to the message bus for this topic (e.g., sends a subscribe message over WebSocket).
3. **Initial data arrives** --- Your `onmessage` handler calls `fulfillTopic(topic, data)`, resolving the deferred promise. The component renders with the data.
4. **Ongoing updates** --- Your handler calls `sendMutationEvent(event)` for each update. Live arrays and live values react automatically.
5. **Component unmounts** --- Fetchium calls your `unsubscribe(topic)` implementation. Your code disconnects from the message bus for this topic.

If the query reactivates later, the cycle repeats from step 1.

---

## Entity Subscriptions

Entities can opt into real-time updates by defining a `__subscribe` method. When an entity with `__subscribe` is actively observed --- read by a mounted component or watched by a reactive function --- Fetchium calls `__subscribe` to establish the connection. When all observers disconnect, the cleanup function is called to tear down the connection.

```tsx
import { Entity, t } from 'fetchium';

class Message extends Entity {
  __typename = t.typename('Message');
  id = t.id;

  text = t.string;
  channelId = t.number;

  __subscribe(onEvent: (event: MutationEvent) => void) {
    const ws = new WebSocket(`ws://api.example.com/messages/${this.id}`);

    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      onEvent({ type: 'update', typename: 'Message', data });
    };

    return () => ws.close(); // cleanup
  }
}
```

The `onEvent` callback accepts a `MutationEvent` and routes it through Fetchium's entity event system. This means any constrained live arrays or live values watching `Message` entities (whose constraints match) will react to the event automatically.

{% callout title="Subscription lifecycle" %}
Subscriptions are **demand-driven**. Fetchium only calls `__subscribe` when at least one component or reactive function is reading the entity. When the last observer disconnects (e.g., a component unmounts), the cleanup function returned by `__subscribe` is called immediately. This prevents resource leaks from orphaned WebSocket connections or event listeners.
{% /callout %}

### Streaming with live data

The real power of streaming comes from combining entity subscriptions with live data primitives. Define your result shapes using `t.liveArray` or `t.liveValue`, add a `__subscribe` method to your entity, and the UI stays in sync automatically.

```tsx
class ChatMessage extends Entity {
  __typename = t.typename('ChatMessage');
  id = t.id;

  text = t.string;
  channelId = t.string;
  author = t.entity(User);
  createdAt = t.string;

  __subscribe(onEvent: (event: MutationEvent) => void) {
    const es = new EventSource(`/api/messages/${this.id}/stream`);

    es.onmessage = (e) => {
      onEvent(JSON.parse(e.data));
    };

    return () => es.close();
  }
}

class GetMessages extends RESTQuery {
  params = { channelId: t.string };

  path = `/channels/${this.params.channelId}/messages`;

  result = {
    messages: t.liveArray(ChatMessage, {
      constraints: { channelId: this.params.channelId },
      sort(a, b) {
        return a.createdAt.localeCompare(b.createdAt);
      },
    }),
  };
}
```

When the subscription fires a `create` event for a `ChatMessage` whose `channelId` matches the query's param, the message is automatically inserted into the live array in sorted order. When it fires a `delete` event, the message is removed. Components reading `messages` re-render with the updated list.

```tsx
import { component } from 'signalium/react';
import { useQuery } from 'fetchium/react';

const ChatRoom = component(({ channelId }: { channelId: string }) => {
  const { messages } = useQuery(GetMessages, { channelId });

  return (
    <div>
      {messages.map((msg) => (
        <div key={msg.id}>
          <strong>{msg.author.name}</strong>: {msg.text}
        </div>
      ))}
    </div>
  );
});
```

No additional wiring is needed. The subscription activates when the component mounts and deactivates when it unmounts.

### Live values with streaming

Live values also respond to streaming events. For example, tracking an unread count:

```tsx
class Channel extends Entity {
  __typename = t.typename('Channel');
  id = t.id;

  name = t.string;
  unreadCount = t.liveValue(t.number, ChatMessage, {
    constraints: { channelId: this.id },
    onCreate: (count, _msg) => count + 1,
    onUpdate: (count, _msg) => count,
    onDelete: (count, _msg) => count - 1,
  });
}
```

When a new `ChatMessage` arrives via the stream for this channel, `unreadCount` increments. When a message is deleted, it decrements. The component reading `channel.unreadCount` re-renders with the new value.

### Channel-level subscriptions

In many applications, you want to subscribe to events for an entire collection rather than individual entities. You can implement this by defining `__subscribe` on a parent entity:

```tsx
class Channel extends Entity {
  __typename = t.typename('Channel');
  id = t.id;

  name = t.string;

  __subscribe(onEvent: (event: MutationEvent) => void) {
    const ws = new WebSocket(`ws://api.example.com/channels/${this.id}/events`);

    ws.onmessage = (e) => {
      // The server sends events for all entity types in this channel
      const event = JSON.parse(e.data);
      onEvent(event);
    };

    return () => ws.close();
  }
}
```

The server can send events for any entity type through a single connection. For example, it might push `ChatMessage` create events, `User` update events (online/offline status), and `Reaction` events all through the same WebSocket. Each event is routed to the appropriate live data based on its `typename`.

---

## Custom Transports

You can implement any transport mechanism to deliver real-time updates. The key integration point is `queryClient.applyMutationEvent()`, which injects a `MutationEvent` into the entity event system manually.

### Example: shared WebSocket connection

```tsx
import { QueryClient } from 'fetchium';

const queryClient = new QueryClient();

// Single WebSocket for all real-time events
const ws = new WebSocket('ws://api.example.com/events');

ws.onmessage = (e) => {
  const event = JSON.parse(e.data);

  // Route the event through Fetchium's entity system
  queryClient.applyMutationEvent(event);
};
```

This is useful when your application has a single event bus (e.g., one WebSocket connection for the entire app) rather than per-entity subscriptions. Events pushed through `applyMutationEvent` behave identically to events from `__subscribe` or mutations --- they trigger live array updates, live value reducers, and component re-renders.

### Example: Server-Sent Events

```tsx
const eventSource = new EventSource('/api/events');

eventSource.addEventListener('entity-event', (e) => {
  const event = JSON.parse(e.data);
  queryClient.applyMutationEvent(event);
});
```

### Example: Firebase Realtime Database

```tsx
import { ref, onValue } from 'firebase/database';

const messagesRef = ref(db, `channels/${channelId}/messages`);

onValue(messagesRef, (snapshot) => {
  const messages = snapshot.val();

  Object.entries(messages).forEach(([id, data]) => {
    queryClient.applyMutationEvent({
      type: 'update',
      typename: 'ChatMessage',
      data: { id, ...data },
    });
  });
});
```

{% callout type="warning" %}
When using `applyMutationEvent` directly, you are responsible for managing the connection lifecycle (opening, reconnecting, closing). Fetchium does not manage custom transport connections --- it only processes the events you deliver. For managed lifecycle, use [Topic Queries](#topic-queries) or [Entity Subscriptions](#entity-subscriptions) instead.
{% /callout %}

---

## Subscription Lifecycle

Understanding when subscriptions activate and deactivate is important for managing resources and avoiding leaks.

### Activation

A subscription activates when:

1. A component mounts and reads an entity that defines `__subscribe`, or a query with `config.subscribe`.
2. A reactive function watched by a watcher reads the entity or query.
3. A live array or live value that depends on the entity is being observed.

Fetchium calls `__subscribe` once per entity instance and `config.subscribe` once per query instance, regardless of how many observers are reading it.

### Deactivation

A subscription deactivates when:

1. All components reading the entity or query unmount.
2. All watchers observing the entity or query disconnect.
3. The entity is evicted from the cache.

At that point, Fetchium calls the cleanup function returned by `__subscribe` or `config.subscribe`.

### Reconnection

If an entity or query is unobserved and then observed again (e.g., a component remounts), the subscribe function is called again to re-establish the connection. Fetchium does not cache or reuse previous subscriptions.

{% callout title="Memory management" %}
Always return a cleanup function from `__subscribe` and `config.subscribe`. If you open a WebSocket, EventSource, or any other persistent connection, the cleanup function must close it. Failing to do so will leak connections even after the entity is no longer observed.
{% /callout %}

---

## Combining Patterns

In practice, most applications combine multiple real-time strategies:

```tsx
// Topic-based streaming for live market data
class GetPrices extends TopicQuery {
  topic = 'prices:live';
  result = { prices: t.liveArray(Price) };
}

// Entity-level subscription for individual message updates
class ChatMessage extends Entity {
  __typename = t.typename('ChatMessage');
  id = t.id;

  text = t.string;
  channelId = t.string;

  __subscribe(onEvent) {
    const es = new EventSource(`/api/messages/${this.id}/stream`);
    es.onmessage = (e) => onEvent(JSON.parse(e.data));
    return () => es.close();
  }
}

// Polling for low-priority data
class GetSystemStatus extends RESTQuery {
  path = '/status';

  result = t.object({ healthy: t.boolean, activeUsers: t.number });

  config = {
    subscribe: poll({ interval: 30000 }),
  };
}
```

All patterns --- topic queries, entity subscriptions, query subscriptions, and polling --- feed into the same entity event system. Live arrays and live values respond to events regardless of their origin, giving you a unified reactive data layer.
