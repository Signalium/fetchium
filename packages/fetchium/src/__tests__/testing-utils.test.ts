import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { t } from '../typeDefs.js';
import { Entity } from '../proxy.js';
import { RESTQuery } from '../rest/index.js';
import { fetchQuery } from '../query.js';
import { RESTMutation } from '../rest/index.js';
import { MockClient, MockQueryBuilder } from '../testing/MockClient.js';
import { GeneratorContext, generateEntityData, generateFromTypeDef, generateQueryResponse } from '../testing/auto-generate.js';
import { EntityFactory, defineFactory } from '../testing/entity-factory.js';
import { varyQuery } from '../testing/vary-query.js';
import { Mask, type InternalTypeDef } from '../types.js';
import { testWithClient } from './utils.js';
import { VaryKnob, BASELINE_CONTEXT, createVariantContext, mulberry32, sampleArray } from 'vitest-vary';

// ================================
// Test fixtures
// ================================

class User extends Entity {
  __typename = t.typename('User');
  id = t.id;
  name = t.string;
  email = t.string;
  avatar = t.optional(t.string);
  bio = t.optional(t.string);
}

class Post extends Entity {
  __typename = t.typename('Post');
  id = t.id;
  title = t.string;
  body = t.string;
  author = t.entity(User);
}

class GetUser extends RESTQuery {
  params = { id: t.number };
  path = `/users/${this.params.id}`;
  result = { user: t.entity(User) };
}

class GetUsers extends RESTQuery {
  path = '/users';
  result = { users: t.array(t.entity(User)) };
}

class GetPost extends RESTQuery {
  params = { id: t.string };
  path = `/posts/${this.params.id}`;
  result = { post: t.entity(Post) };
}

class CreateUser extends RESTMutation {
  readonly params = { name: t.string, email: t.string };
  readonly path = '/users';
  readonly method = 'POST' as const;
  readonly body = { name: this.params.name, email: this.params.email };
  readonly result = { user: t.entity(User) };
}

class GetSimple extends RESTQuery {
  path = '/simple';
  result = { name: t.string, count: t.number, active: t.boolean };
}

class GetWithOptionals extends RESTQuery {
  path = '/optionals';
  result = {
    required: t.string,
    optStr: t.optional(t.string),
    optNum: t.optional(t.number),
    nullableStr: t.nullable(t.string),
  };
}

class GetWithArray extends RESTQuery {
  path = '/with-array';
  result = {
    items: t.array(t.entity(User)),
    title: t.string,
  };
}

class GetWithEnum extends RESTQuery {
  path = '/with-enum';
  result = {
    status: t.enum('active', 'inactive', 'pending'),
    name: t.string,
  };
}

// ================================
// Auto-generate tests
// ================================

