import { describe, it, expect, afterEach } from 'vitest';
import { MemoryPersistentStore, SyncQueryStore } from '../stores/sync.js';
import { QueryClient } from '../QueryClient.js';
import { NoOpGcManager } from '../GcManager.js';
import { NoOpNetworkManager } from '../NetworkManager.js';
import { createMockFetch } from './utils.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';

/**
 * SSR Guard Tests
 *
 * Verifies that QueryClient uses no-op managers on the server
 * (when `typeof window === 'undefined'`) to prevent timer leaks.
 *
 * Note: In the Node test environment, `typeof window === 'undefined'` is true,
 * so the SSR path is the default.
 */

describe('SSR Guard', () => {
  let client: QueryClient;

  afterEach(() => {
    client?.destroy();
  });

  it('should use NoOpGcManager on the server by default', () => {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const mockFetch = createMockFetch();
    client = new QueryClient({
      store: store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    });

    expect(client.isServer).toBe(true);
    expect(client.gcManager).toBeInstanceOf(NoOpGcManager);
  });

  it('should allow overriding gc manager even on the server', () => {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const mockFetch = createMockFetch();
    const customGc = new NoOpGcManager();

    client = new QueryClient({
      store: store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
      networkManager: undefined,
      gcManager: customGc,
    });

    expect(client.gcManager).toBe(customGc);
  });

  it('should accept NoOpNetworkManager without a cast', () => {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const mockFetch = createMockFetch();
    const noOpNetwork = new NoOpNetworkManager();

    client = new QueryClient({
      store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
      networkManager: noOpNetwork,
    });

    expect(client.networkManager).toBe(noOpNetwork);
    expect(client.networkManager.getOnlineSignal().value).toBe(true);
    expect(() => client.destroy()).not.toThrow();
  });

  it('should call destroy() safely without subscription manager', () => {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const mockFetch = createMockFetch();
    client = new QueryClient({
      store: store,
      adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    });

    expect(() => client.destroy()).not.toThrow();
  });
});
