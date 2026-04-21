import { beforeEach, afterEach } from 'vitest';
import { watchOnce, watcher, withContexts } from 'signalium';
import { QueryClient, QueryClientContext, QueryStore } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';
import { NetworkManager } from '../NetworkManager.js';
import type { NoOpNetworkManager } from '../NetworkManager.js';
import { GcManager } from '../GcManager.js';
import type { NoOpGcManager } from '../GcManager.js';
import { EntityStore } from '../EntityStore.js';
import type { EntityInstance } from '../EntityInstance.js';
import type { PreloadedEntityMap } from '../QueryClient.js';
import type { TypeDef, ComplexTypeDef, EntityDef } from '../types.js';
// Re-export watchOnce for convenience
export { watchOnce };

interface MockFetchOptions {
  status?: number;
  headers?: Record<string, string>;
  delay?: number;
  error?: Error;
  jsonError?: Error;
}

interface MockFetch {
  (url: string, options?: RequestInit): Promise<Response>;

  get(url: string, response: unknown, opts?: MockFetchOptions): void;
  post(url: string, response: unknown, opts?: MockFetchOptions): void;
  put(url: string, response: unknown, opts?: MockFetchOptions): void;
  delete(url: string, response: unknown, opts?: MockFetchOptions): void;
  patch(url: string, response: unknown, opts?: MockFetchOptions): void;

  reset(): void;
  calls: Array<{ url: string; options: RequestInit }>;
}

interface MockRoute {
  url: string;
  method: string;
  response: unknown;
  options: MockFetchOptions;
  used: boolean;
}

// ================================
// Test client factory
// ================================

export interface TestClientOptions {
  networkManager?: NetworkManager | NoOpNetworkManager;
  gcManager?: GcManager | NoOpGcManager;
  evictionMultiplier?: number;
  /** Extra config keys passed through to QueryContext (e.g. stream) */
  [key: string]: unknown;
}

export interface TestClient {
  client: QueryClient;
  mockFetch: ReturnType<typeof createMockFetch>;
  kv: MemoryPersistentStore;
  store: SyncQueryStore;
}

/**
 * Creates a QueryClient wired up with a mock fetch, in-memory store, and
 * RESTQueryAdapter configured for http://localhost.
 *
 * @example
 * const { client, mockFetch } = createTestClient();
 * mockFetch.get('/users', [...]);
 * await testWithClient(client, async () => { ... });
 * client.destroy();
 */
export function createTestClient(options: TestClientOptions = {}): TestClient {
  const { networkManager, gcManager, evictionMultiplier, ...rest } = options;
  const mockFetch = createMockFetch();
  const kv = new MemoryPersistentStore();
  const store = new SyncQueryStore(kv);
  const client = new QueryClient({
    store,
    adapters: [new RESTQueryAdapter({ fetch: mockFetch as any, baseUrl: 'http://localhost' })],
    networkManager,
    // When evictionMultiplier is provided, always use a real GcManager (overrides isServer check)
    gcManager: gcManager ?? (evictionMultiplier !== undefined ? undefined : undefined),
    evictionMultiplier,
    ...rest,
  } as any);
  // If evictionMultiplier was specified, ensure a real GcManager is active
  // (the QueryClient may have chosen NoOpGcManager if running in a non-browser env)
  if (evictionMultiplier !== undefined && !(client.gcManager instanceof GcManager)) {
    client.gcManager = new GcManager((client as any).handleEviction.bind(client), evictionMultiplier);
  }
  return { client, mockFetch, kv, store };
}

/**
 * Sets up a fresh TestClient before each test and destroys it after.
 * Returns a getter function that provides the current test client.
 *
 * @example
 * const getClient = setupTestClient();
 *
 * it('should fetch users', async () => {
 *   const { client, mockFetch } = getClient();
 *   mockFetch.get('/users', [...]);
 *   await testWithClient(client, async () => { ... });
 * });
 */
export function setupTestClient(options?: TestClientOptions | (() => TestClientOptions)): () => TestClient {
  let tc: TestClient;

  beforeEach(() => {
    const opts = typeof options === 'function' ? options() : options;
    tc = createTestClient(opts);
  });

  afterEach(() => {
    tc?.client?.destroy();
  });

  return () => tc;
}

