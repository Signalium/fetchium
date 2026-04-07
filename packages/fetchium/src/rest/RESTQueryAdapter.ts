import { QueryAdapter } from '../QueryAdapter.js';
import { resolveBaseUrl } from '../query-types.js';
import { reifyValue } from '../fieldRef.js';
import type { Query } from '../query.js';
import type { Mutation } from '../mutation.js';
import type { FetchNextConfig } from '../query-types.js';
import type { RESTQuery } from './RESTQuery.js';
import type { RESTMutation } from './RESTMutation.js';
import type { QueryRequestInit, BaseUrlValue, QueryRequestOptions } from '../types.js';

// ================================
// ResolvedFetchNext
// ================================

export interface ResolvedFetchNext {
  url?: string;
  searchParams?: Record<string, unknown>;
}

// ================================
// RESTQueryAdapter options
// ================================

export interface RESTQueryAdapterOptions {
  fetch?: (url: string, init?: QueryRequestInit) => Promise<Response>;
  baseUrl?: BaseUrlValue;
}

// ================================
// RESTQueryAdapter
// ================================

export class RESTQueryAdapter extends QueryAdapter {
  private readonly _fetch: (url: string, init?: QueryRequestInit) => Promise<Response>;
  private readonly _baseUrl: BaseUrlValue | undefined;

  constructor(options?: RESTQueryAdapterOptions) {
    super();
    this._fetch =
      options?.fetch ?? (globalThis.fetch as unknown as (url: string, init?: QueryRequestInit) => Promise<Response>);
    this._baseUrl = options?.baseUrl;
  }

  override async send(ctx: Query, signal: AbortSignal): Promise<unknown> {
    return this.executeRequest(ctx as RESTQuery, signal);
  }

  override async sendNext(ctx: Query, signal: AbortSignal): Promise<unknown> {
    const resolved = this.resolveFetchNext(ctx as RESTQuery);
    if (resolved === undefined) {
      throw new Error('fetchNext is not configured for this query');
    }
    return this.executeRequest(ctx as RESTQuery, signal, resolved);
  }

