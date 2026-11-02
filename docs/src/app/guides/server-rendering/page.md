---
title: Server Rendering
---

`renderToString` cannot wait for a fetch, so a query that starts with no data renders as pending, and a crawler that cannot run client code sees that. Seed the query from the data your server loader already has with `QueryClient.setQueryData`. The first read then has the data synchronously, on the server and again when the client hydrates, so both renders match. With a fresh `updatedAt` and a `staleTime` that covers it, neither fetches.

A store does not do this on its own. A synchronous store serves only data younger than the query's `cacheTime`, and a query with `static cache = { cacheTime: 0 }` never reads from it.

---

## Loader to render

Have the loader return the raw API response and the time it was fetched. If you cache the loader's JSON, cache both.

```ts
// loader, server only
export async function loader({ params }) {
  const { data, fetchedAt } = await getCachedJson(`/tokens/${params.id}`);
  return { id: params.id, data, fetchedAt };
}
```

Seed in the route component, before the query's first read. The same code runs for the server render and for hydration.

```tsx
import { QueryClientContext } from 'fetchium';
import { useQuery } from 'fetchium/react';
import { useContext } from 'signalium/react';
import { useLoaderData } from 'react-router'; // or your framework's loader hook
import { GetToken } from './queries';

export default function TokenRoute() {
  const { id, data, fetchedAt } = useLoaderData();
  const client = useContext(QueryClientContext)!;

  // Safe on every render: older or equal data is ignored.
  client.setQueryData(GetToken, { id }, data, { updatedAt: fetchedAt });

  return <TokenPage id={id} />;
}

function TokenPage({ id }) {
  const token = useQuery(GetToken, { id });
  return token.isReady ? <h1>{token.value.name}</h1> : null;
}
```

`setQueryData` keeps `data` as it is and parses it with `GetToken`'s own schema at the query's first read. Its entities are shared with every other query that returns them. If it does not parse, the client's `log` warns at that read, or never when nothing reads the query, and the query falls back to the store and a fetch.

---

## One client per request

On the server, create a `QueryClient` for each request so one user's data never reaches another. Give it a `NoOpNetworkManager`, the SSR-safe network manager that registers no listeners, and call `destroy()` once the HTML is rendered.

```tsx
import { QueryClient, QueryClientContext, NoOpNetworkManager } from 'fetchium';
import { RESTQueryAdapter } from 'fetchium/rest';
import { ContextProvider } from 'signalium/react';
import { renderToString } from 'react-dom/server';

const client = new QueryClient({
  networkManager: new NoOpNetworkManager(),
  adapters: [new RESTQueryAdapter({ fetch, baseUrl: API_URL })],
});

try {
  const html = renderToString(
    <ContextProvider contexts={[[QueryClientContext, client]]}>
      <App />
    </ContextProvider>,
  );
  return new Response(html, { headers: { 'content-type': 'text/html' } });
} finally {
  client.destroy();
}
```

`destroy()` also drops seeds that were never read and cancels a refetch that a stale seed queued. The browser keeps one long-lived client, as usual.

---

## `updatedAt`, `staleTime` and `cacheTime`

`updatedAt` is when your server fetched the data, in epoch milliseconds. It defaults to now.

| Seed age against `staleTime`                                         | After the first read                                        |
| -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Younger                                                              | No fetch.                                                   |
| Older, such as a 120 s cached loader response and a 30 s `staleTime` | The data renders at once, then a background refetch starts. |
| Any age, `staleTime: Infinity`                                       | No fetch.                                                   |

The default `staleTime` is 0, so a query that sets none refetches after its first read whatever `updatedAt` says. On the server, that refetch is wasted work. Use a `staleTime` at least as long as your loader cache, or call `destroy()` right after rendering.

`cacheTime` does not matter. A seed is used for the first read whatever the store holds, so a server and a client with different stores render the same HTML. The seeded data is written to the store like a fetched response.

---

## Things to know

- **Raw data, positional params.** `data` is the response as the server sent it, not parsed values as TanStack's `setQueryData` takes. `params` is required, so pass `undefined` for a query without params. `prefetch` lets you omit it.
- **Match the reader's params.** The seed is keyed as `fetchQuery` keys the query, so pass the same params the component passes.
- **Seed before the first read.** Do it in the loader or in the render of a component above the reader. Calling it again later is fine. A newer `updatedAt` updates a mounted reader, from a loader revalidation for example. Don't call it from inside a reactive computation that already read the query, since that computation is not re-run.
- **Invalidation wins for a query that exists.** `invalidateQueries` drops seeds that were not read yet, and a query that exists ignores a seed fetched before its last invalidation. A query that does not exist yet remembers nothing, so an invalidation from before it was created does not reject an older seed.
- **Newer wins per query, not per entity.** An older seed for one query still overwrites an entity that a fresher query wrote, and `staleTime: Infinity` never corrects it. Seed queries that share entities from the same fetch.
- **Signal params seed once.** The seed applies at the reader's first read, by the value its Signal has then. A reader whose Signal moves to seeded params fetches instead, and the unused seed stays until the client is destroyed.
- **Clocks.** `updatedAt` is the server's fetch time, compared with the client's `Date.now()`. A server clock ahead of the browser's makes data look fresher than it is and can admit a seed fetched before an invalidation. A seed timestamped in the client's future counts as fetched just now. A server clock behind the browser's can reject a valid seed, and makes it look staler.
- **Not read means kept.** A seed that no component reads stays until the client is destroyed. It schedules nothing.

See [`setQueryData`](/api/fetchium#set-query-data) for every case.

---

## Next Steps

{% quick-links %}

{% quick-link title="Caching & Refetching" icon="presets" href="/data/caching" description="staleTime, gcTime and cacheTime" /%}

{% quick-link title="Testing" icon="plugins" href="/guides/testing" description="Test queries and components with a mock client" /%}

{% /quick-links %}