/**
 * Creates a mock fetch function with a fluent API for setting up responses.
 *
 * @example
 * const fetch = createMockFetch();
 * fetch.get('/users/123', { id: 123, name: 'Alice' });
 * fetch.post('/users', { id: 456, name: 'Bob' }, { status: 201 });
 *
 * const response = await fetch('/users/123', { method: 'GET' });
 * const data = await response.json(); // { id: 123, name: 'Alice' }
 */
export function createMockFetch(): MockFetch {
  const routes: MockRoute[] = [];
  const calls: Array<{ url: string; options: RequestInit }> = [];

  /**
   * Extracts the comparable portion of a URL for matching.
   * - If both route and request are absolute URLs with the same origin, compare full paths.
   * - If route has an origin, compare full URL.
   * - Otherwise compare just the pathname.
   */
  const toComparable = (raw: string): { origin: string | null; path: string } => {
    // Strip query string
    const base = raw.split('?')[0];
    // Replace [param] patterns with a placeholder so URL() doesn't choke on brackets
    const sanitized = base.replace(/\[([^\]]*)\]/g, '__param__');
    try {
      const parsed = new URL(sanitized);
      return { origin: parsed.origin, path: parsed.pathname.replace(/__param__/g, '[...]') };
    } catch {
      return { origin: null, path: base };
    }
  };

  const matchRoute = (url: string, method: string): MockRoute | undefined => {
    const isMatch = (r: MockRoute): boolean => {
      if (r.method !== method) return false;

      const req = toComparable(url);
      const route = toComparable(r.url);

      // If route has an origin, require it to match the request origin
      if (route.origin !== null && req.origin !== null && route.origin !== req.origin) {
        return false;
      }

      const routePath = route.path;
      const urlPath = req.path;

      // Exact match on path
      if (urlPath === routePath) return true;

      // Pattern match: route contains [...] placeholders
      if (r.url.includes('[')) {
        const routeParts = routePath.split('/');
        const urlParts = urlPath.split('/');

        if (routeParts.length !== urlParts.length) return false;

        return routeParts.every((part, i) => {
          if (part.startsWith('[') && part.endsWith(']')) return true;
          return part === urlParts[i];
        });
      }

      return false;
    };

    // First try to find an unused match
    const unusedMatch = routes.find(r => !r.used && isMatch(r));
    if (unusedMatch) return unusedMatch;

    // If no unused matches, reuse the last matching route
    for (let i = routes.length - 1; i >= 0; i--) {
      if (isMatch(routes[i])) {
        return routes[i];
      }
    }

    return undefined;
  };

  const mockFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
    const method = (options.method || 'GET').toUpperCase();

    calls.push({ url, options });

    const route = matchRoute(url, method);

    if (!route) {
      throw new Error(
        `No mock response configured for ${method} ${url}\n` +
          `Available routes:\n${routes.map(r => `  ${r.method} ${r.url}`).join('\n')}`,
      );
    }

    route.used = true;

    if (route.options.delay) {
      await new Promise(resolve => setTimeout(resolve, route.options.delay));
    }

    if (route.options.error) {
      throw route.options.error;
    }

    const status = route.options.status ?? 200;
    const headers = route.options.headers ?? {};

    // Resolve response if it's a function
    const resolveResponse = async () => {
      if (typeof route.response === 'function') {
        return await route.response();
      }

      // Deep clone the response to avoid mutating the original object
      return JSON.parse(JSON.stringify(route.response));
    };

    // Create a mock Response object
    const response = {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : status === 204 ? 'No Content' : 'Error',
      headers: new Headers(headers),
      json: async () => {
        if (route.options.jsonError) {
          throw route.options.jsonError;
        }
        return await resolveResponse();
      },
      text: async () => JSON.stringify(await resolveResponse()),
      blob: async () => new Blob([JSON.stringify(await resolveResponse())]),
      arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(await resolveResponse())).buffer,
      clone: () => response,
    } as Response;

    return response;
  };

  const addRoute = (method: string, url: string, response: unknown, opts: MockFetchOptions = {}) => {
    routes.push({
      url,
      method: method.toUpperCase(),
      response,
      options: opts,
      used: false,
    });
  };

  mockFetch.get = (url: string, response: unknown, opts?: MockFetchOptions) => {
    addRoute('GET', url, response, opts);
  };

  mockFetch.post = (url: string, response: unknown, opts?: MockFetchOptions) => {
    addRoute('POST', url, response, opts);
  };

  mockFetch.put = (url: string, response: unknown, opts?: MockFetchOptions) => {
    addRoute('PUT', url, response, opts);
  };

  mockFetch.delete = (url: string, response: unknown, opts?: MockFetchOptions) => {
    addRoute('DELETE', url, response, opts);
  };

  mockFetch.patch = (url: string, response: unknown, opts?: MockFetchOptions) => {
    addRoute('PATCH', url, response, opts);
  };

  mockFetch.reset = () => {
    routes.length = 0;
    calls.length = 0;
  };

  mockFetch.calls = calls;

  return mockFetch as MockFetch;
}

