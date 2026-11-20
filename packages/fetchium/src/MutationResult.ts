import { task, type ReactiveTask } from 'signalium';
import { ComplexTypeDef, MutationEffects, EntityClassOrTypename, type MutationEvent } from './types.js';
import type { OptimisticUndo } from './optimistic.js';
import { ValidatorDef, getEntityDef } from './typeDefs.js';
import { type QueryClient } from './QueryClient.js';
import { MutationDefinition, type Mutation } from './mutation.js';
import { resolveRetryConfig } from './query.js';
import { parseMutationResponse, type ParsedMutationResponse } from './parseEntities.js';
import { createExecutionContext, reifyValue } from './fieldRef.js';
import { Entity } from './proxy.js';
import { getFailedResponseStatus, withRetry } from './retry.js';

/**
 * Internal mutation manager. Consumers interact with the public `task` property,
 * which is a standard ReactiveTask whose resolved value is the validated response.
 *
 * Mutations use Phase 1 only (parseData) for response validation. Entity store
 * updates are handled exclusively through effects (creates/updates/deletes).
 */
export class MutationResultImpl<Request, Result> {
  def: MutationDefinition<Request, Result>;
  private queryClient: QueryClient;
  private _inFlight: boolean = false;

  readonly task: ReactiveTask<Result, [Request]>;

  constructor(def: MutationDefinition<Request, Result>, queryClient: QueryClient) {
    this.def = def;
    this.queryClient = queryClient;
    this.task = this.createTask();
    if (def.optimisticUpdates && def.optimisticEffects === undefined) {
      queryClient
        .getContext()
        .log?.warn?.(
          `Mutation "${def.id}" sets optimisticUpdates, but none of its effects can be applied before the response: ` +
            'only `effects` entries that read just `params` are applied optimistically, and `getEffects()` never is.',
        );
    }
  }

  private createTask(): ReactiveTask<Result, [Request]> {
    return task(
      async (request: Request): Promise<Result> => {
        if (!this.def.optimisticUpdates) {
          if (this._inFlight) {
            throw new Error('A mutation is already in progress. Await the previous call before starting a new one.');
          }
          this._inFlight = true;
          try {
            const response = await this.executeWithRetry(request);

            const parsed = this.validateResponse(response);

            this.processEffects(request, parsed.value, parsed.rawValues);

            return parsed.value;
          } finally {
            this._inFlight = false;
          }
        }

        // `run()` can be called from a reactive function that read these entities, which
        // must not be written during that synchronous run.
        await undefined;
        const layers = this.queryClient.optimisticLayers;
        const owner = {};
        const undos = this.applyOptimisticEffects(owner, request);
        let parsed: ParsedMutationResponse<Result>;
        try {
          parsed = this.validateResponse(await this.executeWithRetry(request));
        } catch (e) {
          layers.rollback(owner, undos);
          throw e;
        }
        try {
          this.processEffects(request, parsed.value, parsed.rawValues, owner);
        } finally {
          layers.release(owner, undos);
        }
        return parsed.value;
      },
      { desc: `Mutation(${this.def.id})` },
    );
  }

  private applyOptimisticEffects(owner: object, request: Request): OptimisticUndo[] {
    const undos: OptimisticUndo[] = [];
    const declared = this.def.optimisticEffects;
    if (declared === undefined) return undos;
    const root = { params: request };
    const layers = this.queryClient.optimisticLayers;
    const apply = (entries: MutationEffects['creates'], type: 'create' | 'update' | 'delete') => {
      for (const [entityRef, data] of (reifyValue(entries, root) as MutationEffects['creates']) ?? []) {
        const typename = resolveTypename(entityRef);
        if (typename === undefined) continue;
        const undo = layers.apply(owner, { type, typename, data: data as Record<string, unknown> });
        if (undo !== undefined) undos.push(undo);
      }
    };
    apply(declared.creates, 'create');
    apply(declared.updates, 'update');
    apply(declared.deletes, 'delete');
    return undos;
  }

