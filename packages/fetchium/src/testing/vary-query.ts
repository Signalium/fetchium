import { VaryKnob, type VaryCase } from 'vitest-vary';
import { ValidatorDef } from '../typeDefs.js';
import { Mask, type InternalTypeDef, type InternalObjectShape } from '../types.js';
import { Query } from '../query.js';
import { extractDefinition } from '../fieldRef.js';
import { GeneratorContext } from './auto-generate.js';
import type { MockClient } from './MockClient.js';
import type { ResponseTransform } from './types.js';

// ================================
// Public API
// ================================

export interface QueryVaryConfig {
  eachOptional?: boolean | string[];
  arrayLengths?: number[] | Record<string, number[]>;
  combinations?: string[];
}

export interface QueryVaryState {
  removed?: string[];
  arrayLengths?: Record<string, number>;
}

export function varyQuery(
  mock: MockClient,
  query: new () => Query,
  config: QueryVaryConfig,
): VaryKnob<QueryVaryState> {
  const cases = generateCases(mock, query, config);
  return new VaryKnob(`query:${query.name}`, cases);
}

// ================================
// Schema introspection
// ================================

interface FieldInfo {
  path: string;
  isOptional: boolean;
  isArray: boolean;
  isEntity: boolean;
  isUnion: boolean;
  typeDef: InternalTypeDef;
}

function getQueryResultShape(queryClass: new () => Query): InternalTypeDef | InternalObjectShape {
  const instance = new queryClass();
  const captured = extractDefinition(instance);
  return (captured.fields as unknown as Record<string, unknown>).result as InternalTypeDef | InternalObjectShape;
}

function collectFields(
  typeDef: InternalTypeDef | InternalObjectShape,
  prefix: string,
  depth: number,
  out: FieldInfo[],
): void {
  if (depth > 5) return;

  if (typeDef instanceof ValidatorDef) {
    collectFieldsFromValidator(typeDef, prefix, depth, out);
    return;
  }

  if (typeof typeDef === 'object' && typeDef !== null && !(typeDef instanceof Set)) {
    for (const [key, fieldDef] of Object.entries(typeDef)) {
      if (key.startsWith('__')) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      collectFieldFromTypeDef(fieldDef as InternalTypeDef, path, depth, out);
    }
  }
}

function collectFieldFromTypeDef(
  typeDef: InternalTypeDef,
  path: string,
  depth: number,
  out: FieldInfo[],
): void {
  if (typeof typeDef === 'string') return;

  if (typeof typeDef === 'number') {
    const mask = typeDef as Mask;
    out.push({
      path,
      isOptional: (mask & (Mask.UNDEFINED | Mask.NULL)) !== 0,
      isArray: false,
      isEntity: false,
      isUnion: false,
      typeDef,
    });
    return;
  }

  if (typeDef instanceof Set) {
    out.push({ path, isOptional: false, isArray: false, isEntity: false, isUnion: false, typeDef });
    return;
  }

  if (typeDef instanceof ValidatorDef) {
    collectFieldsFromValidator(typeDef, path, depth, out);
  }
}

function collectFieldsFromValidator(
  def: ValidatorDef<any>,
  path: string,
  depth: number,
  out: FieldInfo[],
): void {
  const mask = def.mask;
  const isOptional = (mask & (Mask.UNDEFINED | Mask.NULL)) !== 0;

  if (mask & Mask.ENTITY) {
    out.push({ path, isOptional, isArray: false, isEntity: true, isUnion: false, typeDef: def as unknown as InternalTypeDef });
    const shape = def.shape as InternalObjectShape | undefined;
    if (shape && typeof shape === 'object') {
      for (const [key, fieldDef] of Object.entries(shape)) {
        if (key.startsWith('__') || typeof fieldDef === 'function') continue;
        collectFieldFromTypeDef(fieldDef as InternalTypeDef, path ? `${path}.${key}` : key, depth + 1, out);
      }
    }
    return;
  }

  if (mask & Mask.ARRAY) {
    out.push({ path, isOptional, isArray: true, isEntity: false, isUnion: false, typeDef: def as unknown as InternalTypeDef });
    const innerDef = def.shape as InternalTypeDef | undefined;
    if (innerDef && innerDef instanceof ValidatorDef && (innerDef.mask & Mask.ENTITY)) {
      collectFieldsFromValidator(innerDef, path, depth + 1, out);
    }
    return;
  }

  if (mask & Mask.OBJECT) {
    out.push({ path, isOptional, isArray: false, isEntity: false, isUnion: false, typeDef: def as unknown as InternalTypeDef });
    const shape = def.shape as InternalObjectShape | undefined;
    if (shape) {
      for (const [key, fieldDef] of Object.entries(shape)) {
        if (key.startsWith('__') || typeof fieldDef === 'function') continue;
        collectFieldFromTypeDef(fieldDef as InternalTypeDef, path ? `${path}.${key}` : key, depth + 1, out);
      }
    }
    return;
  }

  out.push({ path, isOptional, isArray: (mask & Mask.ARRAY) !== 0, isEntity: false, isUnion: (mask & Mask.UNION) !== 0, typeDef: def as unknown as InternalTypeDef });
}