/**
 * Creates a test watcher that tracks all values emitted by a reactive function.
 * Returns an object with the values array and an unsubscribe function.
 *
 * Note: This creates a continuous watcher. For one-time execution, use `watchOnce` instead.
 */
export function createTestWatcher<T>(fn: () => T): {
  values: T[];
  unsub: () => void;
} {
  const values: T[] = [];

  const w = watcher(() => {
    const value = fn();
    values.push(value);
  });

  const unsub = w.addListener(() => {});

  return { values, unsub };
}

/**
 * Test helper that combines query client context injection and automatic watcher cleanup.
 * Wraps the test in a watcher and awaits it, keeping relays active during the test.
 *
 * @example
 * await testWithClient(client, async () => {
 *   const relay = getItem({ id: '1' });
 *   await relay;
 *   expect(relay.value).toBeDefined();
 *   // Watcher is automatically cleaned up
 * });
 */
export async function testWithClient(client: QueryClient, fn: () => Promise<void>): Promise<void> {
  return withContexts([[QueryClientContext, client]], () => watchOnce(fn));
}

export const sleep = (ms: number = 0) =>
  new Promise(resolve => {
    setTimeout(() => {
      resolve(true);
    }, ms);
  });

export function getClientStore(client: QueryClient): QueryStore {
  return client.store;
}

export function getClientEntityMap(client: QueryClient): EntityStore {
  return client.entityMap;
}

/**
 * Test helper to get the size of the entity instance map.
 * EntityStore doesn't expose a size property, so we access the internal map.
 */
export function getEntityMapSize(client: QueryClient): number {
  const entityMap = getClientEntityMap(client);
  return entityMap['instances'].size;
}

export function parseEntities(
  value: unknown,
  typeDef: TypeDef | ComplexTypeDef,
  queryClient: QueryClient,
  entityRefs?: Map<EntityInstance, number>,
  preloadedEntities?: PreloadedEntityMap,
): unknown {
  const persist = preloadedEntities === undefined;
  const parsed = queryClient.parseData(value, typeDef as any, preloadedEntities);
  const result = queryClient.applyRefs(parsed, persist);

  if (entityRefs !== undefined) {
    for (const [inst, count] of result.entityRefs) {
      entityRefs.set(inst, count);
    }
  }

  return result.data;
}

export function parseEntity(
  obj: Record<string, unknown>,
  entityShape: EntityDef,
  queryClient: QueryClient,
  entityRefs?: Map<EntityInstance, number>,
): unknown {
  const parsed = queryClient.parseData(obj, entityShape as any);
  const result = queryClient.applyRefs(parsed, true);

  if (entityRefs !== undefined) {
    for (const [inst, count] of result.entityRefs) {
      entityRefs.set(inst, count);
    }
  }

  return result.data;
}

/**
 * Helper to send a stream update outside the reactive context.
 * This avoids "signal dirtied after consumed" errors.
 */
export async function sendStreamUpdate(callback: ((update: any) => void) | undefined, update: any): Promise<void> {
  if (callback === undefined) {
    throw new Error('Update is undefined');
  }

  await new Promise<void>(resolve => {
    setTimeout(() => {
      callback(update);
      resolve();
    }, 0);
  });
  // Give time for update to propagate
  await sleep(10);
}