  private validateResponse(response: unknown): ParsedMutationResponse<Result> {
    const responseShape = this.def.responseShape;

    if (!(responseShape instanceof ValidatorDef)) {
      return { value: response as Result, rawValues: new WeakMap() };
    }

    const warn = this.queryClient.getContext().log?.warn ?? (() => {});
    return parseMutationResponse<Result>(response, responseShape as ComplexTypeDef, warn);
  }

  // ======================================================
  // Effects processing
  // ======================================================

  private processEffects(
    request: Request,
    parsedResult: Result,
    rawValues: WeakMap<object, unknown>,
    owner?: object,
  ): void {
    let effects: MutationEffects | undefined;

    if (this.def.hasGetEffects) {
      const ctx = createExecutionContext(
        this.def.captured,
        (request ?? {}) as Record<string, unknown>,
        this.queryClient.getContext(),
      );
      (ctx as any).result = parsedResult;
      effects = (ctx as any).getEffects();
    } else if (this.def.effects !== undefined) {
      const root = { params: request, result: rawValueFor(parsedResult, rawValues) };
      const declared = this.def.effects;
      effects = {
        creates: reifyValue(declared.creates, root),
        updates: reifyValue(declared.updates, root),
        deletes: reifyValue(declared.deletes, root),
        invalidates: reifyValue(declared.invalidates, { params: request, result: parsedResult }),
      } as MutationEffects;
    }

    if (effects === undefined) return;

    const qc = this.queryClient;
    applyEffects(effects.creates, 'create', qc, rawValues, owner);
    applyEffects(effects.updates, 'update', qc, rawValues, owner);
    applyEffects(effects.deletes, 'delete', qc, rawValues, owner);

    if (effects.invalidates) {
      qc.invalidateQueries(effects.invalidates);
    }
  }

  // ======================================================
  // Retry logic
  // ======================================================

  private executeWithRetry(request: Request): Promise<Result> {
    const retryConfig = resolveRetryConfig(this.def.config?.retry, true);
    const adapter = this.queryClient.getAdapter(this.def.adapterClass);

    if (!adapter.sendMutation) {
      throw new Error(
        `Adapter "${this.def.adapterClass.name}" does not implement sendMutation(). ` +
          `Add a sendMutation() method to handle mutations.`,
      );
    }

    let attemptCtx: Mutation | undefined;
    return withRetry(
      async () => {
        attemptCtx = undefined;
        const abortController = new AbortController();
        const ctx = createExecutionContext(
          this.def.captured,
          (request ?? {}) as Record<string, unknown>,
          this.queryClient.getContext(),
        );
        attemptCtx = ctx;

        return (await adapter.sendMutation!(ctx, abortController.signal)) as Result;
      },
      retryConfig,
      undefined,
      {
        shouldRetry: this.queryClient.shouldRetry,
        // Each attempt has a fresh ctx, so a response here is this attempt's.
        getAttemptStatus: () => getFailedResponseStatus((attemptCtx as { response?: unknown } | undefined)?.response),
      },
    );
  }
}

function resolveTypename(entityRef: EntityClassOrTypename): string | undefined {
  if (typeof entityRef === 'string') return entityRef;
  const def = getEntityDef(entityRef as new () => Entity);
  return def.typenameValue;
}

function rawValueFor(value: unknown, rawValues: WeakMap<object, unknown>): unknown {
  return typeof value === 'object' && value !== null && rawValues.has(value) ? rawValues.get(value) : value;
}

function applyEffects(
  entries: ReadonlyArray<readonly [EntityClassOrTypename, unknown]> | undefined,
  type: 'create' | 'update' | 'delete',
  qc: QueryClient,
  rawValues: WeakMap<object, unknown>,
  owner: object | undefined,
): void {
  if (!entries) return;
  for (const [entityRef, data] of entries) {
    const typename = resolveTypename(entityRef);
    if (typename !== undefined) {
      const event: MutationEvent = { type, typename, data: rawValueFor(data, rawValues) as Record<string, unknown> };
      qc.applyMutationEvent(owner === undefined ? event : qc.optimisticLayers.confirm(owner, event));
    }
  }
}
