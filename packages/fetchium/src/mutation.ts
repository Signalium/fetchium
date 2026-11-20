import { getContext, ReactiveTask } from 'signalium';
import { ExtractType, InternalTypeDef, MutationEffects, TypeDef, RetryConfig, TypeDefShape } from './types.js';
import { QueryClientContext, type QueryContext } from './QueryClient.js';
import { ValidatorDef, t } from './typeDefs.js';
import {
  createDefinitionProxy,
  extractDefinition,
  getFieldRefPath,
  isFieldRef,
  type CapturedDefinition,
} from './fieldRef.js';
import type { QueryAdapter, QueryAdapterClass } from './QueryAdapter.js';

// ================================
// Mutation Definition Types
// ================================

export interface MutationConfigOptions {
  retry?: RetryConfig | number | false;
}

export interface MutationDefinition<Request, Response> {
  id: string;
  requestShape: InternalTypeDef;
  responseShape: InternalTypeDef | undefined;
  captured: CapturedDefinition<Mutation>;
  optimisticUpdates: boolean;
  /** The declared `creates`/`updates`/`deletes` that read only `params`. */
  optimisticEffects: MutationEffects | undefined;
  config?: MutationConfigOptions;
  effects?: MutationEffects;
  hasGetEffects: boolean;
  adapterClass: QueryAdapterClass;
}

// ================================
// Mutation base class
// ================================

export abstract class Mutation {
  static adapter?: QueryAdapterClass;

  readonly params?: TypeDefShape;
  readonly result?: TypeDefShape;
  readonly optimisticUpdates?: boolean;
  readonly config?: MutationConfigOptions;
  readonly effects?: Readonly<MutationEffects>;

  declare context: QueryContext;

  abstract getIdentityKey(): unknown;

  getEffects?(): MutationEffects;

  constructor() {
    return createDefinitionProxy(this);
  }
}

// ================================
// Mutation definition cache and lookup
// ================================

const mutationDefCache = new WeakMap<new () => Mutation, () => MutationDefinition<any, any>>();

export const mutationKeyForClass = (cls: new () => Mutation): string => {
  const getMutationDef = mutationDefCache.get(cls);

  if (getMutationDef === undefined) {
    throw new Error('Mutation definition not found');
  }

  return getMutationDef().id;
};

// ================================
// Internal: build mutation definition from class
// ================================

function buildMutationDefinition(MutationClass: new () => Mutation): () => MutationDefinition<any, any> {
  let cached = mutationDefCache.get(MutationClass);

  if (cached !== undefined) {
    return cached;
  }

  let mutationDefinition: MutationDefinition<any, any> | undefined;

  const getter = (): MutationDefinition<any, any> => {
    if (mutationDefinition !== undefined) {
      return mutationDefinition;
    }

    const instance = new MutationClass();
    const captured = extractDefinition(instance);
    const { fields } = captured;

    const id = `mutation:${String(captured.methods.getIdentityKey.call(fields))}`;

    const requestDef = fields.params ?? {};
    const requestShape = (requestDef instanceof ValidatorDef
      ? requestDef
      : t.object(requestDef)) as unknown as InternalTypeDef;
    const responseDef = fields.result;
    const responseShape =
      responseDef !== undefined
        ? ((responseDef instanceof ValidatorDef ? responseDef : t.object(responseDef)) as unknown as InternalTypeDef)
        : undefined;

    const adapterClass = (MutationClass as typeof Mutation).adapter;
    if (!adapterClass) {
      throw new Error(
        `Mutation class "${MutationClass.name}" must define a static \`adapter\` property. ` +
          `Extend RESTMutation (from fetchium/rest) or set \`static adapter = MyAdapter\` on your mutation class.`,
      );
    }

    const optimisticUpdates = fields.optimisticUpdates ?? false;
    const hasGetEffects = typeof captured.methods.getEffects === 'function';

    mutationDefinition = {
      id,
      requestShape,
      responseShape,
      captured,
      optimisticUpdates,
      optimisticEffects:
        optimisticUpdates && !hasGetEffects && fields.effects !== undefined
          ? paramsOnlyEffects(fields.effects)
          : undefined,
      config: fields.config,
      effects: fields.effects,
      hasGetEffects,
      adapterClass,
    };

    return mutationDefinition;
  };

  mutationDefCache.set(MutationClass, getter);
  return getter;
}

function paramsOnlyEffects(effects: MutationEffects): MutationEffects | undefined {
  const creates = effects.creates?.filter(([, data]) => !readsResult(data));
  const updates = effects.updates?.filter(([, data]) => !readsResult(data));
  const deletes = effects.deletes?.filter(([, data]) => !readsResult(data));
  if (!creates?.length && !updates?.length && !deletes?.length) return undefined;
  return { creates, updates, deletes };
}

function readsResult(value: unknown): boolean {
  if (isFieldRef(value)) return getFieldRefPath(value)[0] === 'result';
  if (typeof value === 'string') return /\[result[.\]]/.test(value);
  if (Array.isArray(value)) return value.some(readsResult);
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.values(value).some(readsResult);
  }
  return false;
}

// ================================
// Public API
// ================================

export function getMutation<T extends Mutation>(
  MutationClass: new () => T,
): ReactiveTask<Readonly<ExtractType<T['result']>>, [ExtractType<T['params']>]> {
  const getMutationDef = buildMutationDefinition(MutationClass);

  const queryClient = getContext(QueryClientContext);

  if (queryClient === undefined) {
    throw new Error('QueryClient not found');
  }

  return queryClient.getMutation<any, any>(getMutationDef());
}
