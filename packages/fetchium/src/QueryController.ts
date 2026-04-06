import { type QueryContext } from './query-types.js';
import type { Query } from './query.js';
import type { Mutation } from './mutation.js';

// ================================
// IQueryClient — minimal interface QueryController needs from the client
// (avoids circular import: QueryClient → QueryController → QueryClient)
// ================================

export interface IQueryClientForController {
  getContext(): QueryContext;
}

// ================================
// QueryController base class
// ================================

export abstract class QueryController {
  protected queryClient: IQueryClientForController | undefined;

  /**
   * Called once by QueryClient when this controller is registered.
   * Subclasses can override to do setup (e.g. open a WebSocket connection).
   */
  register(queryClient: IQueryClientForController): void {
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
   * Fetch the next page of results. Only implement if the controller supports pagination.
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
