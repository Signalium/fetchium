---
title: AI Agents
---

Fetchium ships with a **Claude Code plugin** and **Cursor-compatible skills** directly inside the npm package. These give AI coding agents deep knowledge of Fetchium's conventions, type system, and patterns --- version-locked to the library you're using.

---

## What's Included

The plugin provides three components:

### Agent Definition (always-on)

An always-on agent definition that makes your AI assistant a competent Fetchium developer without you having to ask. It includes:

- The Fetchium mental model (queries, mutations, entities)
- Import paths and API surface
- The full `t.*` type DSL reference
- Query class rules (references vs values, `get*()` methods, no arrow functions)
- Mutation effect conventions (prefer entity effects over invalidation)
- Usage patterns for both React + Hooks and React + Signalium

### `/fetchium:design` skill

An explicit skill for **analyzing and designing data models**. Invoke it when you want to:

- Map an existing REST API, GraphQL schema, or TypeScript types onto Fetchium's primitives
- Identify which objects should be entities vs plain objects
- Design query and mutation classes with correct effects
- Plan a migration to Fetchium from another data-fetching approach

The skill walks through a structured process: gather the data model, identify entities, map queries and mutations, flag issues, and produce a design plan with code.

### `/fetchium:teach` skill

An explicit skill for **learning and understanding Fetchium**. Invoke it when you want:

- Thorough explanations of Fetchium concepts with canonical examples from the docs
- Comparisons to other libraries (TanStack Query, Apollo, SWR)
- A glossary of Fetchium terms
- Links to the relevant documentation pages

This skill reads the full documentation files shipped with the plugin, so it provides accurate, detailed answers grounded in the actual docs.

---

## Installation

After `npm install fetchium`, run the installer to create symlinks:

```bash
npx fetchium-agents
```

This creates symlinks in `.claude/` and `.cursor/` pointing into `node_modules/fetchium/plugin/`:

- **Claude Code** --- symlinks into `.claude/agents/` and `.claude/skills/`
- **Cursor** --- symlinks into `.cursor/rules/` and `.cursor/skills/` (if `.cursor/skills` is already symlinked to `.claude/skills`, it detects this and skips duplicates)

All symlinks use relative paths, so they work on any machine after `npm install`. They can be committed to git for shared team setup, or gitignored if you prefer per-developer configuration.

You can also target a specific tool:

```bash
npx fetchium-agents --claude   # Claude Code only
npx fetchium-agents --cursor   # Cursor only
```

Files stay in sync automatically when you `npm update fetchium` --- no re-install needed.

### Alternative: Claude Code plugin

If you prefer to use Claude Code's plugin system directly instead of symlinks:

```bash
claude --plugin-dir node_modules/fetchium/plugin
```

### Manual setup

Create the symlinks yourself:

```bash
# Claude Code
ln -s ../../node_modules/fetchium/plugin/agents/fetchium.md .claude/agents/fetchium.md
ln -s ../../node_modules/fetchium/plugin/skills/design .claude/skills/fetchium-design
ln -s ../../node_modules/fetchium/plugin/skills/teach .claude/skills/fetchium-teach

# Cursor
ln -s ../../node_modules/fetchium/plugin/agents/fetchium.md .cursor/rules/fetchium.md
ln -s ../../node_modules/fetchium/plugin/skills/design .cursor/skills/fetchium-design
ln -s ../../node_modules/fetchium/plugin/skills/teach .cursor/skills/fetchium-teach
```

Once set up, the agent definition is active in every conversation, and you can invoke skills with `/fetchium:design` or `/fetchium:teach`.

---

## Usage Examples

### Design a data layer

```
/fetchium:design

Here are my API endpoints:

GET /api/users/:id → { id, name, email, posts: [{ id, title }] }
POST /api/users → { name, email } → { id, name, email }
PUT /api/users/:id → { name } → { id, name, email }
DELETE /api/users/:id → 204

GET /api/posts/:id → { id, title, body, author: { id, name } }
POST /api/posts → { title, body } → { id, title, body, author: { id, name } }
```

The agent will analyze these endpoints and produce a structured plan with Entity classes, Query classes, and Mutation classes with appropriate effects.

### Learn about entities

```
/fetchium:teach

How does entity normalization work? What happens when the same user
appears in multiple query results?
```

The agent will read the entity documentation and explain identity-stable proxies, deduplication, and cross-query updates with canonical examples.

### Day-to-day coding

With the agent definition active, just write code as normal. The agent will follow Fetchium conventions automatically --- using `t.*` for field definitions, following the query class rules, declaring proper mutation effects, and writing idiomatic React + Hooks or React + Signalium code.
