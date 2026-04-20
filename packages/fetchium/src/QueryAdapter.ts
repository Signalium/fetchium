import { type QueryContext } from './query-types.js';
import type { Query } from './query.js';
import type { Mutation } from './mutation.js';

// ================================
// IQueryClient — minimal interface QueryAdapter needs from the client
// (avoids circular import: QueryClient → QueryAdapter → QueryClient)
// ================================

export interface IQueryClientForAdapter {
  getContext(): QueryContext;
  applyMutationEvent(event: import('./types.js').MutationEvent): void;
}

// ================================
// QueryAdapterClass — constructor reference for an adapter class
// ================================

/**
 * A reference to an adapter class (abstract or concrete) with any constructor
 * signature. Used as the type of `static adapter` properties on Query/Mutation
 * classes, so that subclasses with required constructor arguments can be
 * assigned directly without casts.
 *
 * The framework never instantiates these classes via this type (adapters are
 * registered as pre-built instances on the QueryClient); it only uses the
 * reference as a map key and for prototype/name introspection.
 */
export type QueryAdapterClass<T extends QueryAdapter = QueryAdapter> = abstract new (...args: any[]) => T;

// ================================
// QueryAdapter base class
// ================================

export abstract class QueryAdapter {
  protected queryClient: IQueryClientForAdapter | undefined;

  /**
   * Called once by QueryClient when this adapter is registered.
   * Subclasses can override to do setup (e.g. open a WebSocket connection).
   */
  register(queryClient: IQueryClientForAdapter): void {
    this.queryClient = queryClient;
  }

  /**
   * Called when the network comes online or goes offline.
   * Subclasses can override to reconnect persistent connections (e.g. WebSocket).
   */
  onNetworkStatusChange?(isOnline: boolean): void;

  /**
   * Called when the QueryClient is destroyed.
   * Subclasses can override to clean up connections or timers.
   */
  destroy?(): void;

  /**
   * Send the query and return the raw response data.
   * @param ctx  The query execution context (a reified Query instance with params applied).
   * @param signal  AbortSignal to cancel the in-flight request.
   */
  abstract send(ctx: Query, signal: AbortSignal): Promise<unknown>;

  /**
   * Fetch the next page of results. Only implement if the adapter supports pagination.
   * @param ctx  The query execution context. `ctx.resultData` contains the current page's data.
   * @param signal  AbortSignal to cancel the in-flight request.
   */
  sendNext?(ctx: Query, signal: AbortSignal): Promise<unknown>;

  /**
   * Return true if more pages are available for the current result.
   * Called reactively — do not perform async work here.
   */
  hasNext?(ctx: Query): boolean;

  /**
   * Send a mutation and return the raw response data.
   * @param ctx  The mutation execution context (a reified Mutation instance with params applied).
   * @param signal  AbortSignal to cancel the in-flight request.
   */
  sendMutation?(ctx: Mutation, signal: AbortSignal): Promise<unknown>;
}