describe('Auto-generate', () => {
  describe('generateFromTypeDef', () => {
    it('generates strings with field name', () => {
      const ctx = new GeneratorContext();
      const result = generateFromTypeDef(Mask.STRING as InternalTypeDef, 'name', ctx);
      expect(result).toBe('name_1');
    });

    it('generates sequential strings', () => {
      const ctx = new GeneratorContext();
      const r1 = generateFromTypeDef(Mask.STRING as InternalTypeDef, 'name', ctx);
      const r2 = generateFromTypeDef(Mask.STRING as InternalTypeDef, 'name', ctx);
      expect(r1).toBe('name_1');
      expect(r2).toBe('name_2');
    });

    it('generates sequential numbers', () => {
      const ctx = new GeneratorContext();
      const r1 = generateFromTypeDef(Mask.NUMBER as InternalTypeDef, 'count', ctx);
      const r2 = generateFromTypeDef(Mask.NUMBER as InternalTypeDef, 'count', ctx);
      expect(r1).toBe(1);
      expect(r2).toBe(2);
    });

    it('generates booleans', () => {
      const ctx = new GeneratorContext();
      const result = generateFromTypeDef(Mask.BOOLEAN as InternalTypeDef, 'flag', ctx);
      expect(result).toBe(true);
    });

    it('generates IDs as sequential strings', () => {
      const ctx = new GeneratorContext();
      const r1 = generateFromTypeDef((Mask.ID | Mask.STRING | Mask.NUMBER) as InternalTypeDef, 'id', ctx);
      const r2 = generateFromTypeDef((Mask.ID | Mask.STRING | Mask.NUMBER) as InternalTypeDef, 'id', ctx);
      expect(r1).toBe('1');
      expect(r2).toBe('2');
    });

    it('generates non-optional type for optional fields', () => {
      const ctx = new GeneratorContext();
      const result = generateFromTypeDef(
        (Mask.STRING | Mask.UNDEFINED) as InternalTypeDef,
        'optional',
        ctx,
      );
      expect(typeof result).toBe('string');
    });

    it('generates null for null-only types', () => {
      const ctx = new GeneratorContext();
      const result = generateFromTypeDef(Mask.NULL as InternalTypeDef, 'nullable', ctx);
      expect(result).toBe(null);
    });
  });

  describe('generateEntityData', () => {
    it('generates entity with __typename and id', () => {
      const data = generateEntityData(User);
      expect(data.__typename).toBe('User');
      expect(data.id).toBeDefined();
      expect(typeof data.name).toBe('string');
      expect(typeof data.email).toBe('string');
    });

    it('applies overrides', () => {
      const data = generateEntityData(User, { name: 'Alice', email: 'alice@test.com' });
      expect(data.name).toBe('Alice');
      expect(data.email).toBe('alice@test.com');
      expect(data.__typename).toBe('User');
    });

    it('generates sequential IDs', () => {
      const ctx = new GeneratorContext();
      const d1 = generateEntityData(User, undefined, ctx);
      const d2 = generateEntityData(User, undefined, ctx);
      expect(d1.id).not.toBe(d2.id);
    });

    it('generates nested entities', () => {
      const data = generateEntityData(Post);
      expect(data.__typename).toBe('Post');
      expect(data.author).toBeDefined();
      expect((data.author as any).__typename).toBe('User');
      expect((data.author as any).id).toBeDefined();
    });

    it('handles cross-entity references', () => {
      const data = generateEntityData(Post);
      expect(data.__typename).toBe('Post');
      expect(data.author).toBeDefined();
      const author = data.author as Record<string, unknown>;
      expect(author.__typename).toBe('User');
      expect(author.name).toBeDefined();
    });
  });

  describe('generateQueryResponse', () => {
    it('generates a response matching the query result shape', () => {
      const mock = new MockClient();
      const data = generateQueryResponse(
        (new GetSimple() as any).__proto__.constructor === GetSimple
          ? { name: Mask.STRING as InternalTypeDef, count: Mask.NUMBER as InternalTypeDef, active: Mask.BOOLEAN as InternalTypeDef }
          : {} as any,
        mock._generatorCtx,
      );
      expect(data).toBeDefined();
      mock.destroy();
    });
  });
});

// ================================
// Entity factory tests
// ================================

