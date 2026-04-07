import { Query } from '../query.js';
import { RESTQueryAdapter } from './RESTQueryAdapter.js';
import type { FetchNextConfig } from '../query-types.js';
import type { BaseUrlValue, QueryRequestOptions } from '../types.js';

// ================================
// RESTQuery — declarative HTTP query definition
// ================================

export abstract class RESTQuery extends Query {
  static override adapter = RESTQueryAdapter;

  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'GET';
  path?: string;
  baseUrl?: BaseUrlValue;
  searchParams?: Record<string, unknown>;
  body?: Record<string, unknown>;
  headers?: HeadersInit;
  requestOptions?: QueryRequestOptions;
  fetchNext?: FetchNextConfig;

  declare response: Response | undefined;

  getIdentityKey(): string {
    return `${this.method ?? 'GET'}:${this.path ?? ''}`;
  }

  // User-overridable getters — the adapter reads these from the execution context
  getPath?(): string | undefined;
  getMethod?(): string;
  getSearchParams?(): Record<string, unknown> | undefined;
  getBody?(): Record<string, unknown> | undefined;
  getRequestOptions?(): QueryRequestOptions | undefined;
  getFetchNext?(): FetchNextConfig | undefined;
}
