import { describe, it, expect, afterEach, vi } from 'vitest';
import { render } from 'vitest-browser-react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { ContextProvider } from 'signalium/react';
import React, { useState } from 'react';
import { QueryClient, QueryClientContext } from '../../QueryClient.js';
import { NoOpNetworkManager } from '../../NetworkManager.js';
import { Entity } from '../../proxy.js';
import { t } from '../../typeDefs.js';
import { RESTQuery, RESTQueryAdapter } from '../../rest/index.js';
import { createMockFetch, sleep } from '../../__tests__/utils.js';
import { useQuery } from '../use-query.js';

// A server render and the hydrating client both read the query from a seed, with no fetch.

class Fungible extends Entity {
  __typename = t.typename('Fungible');
  id = t.id;
  name = t.string;
}

class GetFungible extends RESTQuery {
  static cache = { cacheTime: 0 };
  path = '/f';
  result = t.entity(Fungible);
  config = { staleTime: 30_000 };
}

const fungible = (name: string) => ({ __typename: 'Fungible', id: 'x', name });

let clients: QueryClient[] = [];
let roots: Root[] = [];

afterEach(() => {
  for (const root of roots) root.unmount();
  roots = [];
  for (const client of clients) client.destroy();
  clients = [];
  vi.restoreAllMocks();
});

function makeClient(mockFetch: ReturnType<typeof createMockFetch>): QueryClient {
  const client = new QueryClient({
    networkManager: new NoOpNetworkManager(),
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
  });
  clients.push(client);
  return client;
}

function Reader(): React.ReactNode {
  const r = useQuery(GetFungible);
  return <div id="reader">{r.isReady ? r.value.name : 'PENDING'}</div>;
}

describe('setQueryData in React', () => {
  it('hydrates server HTML without a mismatch, a loading frame or a fetch', async () => {
    const payload = JSON.parse(JSON.stringify(fungible('SEEDED')));
    const fetchedAt = Date.now() - 5_000;
    // What `renderToString` produces for <Reader /> with this seed (asserted in set-query-data.test.ts). The
    // browser test build cannot load react-dom/server, so it is written out here.
    const serverHtml = '<div id="reader">SEEDED</div>';

    const clientFetch = createMockFetch();
    const browser = makeClient(clientFetch);
    browser.setQueryData(GetFungible, undefined, payload, { updatedAt: fetchedAt });

    const errors: unknown[] = [];
    const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });
    const container = document.createElement('div');
    container.innerHTML = serverHtml;
    document.body.appendChild(container);
    const painted: string[] = [];
    const observer = new MutationObserver(() => painted.push(container.textContent ?? ''));
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    roots.push(
      hydrateRoot(
        container,
        <ContextProvider contexts={[[QueryClientContext, browser]]}>
          <Reader />
        </ContextProvider>,
        { onRecoverableError: error => errors.push(error) },
      ),
    );
    await sleep(100);
    observer.disconnect();
    consoleError.mockRestore();

    expect(errors).toEqual([]);
    expect(container.textContent).toBe('SEEDED');
    expect(painted).not.toContain('PENDING');
    expect(clientFetch.calls).toHaveLength(0);
    container.remove();
  });

  it('seeds a query from a parent’s render, then updates the mounted useQuery from it', async () => {
    const mockFetch = createMockFetch();
    const client = makeClient(mockFetch);
    const base = Date.now();
    const errors: unknown[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(args);
    });

    let bump!: () => void;
    function Parent(): React.ReactNode {
      const [n, setN] = useState(0);
      bump = () => setN(x => x + 1);
      // The first call seeds the reader's first read. Later renders change anything only with a newer `updatedAt`.
      client.setQueryData(GetFungible, undefined, fungible(n === 0 ? 'FIRST' : `LOADER ${n}`), { updatedAt: base + n });
      return (
        <ContextProvider contexts={[[QueryClientContext, client]]}>
          <Reader />
        </ContextProvider>
      );
    }

    const { getByText } = render(<Parent />);
    await expect.element(getByText('FIRST')).toBeInTheDocument();

    bump();
    await expect.element(getByText('LOADER 1')).toBeInTheDocument();
    bump();
    await expect.element(getByText('LOADER 2')).toBeInTheDocument();

    expect(errors).toEqual([]);
    expect(mockFetch.calls).toHaveLength(0);
  });
});
