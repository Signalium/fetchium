---
description: Analyze an existing data model and design Fetchium entities, queries, and mutations. Use when the user wants to map an API, schema, or data model onto Fetchium primitives, plan a migration, or design a new data layer.
---

# Fetchium Design

Help the user analyze an existing data model and map it onto Fetchium's primitives: Entities, Queries, and Mutations. Produce a structured design plan.

## Mode

If `$ARGUMENTS` contains "hooks" or "signalium", use that mode for component examples in the design plan. Otherwise, auto-detect by checking the codebase for `signalium` or `signalium/react` imports. Default to React + Hooks if neither is specified nor detected.

## Process

### 1. Gather the existing data model

Ask the user to provide one or more of:
- REST API endpoints (OpenAPI spec, route definitions, or example curl commands)
- GraphQL schema or queries
- TypeScript interfaces or types for API responses
- Database schema (SQL DDL or ORM models)
- Example JSON payloads from their API

If the user hasn't provided anything yet, ask them to share their data model before proceeding.

### 2. Identify Entities

Entities are objects with **identity** — they have a unique typename and ID, and the same object may appear across multiple queries.

Look for:
- Objects with an `id` field (or similar: `_id`, `uuid`, `pk`)
- Objects referenced by multiple endpoints or nested in other objects
- Objects that can be created, updated, or deleted independently

For each entity, note:
- The typename (use the domain name: `User`, `Post`, `Comment`, etc.)
- The ID field and type (`string` or `number`)
- All scalar fields and their types
- Relationships to other entities (these become `t.entity(OtherEntity)` references)
- Any union/polymorphic types (need `t.typename(...)` discriminator)

**Not everything is an entity.** Plain response wrappers, pagination metadata, and one-off objects without identity should be `t.object({ ... })`, not Entity classes.

### 3. Identify Queries

Map read operations to Query classes:
- Each GET endpoint or GraphQL query becomes a `RESTQuery` (or custom `Query`) class
- Identify params: path parameters, query string parameters, headers
- Identify the result shape: which fields come back, which are entities vs plain objects
- Note pagination patterns (offset/cursor) — these may need `sendNext()`/`hasNext()`
- Note polling/subscription needs — these use `config.subscribe`

### 4. Identify Mutations

Map write operations to Mutation classes:
- Each POST/PUT/PATCH/DELETE endpoint becomes a `RESTMutation` (or custom `Mutation`)
- Identify params and body shape
- **Critically:** identify the side effects:
  - **Creates**: which entity type is created? Does the server return the new entity?
  - **Updates**: which entity fields change? Can effects be declared statically from params, or do they need `getEffects()` (server response dependent)?
  - **Deletes**: which entity is removed?
- Note if optimistic updates are appropriate (simple, predictable changes)
- Note if `invalidates` is needed (complex server-side logic, bulk operations)

### 5. Flag issues

Watch for these common problems:
- **Missing IDs**: Objects that should be entities but lack an `id` field
- **Undiscriminated unions**: Polymorphic arrays/objects without a `type`/`__typename` discriminator field
- **Circular references**: Entity A references Entity B which references Entity A — Fetchium handles this, but note it
- **Denormalized data**: The same entity returned with different field subsets across endpoints — design entities with `t.optional()` for fields not always present
- **Missing typename in API**: The API may not return a `type` field — note where the client needs to inject one

### 6. Produce the design plan

Output a structured plan with these sections:

**Entities** — list each Entity class with its fields in `t.*` DSL format:
```ts
class User extends Entity {
  __typename = t.typename('User');
  id = t.id;
  name = t.string;
  email = t.string;
  posts = t.array(t.entity(Post));
}
```

**Queries** — list each Query class with params, path, and result:
```ts
class GetUser extends RESTQuery {
  params = { id: t.id };
  path = `/users/${this.params.id}`;
  result = { user: t.entity(User) };
}
```

**Mutations** — list each Mutation class with params, method, body, and effects:
```ts
class UpdateUser extends RESTMutation {
  params = { id: t.id, name: t.string };
  path = `/users/${this.params.id}`;
  method = 'PUT';
  body = { name: this.params.name };
  result = User;
  effects = {
    updates: [[User, { id: this.params.id, name: this.params.name }]],
  };
}
```

**Gaps and decisions** — list anything that needs user input:
- Ambiguous entity boundaries
- Missing discriminators that need to be added
- Fields that might need `t.optional()` vs required
- Polling/subscription decisions
- Live array constraints for collections

## Reference

For detailed guidance on any topic, read the relevant files from `node_modules/fetchium/plugin/docs/`:
- Entity definitions and proxy behavior: `node_modules/fetchium/plugin/docs/core/entities.md`
- Query definitions and class rules: `node_modules/fetchium/plugin/docs/core/queries.md`
- Type DSL reference: `node_modules/fetchium/plugin/docs/core/types.md`
- Mutation effects and optimistic updates: `node_modules/fetchium/plugin/docs/data/mutations.md`
- Live arrays and live values: `node_modules/fetchium/plugin/docs/data/live-data.md`
- REST query configuration: `node_modules/fetchium/plugin/docs/reference/rest-queries.md`
- Pagination patterns: `node_modules/fetchium/plugin/docs/reference/pagination.md`
- Streaming and subscriptions: `node_modules/fetchium/plugin/docs/reference/streaming.md`