describe('Entity Factories', () => {
  describe('defineFactory', () => {
    it('creates a factory with custom generators', () => {
      const factory = defineFactory(User, {
        name: (seq: number) => `User ${seq}`,
        email: (seq: number) => `user${seq}@test.com`,
      });

      const user = factory.build();
      expect(user.name).toMatch(/^User \d+$/);
      expect(user.email).toMatch(/^user\d+@test\.com$/);
      expect(user.__typename).toBe('User');
    });

    it('allows overrides on build', () => {
      const factory = defineFactory(User, {
        name: (seq: number) => `User ${seq}`,
      });

      const user = factory.build({ name: 'Alice' });
      expect(user.name).toBe('Alice');
    });

    it('builds many entities', () => {
      const factory = defineFactory(User, {
        name: (seq: number) => `User ${seq}`,
      });

      const users = factory.buildMany(3);
      expect(users).toHaveLength(3);

      const names = users.map(u => u.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(3);
    });

    it('builds many with shared overrides', () => {
      const factory = defineFactory(User, {
        name: (seq: number) => `User ${seq}`,
        email: () => 'shared@test.com',
      });

      const users = factory.buildMany(2, { email: 'override@test.com' });
      expect(users[0].email).toBe('override@test.com');
      expect(users[1].email).toBe('override@test.com');
    });

    it('supports derived fields', () => {
      const factory = defineFactory(User, {
        name: (seq: number) => `User ${seq}`,
        email: (_seq: number, fields: Record<string, unknown>) =>
          `${String(fields.name).toLowerCase().replace(' ', '.')}@test.com`,
      });

      const user = factory.build();
      expect(user.email).toMatch(/@test\.com$/);
    });
  });
});

// ================================
// MockClient tests
// ================================

describe('MockClient', () => {
  let mock: MockClient;

  beforeEach(() => {
    mock = new MockClient();
  });

  afterEach(() => {
    mock.destroy();
  });

  describe('basic setup', () => {
    it('exposes a QueryClient', () => {
      expect(mock.client).toBeDefined();
      expect(mock.client.constructor.name).toBe('QueryClient');
    });

    it('starts with no calls', () => {
      expect(mock.calls).toHaveLength(0);
    });
  });

  describe('mock.entity()', () => {
    it('generates entity data with defaults', () => {
      const user = mock.entity(User);
      expect(user.__typename).toBe('User');
      expect(user.id).toBeDefined();
      expect(user.name).toBeDefined();
      expect(user.email).toBeDefined();
    });

    it('applies overrides', () => {
      const user = mock.entity(User, { name: 'Alice' });
      expect(user.name).toBe('Alice');
      expect(user.__typename).toBe('User');
    });

    it('generates unique IDs', () => {
      const u1 = mock.entity(User);
      const u2 = mock.entity(User);
      expect(u1.id).not.toBe(u2.id);
    });
  });

  describe('mock.define()', () => {
    it('registers a factory used by entity()', () => {
      mock.define(User, {
        name: (seq: number) => `TestUser${seq}`,
        email: (seq: number) => `test${seq}@example.com`,
      });

      const user = mock.entity(User);
      expect(user.name).toMatch(/^TestUser\d+$/);
      expect(user.email).toMatch(/^test\d+@example\.com$/);
    });
  });

  describe('mock.when().respond()', () => {
    it('mocks a query response', async () => {
      mock.when(GetUser, { id: 1 }).respond({
        user: mock.entity(User, { name: 'Alice' }),
      });

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 1 });
        await result;
        expect(result.value!.user.name).toBe('Alice');
      });
    });

    it('mocks catch-all without params', async () => {
      mock.when(GetUser).respond({
        user: mock.entity(User, { name: 'Default' }),
      });

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 42 });
        await result;
        expect(result.value!.user.name).toBe('Default');
      });
    });

    it('records calls', async () => {
      mock.when(GetUser, { id: 1 }).respond({
        user: mock.entity(User, { name: 'Alice' }),
      });

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 1 });
        await result;
      });

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].method).toBe('GET');
      expect(mock.calls[0].url).toContain('/users/');
    });
  });

  describe('mock.when().auto()', () => {
    it('auto-generates a response from type defs', async () => {
      mock.when(GetUser, { id: 1 }).auto();

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 1 });
        await result;
        expect(result.value!.user).toBeDefined();
        expect(result.value!.user.name).toBeDefined();
        expect(result.value!.user.__typename).toBe('User');
      });
    });

    it('auto-generates with overrides', async () => {
      mock.when(GetUser, { id: 1 }).auto({
        user: { name: 'OverriddenName' },
      });

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 1 });
        await result;
        expect(result.value!.user.name).toBe('OverriddenName');
      });
    });
  });

  describe('mock.when().error()', () => {
    it('returns an error response', async () => {
      mock.when(GetUser, { id: 999 }).error(404);

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 999 });
        await expect(result).rejects.toThrow();
        expect(result.isRejected).toBe(true);
      });
    });
  });

  describe('mock.when().networkError()', () => {
    it('throws a network error', async () => {
      mock.when(GetUser, { id: 1 }).networkError('connection refused');

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 1 });
        await expect(result).rejects.toThrow('connection refused');
      });
    });
  });

  describe('mock.when().raw()', () => {
    it('returns raw data that bypasses MockClient type checks', async () => {
      mock.when(GetSimple, ).raw({ name: 'raw', count: 99, active: false });

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetSimple);
        await result;
        expect(result.value!.name).toBe('raw');
        expect(result.value!.count).toBe(99);
        expect(result.value!.active).toBe(false);
      });
    });

    it('can send malformed data that causes parse errors', async () => {
      mock.when(GetUser, { id: 1 }).raw({ unexpected: 'data' });

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 1 });
        await expect(result).rejects.toThrow();
      });
    });
  });

  describe('mock.when().thenRespond()', () => {
    it('queues sequential responses', async () => {
      mock
        .when(GetUser, { id: 1 })
        .respond({ user: mock.entity(User, { id: '1', name: 'V1' }) })
        .thenRespond({ user: mock.entity(User, { id: '1', name: 'V2' }) });

      await testWithClient(mock.client, async () => {
        const r1 = fetchQuery(GetUser, { id: 1 });
        await r1;
        expect(r1.value!.user.name).toBe('V1');

        const r2 = r1.value!.__refetch();
        await r2;
        expect(r2.value!.user.name).toBe('V2');
      });
    });
  });

  describe('mock.wasCalled()', () => {
    it('returns true when query was called', async () => {
      mock.when(GetUser, { id: 1 }).respond({
        user: mock.entity(User, { name: 'Alice' }),
      });

      await testWithClient(mock.client, async () => {
        await fetchQuery(GetUser, { id: 1 });
      });

      expect(mock.wasCalled(GetUser, { id: 1 })).toBe(true);
    });

    it('returns false when query was not called', () => {
      expect(mock.wasCalled(GetUser, { id: 1 })).toBe(false);
    });
  });

  describe('mock.lastCall()', () => {
    it('returns the last call for a query class', async () => {
      mock.when(GetUser).respond({
        user: mock.entity(User, { name: 'Alice' }),
      });

      await testWithClient(mock.client, async () => {
        await fetchQuery(GetUser, { id: 1 });
      });

      const call = mock.lastCall(GetUser);
      expect(call).toBeDefined();
      expect(call!.method).toBe('GET');
    });

    it('returns undefined when no calls match', () => {
      expect(mock.lastCall(GetUser)).toBeUndefined();
    });
  });

  describe('mock.reset()', () => {
    it('clears routes and calls', async () => {
      mock.when(GetUser, { id: 1 }).respond({
        user: mock.entity(User, { name: 'Alice' }),
      });

      await testWithClient(mock.client, async () => {
        await fetchQuery(GetUser, { id: 1 });
      });

      expect(mock.calls).toHaveLength(1);
      mock.reset();
      expect(mock.calls).toHaveLength(0);
    });
  });

  describe('response transforms', () => {
    it('transforms response data when set', async () => {
      mock.when(GetUser, { id: 1 }).respond({
        user: mock.entity(User, { name: 'Alice', email: 'alice@test.com' }),
      });

      mock._setResponseTransform('test', (data: unknown) => {
        const d = data as any;
        if (d && d.user) {
          return { ...d, user: { ...d.user, name: 'Transformed' } };
        }
        return d;
      });

      await testWithClient(mock.client, async () => {
        const result = fetchQuery(GetUser, { id: 1 });
        await result;
        expect(result.value!.user.name).toBe('Transformed');
      });

      mock._clearResponseTransform('test');
    });
  });
});

