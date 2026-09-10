import { describe, it, expect } from 'vitest';
import { sameValue, sameRefs } from '../applyEntities.js';
import { FormattedValue } from '../typeDefs.js';
import { PROXY_ID } from '../proxyId.js';
import type { EntityInstance } from '../EntityInstance.js';

/**
 * `sameValue` decides whether an apply notifies consumers and writes to the
 * store, so a wrong `true` is a dropped update. Every branch answers `false`
 * for anything it cannot compare confidently; these pin that direction.
 */

const proxyLike = (key: number) => {
  const obj = {};
  PROXY_ID.set(obj, key);
  return obj;
};

describe('sameValue', () => {
  const equal: [string, unknown, unknown][] = [
    ['identical scalars', 1, 1],
    ['identical strings', 'a', 'a'],
    ['null and null', null, null],
    ['undefined and undefined', undefined, undefined],
    ['empty objects', {}, {}],
    ['flat objects, same keys and values', { a: 1, b: 'x' }, { a: 1, b: 'x' }],
    ['objects with keys in a different order', { a: 1, b: 2 }, { b: 2, a: 1 }],
    ['nested objects', { a: { b: { c: [1, 2] } } }, { a: { b: { c: [1, 2] } } }],
    ['empty arrays', [], []],
    ['arrays of scalars', [1, 'two', null], [1, 'two', null]],
    ['arrays of objects', [{ a: 1 }], [{ a: 1 }]],
  ];

  for (const [name, a, b] of equal) {
    it(`equal: ${name}`, () => {
      expect(sameValue(a, b)).toBe(true);
    });
  }

  it('reports the same entity proxy as unchanged', () => {
    const proxy = proxyLike(1);
    expect(sameValue(proxy, proxy)).toBe(true);
  });

  it('reports NaN as changed, since it is not equal to itself', () => {
    expect(sameValue(Number.NaN, Number.NaN)).toBe(false);
  });

  const different: [string, unknown, unknown][] = [
    ['different scalars', 1, 2],
    ['number vs string', 1, '1'],
    ['null vs object', null, {}],
    ['undefined vs null', undefined, null],
    ['array length mismatch', [1, 2], [1]],
    ['array element mismatch', [1, 2], [1, 3]],
    ['array vs object', [1], { 0: 1 }],
    ['key count mismatch', { a: 1 }, { a: 1, b: 2 }],
    ['same key count, different keys', { a: 1 }, { b: 1 }],
    ['nested difference', { a: { b: 1 } }, { a: { b: 2 } }],
    ['distinct entity proxies', proxyLike(10), proxyLike(11)],
    ['entity proxy vs plain object', proxyLike(12), {}],
    ['Date instances with the same time', new Date(0), new Date(0)],
    ['Map instances', new Map([['a', 1]]), new Map([['a', 1]])],
    ['Set instances', new Set([1]), new Set([1])],
    [
      'class instances with equal fields',
      new (class {
        x = 1;
      })(),
      new (class {
        x = 1;
      })(),
    ],
  ];

  for (const [name, a, b] of different) {
    it(`different: ${name}`, () => {
      expect(sameValue(a, b)).toBe(false);
    });
  }

  it('a key answered only by the prototype is not a match', () => {
    // `in` would find `constructor` on Object.prototype and compare it against
    // the left side's own `constructor`, reporting two different objects equal.
    expect(sameValue({ constructor: Object, x: 1 }, { x: 1, y: 2 })).toBe(false);
    expect(sameValue({ toString: 1, a: 2 }, { a: 2, b: 3 })).toBe(false);
  });

  it('compares formatted values by the raw input they were built from', () => {
    expect(sameValue(new FormattedValue('5', 0, false), new FormattedValue('5', 0, false))).toBe(true);
    expect(sameValue(new FormattedValue('5', 0, false), new FormattedValue('6', 0, false))).toBe(false);
    expect(sameValue(new FormattedValue('5', 0, false), '5')).toBe(false);
    expect(sameValue('5', new FormattedValue('5', 0, false))).toBe(false);
  });
});

describe('sameRefs', () => {
  const entity = (key: number) => ({ key }) as unknown as EntityInstance;
  const a = entity(1);
  const b = entity(2);

  it('treats undefined and an empty map as the same', () => {
    expect(sameRefs(undefined, undefined)).toBe(true);
    expect(sameRefs(new Map(), undefined)).toBe(true);
    expect(sameRefs(undefined, new Map())).toBe(true);
  });

  it('compares the key set', () => {
    expect(sameRefs(new Map([[a, 1]]), new Map([[a, 1]]))).toBe(true);
    expect(sameRefs(new Map([[a, 1]]), new Map([[b, 1]]))).toBe(false);
    expect(sameRefs(new Map([[a, 1]]), new Map())).toBe(false);
    expect(
      sameRefs(
        new Map([
          [a, 1],
          [b, 1],
        ]),
        new Map([[a, 1]]),
      ),
    ).toBe(false);
  });

  it('ignores ref counts, which the store does not persist', () => {
    // `EntityStore.save` writes a key set; `setChildRefs` acts on a key
    // appearing or disappearing. A count change writes identical bytes.
    expect(sameRefs(new Map([[a, 1]]), new Map([[a, 3]]))).toBe(true);
  });
});
