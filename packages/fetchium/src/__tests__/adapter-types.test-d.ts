// Compile-time type tests for the `static adapter` property on Query,
// Mutation, and TopicQuery. Validated by `tsc --noEmit` (via `check-types`).
// Vitest's test glob is `*.test.ts`, so `.test-d.ts` files are not executed
// at runtime.

import { t } from '../typeDefs.js';
import { Query } from '../query.js';
import { Mutation } from '../mutation.js';
import { QueryAdapter } from '../QueryAdapter.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';

// A realistic TopicQueryAdapter that requires construction arguments —
// the shape of a real-world wallet/chain/websocket adapter. Before this
// PR, assigning this to `static override adapter` required the cast
// `as unknown as typeof TopicQueryAdapter`.
class WebSocketTopicAdapter extends TopicQueryAdapter {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {
    super();
  }
  subscribe(_topic: string): void {}
  unsubscribe(_topic: string): void {}
}

// A plain QueryAdapter (not a TopicQueryAdapter) with a required
// constructor arg. Used as a positive fixture for Query / Mutation and
// as a negative fixture for TopicQuery.
class AuthenticatedAdapter extends QueryAdapter {
  constructor(private readonly token: string) {
    super();
  }
  async send(): Promise<unknown> {
    return undefined;
  }
}

class NotAnAdapter {}

// ============================================================
// TopicQuery.adapter — generic constraint to TopicQueryAdapter subclasses
// ============================================================

// Direct subclass — the standard pattern.
class GetPrices extends TopicQuery {
  static override adapter = WebSocketTopicAdapter;

  topic = 'prices:live';
  result = {
    price: t.number,
    timestamp: t.number,
  };
}

// Shared abstract base — the pattern used in Fetchium's own test suite
// (MockTopicQuery) — must also compile without a cast.
abstract class WebSocketTopicQuery extends TopicQuery {
  static override adapter = WebSocketTopicAdapter;
}

// @ts-expect-error — RESTQueryAdapter is a QueryAdapter but not a TopicQueryAdapter
class BadRestAdapter extends TopicQuery {
  static override adapter = RESTQueryAdapter;

  topic = 'bad-rest';
  result = {};
}

// @ts-expect-error — AuthenticatedAdapter is a QueryAdapter but not a TopicQueryAdapter
class BadSiblingAdapter extends TopicQuery {
  static override adapter = AuthenticatedAdapter;

  topic = 'bad-sibling';
  result = {};
}

// @ts-expect-error — NotAnAdapter does not extend TopicQueryAdapter
class BadRandomClass extends TopicQuery {
  static override adapter = NotAnAdapter;

  topic = 'bad-random';
  result = {};
}

// ============================================================
// Query.adapter — accepts any QueryAdapter subclass, rejects non-adapters
// ============================================================

class FetchUser extends Query {
  static override adapter = AuthenticatedAdapter;

  params = { userId: t.string };
  result = {
    id: t.string,
    name: t.string,
  };

  getIdentityKey() {
    return 'fetch-user';
  }
}

// @ts-expect-error — NotAnAdapter does not extend QueryAdapter
class BadQuery extends Query {
  static override adapter = NotAnAdapter;

  result = {};

  getIdentityKey() {
    return 'bad-query';
  }
}

// ============================================================
// Mutation.adapter — shares the same type as Query.adapter, so a single
// positive case is sufficient. (The Query negative above already pins
// the shared base constraint.)
// ============================================================

class UpdateUser extends Mutation {
  static override adapter = AuthenticatedAdapter;

  params = { userId: t.string, name: t.string };

  getIdentityKey() {
    return 'update-user';
  }
}

// Prevent "declared but unused" diagnostics for the fixtures above.
export type _AdapterTypeTests =
  | typeof GetPrices
  | typeof WebSocketTopicQuery
  | typeof BadRestAdapter
  | typeof BadSiblingAdapter
  | typeof BadRandomClass
  | typeof FetchUser
  | typeof BadQuery
  | typeof UpdateUser;
