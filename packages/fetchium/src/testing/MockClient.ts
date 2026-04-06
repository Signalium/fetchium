import { QueryClient, QueryClientContext } from '../QueryClient.js';
import { SyncQueryStore, MemoryPersistentStore } from '../stores/sync.js';
import { NetworkManager } from '../NetworkManager.js';
import { NoOpGcManager } from '../GcManager.js';
import { RESTQueryController } from '../rest/RESTQueryController.js';
import { Query } from '../query.js';
import { Mutation } from '../mutation.js';
import type { Entity } from '../proxy.js';
import { ValidatorDef } from '../typeDefs.js';
import { extractDefinition, reifyValue } from '../fieldRef.js';
import type { MockFetchCall, EntityGenerators, ResponseTransform } from './types.js';
import { GeneratorContext, generateEntityData, generateQueryResponse } from './auto-generate.js';
import type { InternalTypeDef, InternalObjectShape } from '../types.js';

// ================================
// Mock route types
// ================================

interface MockRoute {
  method: string;
  url: string;
  responses: MockRouteResponse[];
  currentIndex: number;
}

interface MockRouteResponse {
  data?: unknown;
  status: number;
  headers: Record<string, string>;
  delay: number;
  error?: Error;
  networkError?: string;
}

// ================================
// MockQueryBuilder
// ================================

export class MockQueryBuilder<T extends Query | Mutation = Query> {
  private route: MockRoute;
  private mockClient: MockClient;

  constructor(mockClient: MockClient, method: string, url: string) {
    this.mockClient = mockClient;
    this.route = { method, url, responses: [], currentIndex: 0 };
  }

  respond(data: unknown): this {
    this.route.responses.push({
      data: JSON.parse(JSON.stringify(data)),
      status: 200,
      headers: {},
      delay: 0,
    });
    this.mockClient._registerRoute(this.route);
    return this;
  }

  thenRespond(data: unknown): this {
    this.route.responses.push({
      data: JSON.parse(JSON.stringify(data)),
      status: 200,
      headers: {},
      delay: 0,
    });
    return this;
  }

  auto(overrides?: Record<string, unknown>): this {
    const queryClass = this.mockClient._getQueryClassForRoute(this.route);
    if (!queryClass) {
      throw new Error('Cannot auto-generate: no query class associated with this route');
    }

    const resultDef = getResultDef(queryClass);
    const data = generateQueryResponse(resultDef, this.mockClient._generatorCtx, overrides);

    this.route.responses.push({
      data: JSON.parse(JSON.stringify(data)),
      status: 200,
      headers: {},
      delay: 0,
    });
    this.mockClient._registerRoute(this.route);
    return this;
  }

  error(status: number = 500, body?: unknown): this {
    this.route.responses.push({
      data: body ?? { error: `Error ${status}` },
      status,
      headers: {},
      delay: 0,
    });
    this.mockClient._registerRoute(this.route);
    return this;
  }

  networkError(message: string = 'Network error'): this {
    this.route.responses.push({
      status: 0,
      headers: {},
      delay: 0,
      networkError: message,
    });
    this.mockClient._registerRoute(this.route);
    return this;
  }

  raw(data: unknown): this {
    this.route.responses.push({
      data,
      status: 200,
      headers: {},
      delay: 0,
    });
    this.mockClient._registerRoute(this.route);
    return this;
  }

  delay(ms: number): this {
    this._pendingDelay = ms;
    return this;
  }

  private _pendingDelay = 0;

  private applyPendingDelay(): void {
    if (this._pendingDelay > 0 && this.route.responses.length > 0) {
      this.route.responses[this.route.responses.length - 1].delay = this._pendingDelay;
      this._pendingDelay = 0;
    }
  }
}

// ================================
// Helpers
// ================================

function getResultDef(queryClass: new () => Query | Mutation): InternalTypeDef | InternalObjectShape {
  const instance = new queryClass();
  const captured = extractDefinition(instance);
  const resultDef = (captured.fields as unknown as Record<string, unknown>).result;

  if (resultDef instanceof ValidatorDef) {
    return resultDef as unknown as InternalTypeDef;
  }

  return resultDef as InternalObjectShape;
}

function resolveQueryUrl(
  queryClass: new () => Query | Mutation,
  params?: Record<string, unknown>,
): { method: string; url: string } {
  const instance = new queryClass();
  const captured = extractDefinition(instance);
  const fields = captured.fields as unknown as Record<string, unknown>;

  const method = ((fields.method as string) ?? 'GET').toUpperCase();
  let path = fields.path as string | undefined;

  if (path && params) {
    path = reifyValue(path, { params }) as string;
  }

  return { method, url: path ?? '' };
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  const urlBase = url.split('?')[0];
  const patternBase = pattern.split('?')[0];

  if (urlBase === patternBase) return true;

  const urlParts = urlBase.split('/');
  const patternParts = patternBase.split('/');

  if (urlParts.length !== patternParts.length) return false;

  return patternParts.every((part, i) => {
    if (part.startsWith('[') && part.endsWith(']')) return true;
    return part === urlParts[i];
  });
}

// ================================
// MockClient
// ================================

