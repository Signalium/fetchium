// Compile-time type tests for the `static adapter` property on TopicQuery.
// Validated by `tsc --noEmit` (via `check-types`). Vitest's test glob is
// `*.test.ts`, so `.test-d.ts` files are not executed at runtime.

import { t } from '../typeDefs.js';
import { QueryAdapter } from '../QueryAdapter.js';
import { TopicQuery } from '../topic/TopicQuery.js';
import { TopicQueryAdapter } from '../topic/TopicQueryAdapter.js';
import { RESTQueryAdapter } from '../rest/RESTQueryAdapter.js';

// A realistic concrete adapter that requires construction arguments —
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

// ============================================================
// Positive cases — realistic TopicQuery definitions compile cleanly
// ============================================================

class GetPrices extends TopicQuery {
  static override adapter = WebSocketTopicAdapter;

  topic = 'prices:live';
  result = {
    price: t.number,
    timestamp: t.number,
  };
}

class GetBalances extends TopicQuery {
  static override adapter = WebSocketTopicAdapter;

  params = { address: t.string };
  topic = 'balances';
  result = {
    balance: t.string,
  };
}

// A shared abstract base — the pattern used in the Fetchium test suite
// itself (MockTopicQuery) — must also compile without a cast.
abstract class WebSocketTopicQuery extends TopicQuery {
  static override adapter = WebSocketTopicAdapter;
}

class GetTrades extends WebSocketTopicQuery {
  topic = 'trades';
  result = {
    side: t.string,
    size: t.string,
  };
}

// ============================================================
// Negative cases — the generic constraint must still reject non-TopicQueryAdapter classes
// ============================================================

// RESTQueryAdapter extends QueryAdapter but not TopicQueryAdapter.
// @ts-expect-error — RESTQueryAdapter is not a TopicQueryAdapter
class BadRestAdapter extends TopicQuery {
  static override adapter = RESTQueryAdapter;

  topic = 'bad-rest';
  result = {};
}

// A sibling QueryAdapter that lives outside the TopicQueryAdapter family.
class CustomQueryAdapter extends QueryAdapter {
  async send(): Promise<unknown> {
    return undefined;
  }
}

// @ts-expect-error — CustomQueryAdapter does not extend TopicQueryAdapter
class BadCustomAdapter extends TopicQuery {
  static override adapter = CustomQueryAdapter;

  topic = 'bad-custom';
  result = {};
}

// A totally unrelated class.
class NotAnAdapter {}

// @ts-expect-error — NotAnAdapter does not extend TopicQueryAdapter
class BadRandomClass extends TopicQuery {
  static override adapter = NotAnAdapter;

  topic = 'bad-random';
  result = {};
}

// Prevent "declared but unused" diagnostics for the fixtures above.
export type _AdapterTypeTests =
  | typeof GetPrices
  | typeof GetBalances
  | typeof GetTrades
  | typeof BadRestAdapter
  | typeof BadCustomAdapter
  | typeof BadRandomClass;