// ================================
// Transform builders
// ================================

function removeFieldTransform(fieldPath: string): ResponseTransform {
  return (data: unknown) => {
    if (typeof data !== 'object' || data === null) return data;
    const cloned = JSON.parse(JSON.stringify(data));
    const parts = fieldPath.split('.');
    let current: any = cloned;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current == null) return cloned;
      if (Array.isArray(current)) {
        for (const item of current) deleteAtPath(item, parts.slice(i));
        return cloned;
      }
      current = current[parts[i]];
    }
    if (current != null) {
      if (Array.isArray(current)) {
        for (const item of current) delete item[parts[parts.length - 1]];
      } else {
        delete current[parts[parts.length - 1]];
      }
    }
    return cloned;
  };
}

function setArrayLengthTransform(fieldPath: string, length: number): ResponseTransform {
  return (data: unknown) => {
    if (typeof data !== 'object' || data === null) return data;
    const cloned = JSON.parse(JSON.stringify(data));
    const parts = fieldPath.split('.');
    let current: any = cloned;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current == null) return cloned;
      current = current[parts[i]];
    }
    const lastKey = parts[parts.length - 1];
    if (current != null && Array.isArray(current[lastKey])) {
      const arr = current[lastKey] as unknown[];
      if (length === 0) {
        current[lastKey] = [];
      } else if (length <= arr.length) {
        current[lastKey] = arr.slice(0, length);
      } else {
        const template = arr.length > 0 ? arr[0] : {};
        const extended = [...arr];
        for (let i = arr.length; i < length; i++) {
          extended.push(JSON.parse(JSON.stringify(template)));
        }
        current[lastKey] = extended;
      }
    }
    return cloned;
  };
}

function deleteAtPath(obj: any, path: string[]): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    if (current == null) return;
    current = current[path[i]];
  }
  if (current != null) delete current[path[path.length - 1]];
}

// ================================
// Case generation
// ================================

