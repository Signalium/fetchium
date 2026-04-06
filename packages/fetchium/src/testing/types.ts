import type { Query } from '../query.js';
import type { Mutation } from '../mutation.js';
import type { Entity } from '../proxy.js';
import type { ExtractType, TypeDefShape } from '../types.js';

// ================================
// Type-safe dot-paths
// ================================

type Primitive = string | number | boolean | null | undefined | Date;

type DataKeys<T> = {
  [K in keyof T & string]: K extends `__${string}` ? never : T[K] extends (...args: any[]) => any ? never : K;
}[keyof T & string];

export type DotPaths<T, Depth extends unknown[] = []> = Depth['length'] extends 5
  ? never
  : T extends Primitive
    ? never
    : T extends (infer U)[]
      ? DotPaths<U, Depth>
      : T extends object
        ? {
            [K in DataKeys<T>]: K | `${K}.${DotPaths<NonNullable<T[K]>, [...Depth, unknown]>}`;
          }[DataKeys<T>]
        : never;

export type VaryableFields<T extends Query> = DotPaths<ExtractType<T['result']>>;

// ================================
// Mock response types
// ================================

export type MockQueryResponse<T extends Query> = T['result'] extends TypeDefShape
  ? RawResponseData<ExtractType<T['result']>>
  : unknown;

export type RawResponseData<T> = T extends Entity
  ? RawEntityData<T>
  : T extends (infer U)[]
    ? RawResponseData<U>[]
    : T extends object
      ? { [K in keyof T]?: RawResponseData<T[K]> }
      : T;

export type RawEntityData<T extends Entity> = {
  [K in keyof T as K extends `__${string}` ? K : K]?: T[K] extends Entity
    ? RawEntityData<T[K]>
    : T[K] extends Entity[]
      ? RawEntityData<T[K][number]>[]
      : T[K];
};

// ================================
// Entity factory types
// ================================

export type FieldGenerator<T = unknown> = (seq: number, fields: Record<string, unknown>) => T;

export type EntityGenerators<T extends Entity> = {
  [K in keyof T as K extends `__${string}` ? never : K]?: unknown | FieldGenerator;
};

// ================================
// Mock fetch types
// ================================

export interface MockFetchCall {
  url: string;
  method: string;
  body?: unknown;
  options: RequestInit;
}

export interface MockFetchOptions {
  status?: number;
  headers?: Record<string, string>;
  delay?: number;
  error?: Error;
}

// ================================
// Response transform
// ================================

export type ResponseTransform = (data: unknown) => unknown;