  override hasNext(ctx: Query): boolean {
    const resolved = this.resolveFetchNext(ctx as RESTQuery);
    if (resolved === undefined) return false;

    if (resolved.url !== undefined && resolved.url !== null) {
      return true;
    }

    if (resolved.searchParams !== undefined) {
      const keys = Object.keys(resolved.searchParams);
      if (keys.length === 0) return false;
      for (const key of keys) {
        if (resolved.searchParams[key] === undefined || resolved.searchParams[key] === null) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  private resolveFetchNext(ctx: RESTQuery): ResolvedFetchNext | undefined {
    const dynamicConfig = ctx.getFetchNext ? ctx.getFetchNext() : undefined;
    const fetchNextConfig: FetchNextConfig | undefined = dynamicConfig ?? ctx.rawFetchNext;
    if (fetchNextConfig === undefined) return undefined;

    const resolveRoot: Record<string, unknown> = {
      params: ctx.params ?? {},
      result: ctx.resultData,
    };

    return {
      url: fetchNextConfig.url !== undefined ? (reifyValue(fetchNextConfig.url, resolveRoot) as string) : undefined,
      searchParams:
        fetchNextConfig.searchParams !== undefined
          ? (reifyValue(fetchNextConfig.searchParams, resolveRoot) as Record<string, unknown>)
          : undefined,
    };
  }

  /**
   * Resolves a path to a full URL.
   *
   * - Absolute URLs (`https://...`, `//...`) are returned as-is.
   * - Root-relative paths (`/foo`) are prepended with the resolved baseUrl.
   *   The baseUrl priority is: per-query/mutation > adapter-level > `location.origin`.
   *   If none is available and the path is root-relative, an error is thrown.
   * - Other paths (e.g. `example.com/foo`) are returned as-is.
   */
  private buildUrl(path: string, ctxBaseUrl: BaseUrlValue | undefined): string {
    // Absolute URL — use as-is regardless of any configured baseUrl
    if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) {
      return path;
    }

    // Root-relative path — needs a base
    if (path.startsWith('/')) {
      const base = resolveBaseUrl(ctxBaseUrl) ?? resolveBaseUrl(this._baseUrl) ?? globalThis.location?.origin;

      if (!base) {
        throw new Error(
          `RESTQueryAdapter: cannot resolve URL for path "${path}". ` +
            `Set \`baseUrl\` on the query/mutation, pass it to \`new RESTQueryAdapter({ baseUrl })\`, ` +
            `or use an absolute URL.`,
        );
      }

      return `${base}${path}`;
    }

    // Relative path — use as-is
    return path;
  }

  private async executeRequest(
    ctx: RESTQuery,
    signal: AbortSignal,
    next?: { url?: string; searchParams?: Record<string, unknown> },
  ): Promise<unknown> {
    const path = next?.url ?? (ctx.getPath ? ctx.getPath() : ctx.path);
    const method = ctx.getMethod ? ctx.getMethod() : ctx.method;
    const baseSearchParams = ctx.getSearchParams ? ctx.getSearchParams() : ctx.searchParams;
    const searchParams = next?.searchParams ? { ...baseSearchParams, ...next.searchParams } : baseSearchParams;
    const body = ctx.getBody ? ctx.getBody() : ctx.body;
    const requestOptions = ctx.getRequestOptions ? ctx.getRequestOptions() : ctx.requestOptions;

    if (!path) {
      throw new Error('RESTQuery requires a path. Define `path` as a field or override `getPath()`.');
    }

    let url = path;

    if (searchParams) {
      const sp = new URLSearchParams();
      for (const key in searchParams) {
        const val = searchParams[key];
        if (val !== undefined && val !== null) {
          sp.append(key, String(val));
        }
      }
      const qs = sp.toString();
      if (qs) {
        url += '?' + qs;
      }
    }

    const ctxBaseUrl = requestOptions?.baseUrl ?? ctx.baseUrl;
    const fullUrl = this.buildUrl(url, ctxBaseUrl);

    const { baseUrl: _baseUrl, signal: _signal, ...fetchOptions } = requestOptions ?? ({} as Record<string, unknown>);

    const hasHeaders = body || ctx.headers;
    const headers: HeadersInit | undefined = hasHeaders
      ? {
          ...(body ? { 'Content-Type': 'application/json' } : undefined),
          ...(ctx.headers as Record<string, string>),
        }
      : undefined;

    const fetchResponse = await this._fetch(fullUrl, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      ...fetchOptions,
    });

    ctx.response = fetchResponse as unknown as Response;

    return fetchResponse.json();
  }

  override async sendMutation(ctx: Mutation, signal: AbortSignal): Promise<unknown> {
    const restCtx = ctx as RESTMutation;
    const path = restCtx.getPath ? restCtx.getPath() : restCtx.path;
    const method = restCtx.getMethod ? restCtx.getMethod() : restCtx.method;
    const body = restCtx.getBody ? restCtx.getBody() : restCtx.body;
    const requestOptions = restCtx.getRequestOptions ? restCtx.getRequestOptions() : restCtx.requestOptions;

    if (!path) {
      throw new Error('RESTMutation requires a path. Define `path` as a field or override `getPath()`.');
    }

    const ctxBaseUrl = (requestOptions as QueryRequestOptions | undefined)?.baseUrl ?? restCtx.baseUrl;
    const fullUrl = this.buildUrl(path, ctxBaseUrl);

    const { baseUrl: _baseUrl, signal: _signal, ...fetchOptions } = (requestOptions ?? {}) as Record<string, unknown>;

    const headers: HeadersInit = {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(restCtx.headers as Record<string, string>),
    };

    const fetchResponse = await this._fetch(fullUrl, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal,
      ...fetchOptions,
    });

    return fetchResponse.json();
  }
}