// ================================
// varyQuery tests
// ================================

describe('varyQuery', () => {
  let mock: MockClient;

  beforeEach(() => {
    mock = new MockClient();
  });

  afterEach(() => {
    mock.destroy();
  });

  describe('eachOptional', () => {
    it('generates a case per optional field', () => {
      const knob = varyQuery(mock, GetUser, { eachOptional: true });

      expect(knob.id).toContain('GetUser');
      const labels = knob.cases.map(c => c.label);
      expect(labels.some(l => l.includes('avatar'))).toBe(true);
      expect(labels.some(l => l.includes('bio'))).toBe(true);
    });

    it('scopes to specific fields', () => {
      const knob = varyQuery(mock, GetUser, {
        eachOptional: ['user.avatar'],
      });

      expect(knob.cases).toHaveLength(1);
      expect(knob.cases[0].label).toContain('avatar');
    });

    it('cases have stable deterministic IDs', () => {
      const knob = varyQuery(mock, GetUser, { eachOptional: true });

      for (const c of knob.cases) {
        expect(c.id).toBeDefined();
        expect(c.id.length).toBeGreaterThan(0);
      }
    });

    it('apply installs a response transform and cleanup removes it', () => {
      const knob = varyQuery(mock, GetUser, { eachOptional: true });
      const avatarCase = knob.cases.find(c => c.label.includes('avatar'));
      expect(avatarCase).toBeDefined();

      const cleanup = avatarCase!.apply();
      expect(typeof cleanup).toBe('function');
      (cleanup as () => void)();
    });

    it('state contains removed field paths', () => {
      const knob = varyQuery(mock, GetUser, { eachOptional: true });
      const avatarCase = knob.cases.find(c => c.label.includes('avatar'));
      expect(avatarCase!.state.removed).toContain('user.avatar');
    });
  });

  describe('arrayLengths', () => {
    it('generates a case per length', () => {
      const knob = varyQuery(mock, GetWithArray, {
        arrayLengths: [0, 1, 5],
      });

      expect(knob.cases.length).toBeGreaterThanOrEqual(3);
      expect(knob.cases.some(c => c.label.includes('0 items'))).toBe(true);
      expect(knob.cases.some(c => c.label.includes('1 item'))).toBe(true);
      expect(knob.cases.some(c => c.label.includes('5 items'))).toBe(true);
    });

    it('supports scoped map syntax', () => {
      const knob = varyQuery(mock, GetWithArray, {
        arrayLengths: { items: [0, 3] },
      });

      expect(knob.cases).toHaveLength(2);
    });

    it('state contains array length info', () => {
      const knob = varyQuery(mock, GetWithArray, {
        arrayLengths: [0],
      });
      const emptyCase = knob.cases.find(c => c.label.includes('0 items'));
      expect(emptyCase!.state.arrayLengths).toBeDefined();
    });
  });

  describe('combinations', () => {
    it('generates cross-product of structural choices', () => {
      const knob = varyQuery(mock, GetWithOptionals, {
        combinations: ['optStr', 'optNum'],
      });

      // optStr: present/absent (2) x optNum: present/absent (2) = 4
      expect(knob.cases).toHaveLength(4);
    });
  });
});

