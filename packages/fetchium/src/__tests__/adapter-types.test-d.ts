// Compile-time type tests for the `static adapter` property. These are
// validated by `tsc --noEmit` (via `check-types`). Vitest's test glob is
// `*.test.ts`, so `.test-d.ts` files are not executed at runtime.

import { QueryAdapter, type QueryAdapterClass } from '../QueryAdapter.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';

// --- Fixtures ---------------------------------------------------------------

class NoArgAdapter extends QueryAdapter {
  async send(): Promise<unknown> {
    return undefined;
  }
}

class RequiredArgAdapter extends QueryAdapter {
  constructor(public readonly ws: WebSocket) {
    super();
  }
  async send(): Promise<unknown> {
    return undefined;
  }
}

class NoArgTopicAdapter extends TopicQueryAdapter {
  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
}

class RequiredArgTopicAdapter extends TopicQueryAdapter {
  constructor(
    public readonly ws: WebSocket,
    public readonly ns: string,
  ) {
    super();
  }
  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
}

class NotAnAdapter {}

// --- QueryAdapterClass (base): accepts any QueryAdapter subclass, --------
// --- regardless of constructor signature ---------------------------------

const _qOk1: QueryAdapterClass = NoArgAdapter;
const _qOk2: QueryAdapterClass = RequiredArgAdapter;
// Topic adapters are also QueryAdapters, so they pass the base constraint.
const _qOk3: QueryAdapterClass = RequiredArgTopicAdapter;

// @ts-expect-error — NotAnAdapter does not extend QueryAdapter
const _qBad1: QueryAdapterClass = NotAnAdapter;
// @ts-expect-error — plain object is not a constructor
const _qBad2: QueryAdapterClass = {};
// @ts-expect-error — function is not a constructor
const _qBad3: QueryAdapterClass = () => undefined;

// --- QueryAdapterClass<TopicQueryAdapter>: constrained to ---------------
// --- TopicQueryAdapter subclasses ---------------------------------------

// The bug this PR fixes: concrete TopicQueryAdapter subclass with required
// constructor args must be assignable without a cast.
const _tOk1: QueryAdapterClass<TopicQueryAdapter> = RequiredArgTopicAdapter;
const _tOk2: QueryAdapterClass<TopicQueryAdapter> = NoArgTopicAdapter;

// @ts-expect-error — RESTQueryAdapter is a QueryAdapter but not a TopicQueryAdapter
const _tBad1: QueryAdapterClass<TopicQueryAdapter> = RESTQueryAdapter;
// @ts-expect-error — NoArgAdapter is a QueryAdapter but not a TopicQueryAdapter
const _tBad2: QueryAdapterClass<TopicQueryAdapter> = NoArgAdapter;
// @ts-expect-error — NotAnAdapter does not extend TopicQueryAdapter
const _tBad3: QueryAdapterClass<TopicQueryAdapter> = NotAnAdapter;

// --- TopicQuery.adapter field: the end-to-end positive case -------------

// This class compiles iff `static override adapter` accepts a concrete
// adapter with required constructor args. Failing to compile here means
// the PR regressed.
abstract class _PositiveCase extends TopicQuery {
  static override adapter = RequiredArgTopicAdapter;
}

export type _AdapterTypeTests =
  | typeof _qOk1
  | typeof _qOk2
  | typeof _qOk3
  | typeof _qBad1
  | typeof _qBad2
  | typeof _qBad3
  | typeof _tOk1
  | typeof _tOk2
  | typeof _tBad1
  | typeof _tBad2
  | typeof _tBad3
  | typeof _PositiveCase;