function generateCases(
  mock: MockClient,
  queryClass: new () => Query,
  config: QueryVaryConfig,
): VaryCase<QueryVaryState>[] {
  const resultShape = getQueryResultShape(queryClass);
  const allFields: FieldInfo[] = [];
  collectFields(resultShape, '', 0, allFields);
  const cases: VaryCase<QueryVaryState>[] = [];
  const queryName = queryClass.name;

  if (config.eachOptional) {
    const optionalFields = allFields.filter(f => f.isOptional);
    const selectedPaths = config.eachOptional === true
      ? optionalFields.map(f => f.path)
      : (config.eachOptional as string[]);

    for (const path of selectedPaths) {
      const field = optionalFields.find(f => f.path === path);
      if (!field) continue;
      const transform = removeFieldTransform(path);
      cases.push({
        id: `${queryName}:without-${path.replace(/\./g, '-')}`,
        label: `without ${path}`,
        state: { removed: [path] },
        apply: () => {
          const key = `vary_${queryName}_${path}`;
          mock._setResponseTransform(key, transform);
          return () => mock._clearResponseTransform(key);
        },
      });
    }
  }

  if (config.arrayLengths) {
    const arrayFields = allFields.filter(f => f.isArray);

    if (Array.isArray(config.arrayLengths)) {
      const lengths = config.arrayLengths as number[];
      for (const field of arrayFields) {
        for (const len of lengths) {
          const transform = setArrayLengthTransform(field.path, len);
          cases.push({
            id: `${queryName}:${field.path.replace(/\./g, '-')}=${len}`,
            label: `${field.path}: ${len} item${len === 1 ? '' : 's'}`,
            state: { arrayLengths: { [field.path]: len } },
            apply: () => {
              const key = `vary_${queryName}_${field.path}_${len}`;
              mock._setResponseTransform(key, transform);
              return () => mock._clearResponseTransform(key);
            },
          });
        }
      }
    } else {
      const map = config.arrayLengths as Record<string, number[]>;
      for (const [path, lengths] of Object.entries(map)) {
        for (const len of lengths) {
          const transform = setArrayLengthTransform(path, len);
          cases.push({
            id: `${queryName}:${path.replace(/\./g, '-')}=${len}`,
            label: `${path}: ${len} item${len === 1 ? '' : 's'}`,
            state: { arrayLengths: { [path]: len } },
            apply: () => {
              const key = `vary_${queryName}_${path}_${len}`;
              mock._setResponseTransform(key, transform);
              return () => mock._clearResponseTransform(key);
            },
          });
        }
      }
    }
  }

  if (config.combinations) {
    const paths = config.combinations;
    const relevantFields = paths
      .map(p => allFields.find(f => f.path === p))
      .filter((f): f is FieldInfo => f !== undefined);

    const axes: Array<{ states: VaryCase<QueryVaryState>[] }> = [];

    for (const field of relevantFields) {
      const states: VaryCase<QueryVaryState>[] = [];

      if (field.isOptional) {
        states.push({
          id: `${field.path}:present`,
          label: `${field.path}:present`,
          state: {},
          apply: () => {},
        });
        const transform = removeFieldTransform(field.path);
        states.push({
          id: `${field.path}:absent`,
          label: `${field.path}:absent`,
          state: { removed: [field.path] },
          apply: () => {
            const key = `vary_combo_${field.path}`;
            mock._setResponseTransform(key, transform);
            return () => mock._clearResponseTransform(key);
          },
        });
      } else if (field.isArray) {
        for (const [len, label] of [[0, 'empty'], [1, 'one'], [3, 'many']] as [number, string][]) {
          const transform = setArrayLengthTransform(field.path, len);
          states.push({
            id: `${field.path}:${label}`,
            label: `${field.path}:${label}`,
            state: { arrayLengths: { [field.path]: len } },
            apply: () => {
              const key = `vary_combo_${field.path}_${len}`;
              mock._setResponseTransform(key, transform);
              return () => mock._clearResponseTransform(key);
            },
          });
        }
      }

      if (states.length > 0) axes.push({ states });
    }

    let combos: VaryCase<QueryVaryState>[][] = [[]];
    for (const axis of axes) {
      const next: VaryCase<QueryVaryState>[][] = [];
      for (const existing of combos) {
        for (const state of axis.states) {
          next.push([...existing, state]);
        }
      }
      combos = next;
    }

    for (const combo of combos) {
      const id = combo.map(c => c.id).join(',');
      const label = combo.map(c => c.label).join(', ');
      const mergedState: QueryVaryState = {};
      for (const c of combo) {
        if (c.state.removed) {
          mergedState.removed = [...(mergedState.removed ?? []), ...c.state.removed];
        }
        if (c.state.arrayLengths) {
          mergedState.arrayLengths = { ...(mergedState.arrayLengths ?? {}), ...c.state.arrayLengths };
        }
      }
      cases.push({
        id: `${queryName}:${id}`,
        label,
        state: mergedState,
        apply: () => {
          const cleanups: Array<() => void> = [];
          for (const c of combo) {
            const cleanup = c.apply();
            if (typeof cleanup === 'function') cleanups.push(cleanup);
          }
          return () => { for (const fn of cleanups.reverse()) fn(); };
        },
      });
    }
  }

  return cases;
}