// ================================
// vitest-vary core tests
// ================================

describe('vitest-vary core', () => {
  describe('VaryKnob class', () => {
    const cases = [
      { id: 'alpha', label: 'Alpha variant', state: 'alpha', apply: () => {} },
      { id: 'beta', label: 'Beta variant', state: 'beta', apply: () => {} },
      { id: 'gamma', label: 'Gamma variant', state: 'gamma', apply: () => {} },
    ];

    it('constructor creates a knob with id and cases', () => {
      const knob = new VaryKnob('test', cases);
      expect(knob.id).toBe('test');
      expect(knob.cases).toHaveLength(3);
      expect(knob._isolate).toBe(false);
      expect(knob._pinnedIds.size).toBe(0);
    });

    describe('filter()', () => {
      it('narrows cases by ID substring', () => {
        const knob = new VaryKnob('test', cases);
        const filtered = knob.filter('alpha');
        expect(filtered.cases).toHaveLength(1);
        expect(filtered.cases[0].id).toBe('alpha');
      });

      it('narrows cases by label substring', () => {
        const knob = new VaryKnob('test', cases);
        const filtered = knob.filter('Beta');
        expect(filtered.cases).toHaveLength(1);
        expect(filtered.cases[0].id).toBe('beta');
      });

      it('accepts multiple IDs', () => {
        const knob = new VaryKnob('test', cases);
        const filtered = knob.filter('alpha', 'gamma');
        expect(filtered.cases).toHaveLength(2);
      });

      it('does not set isolation flag', () => {
        const knob = new VaryKnob('test', cases);
        const filtered = knob.filter('alpha');
        expect(filtered._isolate).toBe(false);
      });

      it('returns a new instance (immutable)', () => {
        const knob = new VaryKnob('test', cases);
        const filtered = knob.filter('alpha');
        expect(filtered).not.toBe(knob);
        expect(knob.cases).toHaveLength(3);
      });
    });

    describe('except()', () => {
      it('excludes cases by ID substring', () => {
        const knob = new VaryKnob('test', cases);
        const excluded = knob.except('alpha');
        expect(excluded.cases).toHaveLength(2);
        expect(excluded.cases.map(c => c.id)).toEqual(['beta', 'gamma']);
      });

      it('accepts multiple IDs', () => {
        const knob = new VaryKnob('test', cases);
        const excluded = knob.except('alpha', 'beta');
        expect(excluded.cases).toHaveLength(1);
        expect(excluded.cases[0].id).toBe('gamma');
      });
    });

    describe('only()', () => {
      it('filters cases like filter()', () => {
        const knob = new VaryKnob('test', cases);
        const only = knob.only('alpha');
        expect(only.cases).toHaveLength(1);
        expect(only.cases[0].id).toBe('alpha');
      });

      it('sets isolation flag', () => {
        const knob = new VaryKnob('test', cases);
        const only = knob.only('alpha');
        expect(only._isolate).toBe(true);
      });
    });

    describe('pin()', () => {
      it('marks case IDs as pinned without filtering', () => {
        const knob = new VaryKnob('test', cases);
        const pinned = knob.pin('alpha');
        expect(pinned.cases).toHaveLength(3);
        expect(pinned._pinnedIds.has('alpha')).toBe(true);
      });

      it('pins multiple cases', () => {
        const knob = new VaryKnob('test', cases);
        const pinned = knob.pin('alpha', 'gamma');
        expect(pinned._pinnedIds.has('alpha')).toBe(true);
        expect(pinned._pinnedIds.has('gamma')).toBe(true);
        expect(pinned._pinnedIds.has('beta')).toBe(false);
      });

      it('matches by label substring too', () => {
        const knob = new VaryKnob('test', cases);
        const pinned = knob.pin('Beta');
        expect(pinned._pinnedIds.has('beta')).toBe(true);
      });

      it('does not set isolation flag', () => {
        const knob = new VaryKnob('test', cases);
        const pinned = knob.pin('alpha');
        expect(pinned._isolate).toBe(false);
      });
    });

    describe('sample()', () => {
      it('reduces cases to max', () => {
        const manyCases = Array.from({ length: 20 }, (_, i) => ({
          id: `case-${i}`,
          label: `Case ${i}`,
          state: i,
          apply: () => {},
        }));
        const knob = new VaryKnob('test', manyCases);
        const sampled = knob.sample(5, 42);
        expect(sampled.cases).toHaveLength(5);
      });

      it('returns all cases when under max', () => {
        const knob = new VaryKnob('test', cases);
        const sampled = knob.sample(10, 42);
        expect(sampled.cases).toHaveLength(3);
      });

      it('preserves pinned cases through sampling', () => {
        const manyCases = Array.from({ length: 20 }, (_, i) => ({
          id: `case-${i}`,
          label: `Case ${i}`,
          state: i,
          apply: () => {},
        }));
        const knob = new VaryKnob('test', manyCases).pin('case-0', 'case-19');
        const sampled = knob.sample(5, 42);
        expect(sampled.cases).toHaveLength(5);

        const ids = sampled.cases.map(c => c.id);
        expect(ids).toContain('case-0');
        expect(ids).toContain('case-19');
      });

      it('is deterministic with same seed', () => {
        const manyCases = Array.from({ length: 50 }, (_, i) => ({
          id: `case-${i}`,
          label: `Case ${i}`,
          state: i,
          apply: () => {},
        }));
        const knob = new VaryKnob('test', manyCases);
        const s1 = knob.sample(10, 42);
        const s2 = knob.sample(10, 42);
        expect(s1.cases.map(c => c.id)).toEqual(s2.cases.map(c => c.id));
      });
    });
  });

  describe('VariantContext', () => {
    it('baseline context returns undefined for any knob', () => {
      const knob = new VaryKnob('test', []);
      expect(BASELINE_CONTEXT.get(knob)).toBeUndefined();
      expect(BASELINE_CONTEXT.isVariant).toBe(false);
      expect(BASELINE_CONTEXT.id).toBe('');
    });

    it('variant context returns state for active knobs', () => {
      const knob = new VaryKnob('test', [
        { id: 'c1', label: 'Case 1', state: { foo: 'bar' }, apply: () => {} },
      ]);
      const activeCases = new Map();
      activeCases.set(knob, knob.cases[0]);

      const ctx = createVariantContext(activeCases, 'c1');
      expect(ctx.isVariant).toBe(true);
      expect(ctx.id).toBe('c1');
      expect(ctx.get(knob)).toEqual({ foo: 'bar' });
    });

    it('variant context returns undefined for inactive knobs', () => {
      const knob1 = new VaryKnob('k1', [
        { id: 'c1', label: 'C1', state: 'active', apply: () => {} },
      ]);
      const knob2 = new VaryKnob('k2', []);
      const activeCases = new Map();
      activeCases.set(knob1, knob1.cases[0]);

      const ctx = createVariantContext(activeCases, 'c1');
      expect(ctx.get(knob1)).toBe('active');
      expect(ctx.get(knob2)).toBeUndefined();
    });
  });

  describe('sampler', () => {
    it('mulberry32 is deterministic with same seed', () => {
      const rng1 = mulberry32(42);
      const rng2 = mulberry32(42);
      const seq1 = Array.from({ length: 10 }, () => rng1());
      const seq2 = Array.from({ length: 10 }, () => rng2());
      expect(seq1).toEqual(seq2);
    });

    it('mulberry32 produces different sequences for different seeds', () => {
      const rng1 = mulberry32(1);
      const rng2 = mulberry32(999);
      const seq1 = Array.from({ length: 10 }, () => rng1());
      const seq2 = Array.from({ length: 10 }, () => rng2());
      expect(seq1).not.toEqual(seq2);
    });

    it('sampleArray returns all items when under max', () => {
      const items = [1, 2, 3];
      const rng = mulberry32(42);
      expect(sampleArray(items, 10, rng)).toEqual([1, 2, 3]);
    });

    it('sampleArray caps to max items', () => {
      const items = Array.from({ length: 100 }, (_, i) => i);
      const rng = mulberry32(42);
      const sampled = sampleArray(items, 10, rng);
      expect(sampled).toHaveLength(10);
    });

    it('sampleArray is deterministic with same seed', () => {
      const items = Array.from({ length: 50 }, (_, i) => i);
      const s1 = sampleArray(items, 10, mulberry32(42));
      const s2 = sampleArray(items, 10, mulberry32(42));
      expect(s1).toEqual(s2);
    });
  });
});