export class MockClient {
  private _client: QueryClient;
  private routes: MockRoute[] = [];
  private _calls: MockFetchCall[] = [];
  private queryClassMap = new Map<MockRoute, new () => Query | Mutation>();
  private _responseTransforms: Map<string, ResponseTransform> = new Map();

  /** @internal */
  _generatorCtx = new GeneratorContext();

  constructor() {
    const store = new SyncQueryStore(new MemoryPersistentStore());
    const networkManager = new NetworkManager(true);
    this._client = new QueryClient({
      store,
      log: console,
      controllers: [new RESTQueryController({ fetch: this._mockFetch.bind(this) as any, baseUrl: 'http://localhost' })],
      networkManager,
      gcManager: new NoOpGcManager(),
    });
  }

  get client(): QueryClient {
    return this._client;
  }

  get calls(): readonly MockFetchCall[] {
    return this._calls;
  }

  // ============================
  // Mock setup
  // ============================

  when<T extends Query>(
    queryClass: new () => T,
    params?: Record<string, unknown>,
  ): MockQueryBuilder<T> {
    const { method, url } = resolveQueryUrl(queryClass, params);
    const builder = new MockQueryBuilder<T>(this, method, url);
    this.queryClassMap.set((builder as any).route, queryClass);
    return builder;
  }

  // ============================
  // Entity generation
  // ============================

  entity<T extends Entity>(
    cls: new () => T,
    overrides?: Record<string, unknown>,
  ): Record<string, unknown> {
    return generateEntityData(cls, overrides, this._generatorCtx);
  }

  define<T extends Entity>(cls: new () => T, generators: EntityGenerators<T>): void {
    this._generatorCtx.registerFactory(cls, generators as Record<string, unknown>);
  }

  // ============================
  // Request inspection
  // ============================

  wasCalled(queryClass: new () => Query | Mutation, params?: Record<string, unknown>): boolean {
    const { method, url } = resolveQueryUrl(queryClass, params);
    return this._calls.some(
      call => call.method === method && (params ? call.url === url : urlMatchesPattern(call.url, url)),
    );
  }

  lastCall(queryClass: new () => Query | Mutation): MockFetchCall | undefined {
    const { method, url } = resolveQueryUrl(queryClass);
    for (let i = this._calls.length - 1; i >= 0; i--) {
      const call = this._calls[i];
      if (call.method === method && urlMatchesPattern(call.url, url)) {
        return call;
      }
    }
    return undefined;
  }

  // ============================
  // Response transforms (used by .vary())
  // ============================

  _setResponseTransform(key: string, transform: ResponseTransform): void {
    this._responseTransforms.set(key, transform);
  }

  _clearResponseTransform(key: string): void {
    this._responseTransforms.delete(key);
  }

  _clearAllResponseTransforms(): void {
    this._responseTransforms.clear();
  }

  // ============================
  // Lifecycle
  // ============================

  reset(): void {
    this.routes = [];
    this._calls = [];
    this.queryClassMap.clear();
    this._responseTransforms.clear();
    this._generatorCtx.reset();
  }

  destroy(): void {
    this._client.destroy();
    this.reset();
  }

  // ============================
  // Internal route management
  // ============================

  /** @internal */
  _registerRoute(route: MockRoute): void {
    const existingIdx = this.routes.findIndex(
      r => r.method === route.method && r.url === route.url,
    );
    if (existingIdx >= 0) {
      this.routes[existingIdx] = route;
    } else {
      this.routes.push(route);
    }
  }

  /** @internal */
  _getQueryClassForRoute(route: MockRoute): (new () => Query | Mutation) | undefined {
    return this.queryClassMap.get(route);
  }

  // ============================
  // Mock fetch implementation
  // ============================

  private async _mockFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();

    let body: unknown;
    if (init.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    }

    this._calls.push({ url, method, body, options: init });

    const route = this._findRoute(url, method);
    if (!route) {
      throw new Error(
        `[MockClient] No mock response for ${method} ${url}\n` +
          `Registered routes:\n${this.routes.map(r => `  ${r.method} ${r.url}`).join('\n')}`,
      );
    }

    const responseIdx = Math.min(route.currentIndex, route.responses.length - 1);
    const routeResponse = route.responses[responseIdx];
    if (route.currentIndex < route.responses.length - 1) {
      route.currentIndex++;
    }

    if (routeResponse.delay > 0) {
      await new Promise(resolve => setTimeout(resolve, routeResponse.delay));
    }

    if (routeResponse.networkError) {
      throw new Error(routeResponse.networkError);
    }

    if (routeResponse.error) {
      throw routeResponse.error;
    }

    let responseData = routeResponse.data;

    for (const transform of this._responseTransforms.values()) {
      responseData = transform(responseData);
    }

    const status = routeResponse.status;

    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : status === 201 ? 'Created' : 'Error',
      headers: new Headers(routeResponse.headers),
      json: async () => {
        return responseData !== undefined ? JSON.parse(JSON.stringify(responseData)) : undefined;
      },
      text: async () => JSON.stringify(responseData),
      clone() {
        return this;
      },
    } as Response;
  }

  private _findRoute(url: string, method: string): MockRoute | undefined {
    const urlBase = url.split('?')[0];

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.url === urlBase) return route;
    }

    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (urlMatchesPattern(urlBase, route.url)) return route;
    }

    return undefined;
  }
}
