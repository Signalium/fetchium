import { Mutation } from '../mutation.js';
import type { BaseUrlValue, QueryRequestOptions } from '../types.js';
import { RESTQueryAdapter } from './RESTQueryAdapter.js';

export abstract class RESTMutation extends Mutation {
  static override adapter = RESTQueryAdapter;

  path?: string;
  baseUrl?: BaseUrlValue;
  method: 'POST' | 'PUT' | 'DELETE' | 'PATCH' = 'POST';
  body?: Record<string, unknown>;
  headers?: HeadersInit;
  requestOptions?: QueryRequestOptions;

  getIdentityKey(): string {
    return `${this.method ?? 'POST'}:${this.path ?? ''}`;
  }

  getPath?(): string | undefined;
  getMethod?(): string;
  getBody?(): Record<string, unknown> | undefined;
  getRequestOptions?(): QueryRequestOptions | undefined;
}
