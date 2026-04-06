'use client';

import { useState, useEffect, type ReactNode } from 'react';
import Link from 'next/link';
import { FcTile } from '@/components/Logo';

const F = {
  code: "var(--font-jetbrains), 'JetBrains Mono', monospace",
  label: "var(--font-dm-mono), 'DM Mono', monospace",
  body: "var(--font-instrument), 'Instrument Sans', sans-serif",
};

const C = {
  bg0: '#0C0C0E',
  bg1: '#131315',
  bg2: '#1A1A1E',
  bg3: '#222226',
  text0: '#E8E8EC',
  text1: '#B0B0B8',
  text2: '#707078',
  text3: '#4A4A52',
  border: '#2A2A30',
  pink: '#F050A0',
  pinkBg: '#300C22',
  green: '#A8E848',
  greenBg: '#1A2C08',
  blue: '#6890E8',
  blueBg: '#0C1830',
  amber: '#E8B830',
  amberBg: '#282008',
  red: '#F06848',
  redBg: '#2A1008',
};

type ColorKey = 'pink' | 'green' | 'blue' | 'amber' | 'red' | 'muted';

const colorMap: Record<ColorKey, { fg: string; bg: string; b: string }> = {
  pink: { fg: C.pink, bg: C.pinkBg, b: C.pink + '40' },
  green: { fg: C.green, bg: C.greenBg, b: C.green + '40' },
  blue: { fg: C.blue, bg: C.blueBg, b: C.blue + '40' },
  amber: { fg: C.amber, bg: C.amberBg, b: C.amber + '40' },
  red: { fg: C.red, bg: C.redBg, b: C.red + '40' },
  muted: { fg: C.text2, bg: C.bg2, b: C.border },
};

function highlight(line: string): ReactNode {
  const rules = [
    { r: /(\/\/.*$)/gm, c: C.text3 },
    { r: /('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/g, c: C.green },
    {
      r: /\b(import|from|const|let|var|async|await|export|default|return|if|else|class|extends|get|new)\b/g,
      c: C.pink,
    },
    {
      r: /\b(RESTQuery|Entity|User|Post|Comment|GetUser|GetPost|GetFeed|useQuery|fetchQuery|reactive|component|TextItem|ImageItem)\b/g,
      c: C.green,
    },
    { r: /\b(t)\b(?=\.)/g, c: C.amber },
    {
      r: /\.(string|number|boolean|optional|array|entity|typename|id|format|object|union|params|path|result|value|name|email|avatar|title|body|author|comments|isReady|isRejected|error|message|posts|post|user|map|firstName|lastName|age|fullName)\b/g,
      c: '#88D038',
    },
    { r: /\b(\d+)\b/g, c: C.pink },
    { r: /[{}()[\]]/g, c: C.text3 },
    { r: /(===|true|false|null|undefined)/g, c: C.pink },
  ];

  const spans: { s: number; e: number; c: string; t: string; id: number }[] = [];
  let id = 0;

  for (const { r, c } of rules) {
    const re = new RegExp(r.source, r.flags);
    let m;
    while ((m = re.exec(line)) !== null) {
      spans.push({ s: m.index, e: m.index + m[0].length, c, t: m[0], id: id++ });
    }
  }

  spans.sort((a, b) => a.s - b.s);

  const filtered: typeof spans = [];
  let last = -1;
  for (const s of spans) {
    if (s.s >= last) {
      filtered.push(s);
      last = s.e;
    }
  }

  if (!filtered.length) return <span style={{ color: C.text1 }}>{line || ' '}</span>;

  const parts: ReactNode[] = [];
  let pos = 0;
  for (const s of filtered) {
    if (s.s > pos) {
      parts.push(
        <span key={`g${s.id}`} style={{ color: C.text1 }}>
          {line.slice(pos, s.s)}
        </span>,
      );
    }
    parts.push(
      <span key={s.id} style={{ color: s.c }}>
        {s.t}
      </span>,
    );
    pos = s.e;
  }
  if (pos < line.length) {
    parts.push(
      <span key="e" style={{ color: C.text1 }}>
        {line.slice(pos)}
      </span>,
    );
  }
  return <>{parts}</>;
}

function Code({ code, label, compact }: { code: string; label?: string; compact?: boolean }) {
  const lines = code.split('\n');
  return (
    <div className="rounded-xl overflow-hidden" style={{ background: C.bg0, border: `1px solid ${C.border}` }}>
      {label && (
        <div className="flex items-center gap-1.5 px-3.5 py-1.5" style={{ borderBottom: `1px solid ${C.border}` }}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.pink, opacity: 0.6 }} />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: C.green, opacity: 0.6 }} />
          <span className="ml-1.5 text-xs" style={{ color: C.text3, fontFamily: F.code }}>
            {label}
          </span>
        </div>
      )}
      <pre
        className="m-0 overflow-x-auto"
        style={{
          padding: compact ? '8px 12px' : '12px 14px',
          fontSize: compact ? 12 : 13,
          lineHeight: 1.7,
          fontFamily: F.code,
        }}
      >
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span
              className="shrink-0 text-right select-none"
              style={{ color: C.text3, width: 24, paddingRight: 12, fontSize: 11, opacity: 0.4 }}
            >
              {i + 1}
            </span>
            <span>{highlight(line)}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

function Tile({ symbol, number, name, color = 'muted' }: { symbol: string; number: string; name: string; color?: ColorKey }) {
  const cm = colorMap[color];
  return (
    <div
      className="w-20 h-20 rounded-md flex flex-col items-center justify-center shrink-0 relative"
      style={{ background: C.bg2, border: `1px solid ${C.border}` }}
    >
      <span className="absolute top-1.5 left-2" style={{ fontSize: 8, fontFamily: F.label, color: cm.fg, opacity: 0.8 }}>
        {number}
      </span>
      <span style={{ fontSize: 24, fontWeight: 700, fontFamily: F.code, color: cm.fg, lineHeight: 1 }}>
        {symbol}
      </span>
      <span
        className="mt-1 uppercase"
        style={{ fontSize: 7, fontFamily: F.label, color: C.text3, letterSpacing: '0.06em' }}
      >
        {name}
      </span>
    </div>
  );
}

function FeatureTile({
  symbol,
  number,
  name,
  color,
  title,
  desc,
}: {
  symbol: string;
  number: string;
  name: string;
  color: ColorKey;
  title: string;
  desc: string;
}) {
  const cm = colorMap[color];
  return (
    <div className="flex gap-4 items-start p-5 rounded-xl" style={{ background: C.bg2, border: `1px solid ${C.border}` }}>
      <div
        className="w-16 h-16 rounded-md flex flex-col items-center justify-center shrink-0 relative"
        style={{ background: cm.bg, border: `1px solid ${cm.b}` }}
      >
        <span className="absolute top-1 left-1.5" style={{ fontSize: 7, fontFamily: F.label, color: cm.fg, opacity: 0.7 }}>
          {number}
        </span>
        <span style={{ fontSize: 22, fontWeight: 700, fontFamily: F.code, color: cm.fg }}>
          {symbol}
        </span>
        <span className="uppercase" style={{ fontSize: 6, fontFamily: F.label, color: C.text3, letterSpacing: '0.06em' }}>
          {name}
        </span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium mb-1" style={{ color: C.text0, fontFamily: F.label }}>
          {title}
        </div>
        <p className="text-xs leading-relaxed m-0" style={{ color: C.text2, fontFamily: F.body }}>
          {desc}
        </p>
      </div>
    </div>
  );
}

function Badge({ children, color = 'pink' }: { children: ReactNode; color?: ColorKey }) {
  const cm = colorMap[color];
  return (
    <span
      className="text-xs font-semibold px-2.5 py-0.5 rounded"
      style={{ fontFamily: F.code, background: cm.bg, color: cm.fg, border: `1px solid ${cm.b}` }}
    >
      {children}
    </span>
  );
}

export function FetchiumHome() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div
      className="min-h-screen w-full"
      style={{
        fontFamily: F.body,
        background: C.bg1,
        color: C.text0,
        opacity: mounted ? 1 : 0,
        transition: 'opacity 0.5s',
      }}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between px-8 h-14 sticky top-0 z-10"
        style={{ borderBottom: `1px solid ${C.border}`, background: C.bg0 + 'ee', backdropFilter: 'blur(12px)' }}
      >
        <Link href="/" className="flex items-center gap-3">
          <FcTile size="sm" />
          <span style={{ fontFamily: F.label, fontWeight: 500, fontSize: 15, color: C.text0 }}>
            fetchium
          </span>
        </Link>
        <nav className="flex gap-6 text-sm" style={{ color: C.text2 }}>
          <Link href="/quickstart" className="hover:opacity-80 transition-opacity">
            Docs
          </Link>
          <Link href="/api/fetchium" className="hover:opacity-80 transition-opacity">
            API
          </Link>
          <Link href="/core/queries" className="hover:opacity-80 transition-opacity">
            Examples
          </Link>
          <Link
            href="https://github.com/Signalium/fetchium"
            className="transition-opacity hover:opacity-80"
            style={{ color: C.text0 }}
          >
            GitHub
          </Link>
        </nav>
      </header>

      {/* Hero */}
      <section className="px-10 pt-16 pb-6 max-w-6xl mx-auto">
        <div className="text-center mb-12">
          <div className="flex justify-center gap-2 mb-4">
            <Badge color="green">v0.1.0</Badge>
            <Badge color="pink">TypeScript</Badge>
          </div>
          <h1
            className="mb-3 leading-tight"
            style={{ fontSize: 42, fontWeight: 500, fontFamily: F.label, letterSpacing: '-0.01em' }}
          >
            The missing element
            <br />
            in data fetching
          </h1>
          <p className="text-base max-w-xl mx-auto" style={{ color: C.text2, lineHeight: 1.7 }}>
            Type-safe queries with entity normalization, fine-grained reactivity, and streaming — for REST APIs and
            beyond.
          </p>
        </div>

        <div className="flex gap-10 items-start">
          {/* Mini periodic table */}
          <div className="shrink-0 hidden lg:block">
            <span
              className="block mb-4 uppercase"
              style={{ fontSize: 9, fontFamily: F.label, color: C.text3, letterSpacing: '0.1em' }}
            >
              The HTTP elements
            </span>

            <div className="flex flex-col gap-2">
              {/* Row 1 */}
              <div className="flex gap-2 items-end">
                <Tile symbol="Hd" number="1" name="headers" color="blue" />
                <Tile symbol="Pm" number="2" name="params" color="blue" />
                <Tile symbol="Bd" number="3" name="body" color="blue" />
                <div className="w-6" />
                <div className="flex flex-col items-end mb-0.5">
                  <span style={{ fontSize: 9, fontFamily: F.label, color: C.amber, marginBottom: 3 }}>
                    RESILIENCE
                  </span>
                  <div className="flex gap-2">
                    <Tile symbol="Rt" number="7" name="retry" color="amber" />
                    <Tile symbol="Tm" number="8" name="timeout" color="amber" />
                  </div>
                </div>
              </div>

              {/* Row 2 — Pipeline + Fc + Response */}
              <div className="flex gap-2 items-center">
                <div className="flex flex-col items-start">
                  <span style={{ fontSize: 9, fontFamily: F.label, color: C.pink, marginBottom: 3, marginLeft: 2 }}>
                    PIPELINE
                  </span>
                  <div className="flex gap-2">
                    <Tile symbol="Rq" number="4" name="request" color="pink" />
                    <Tile symbol="Ic" number="5" name="intercept" color="pink" />
                  </div>
                </div>

                {/* Fc hero tile */}
                <div
                  className="w-24 h-28 rounded-md flex flex-col items-center justify-center shrink-0 relative"
                  style={{ background: C.bg2, border: `1.5px solid ${C.pink}` }}
                >
                  <span className="absolute top-2 left-2.5" style={{ fontSize: 10, fontFamily: F.label, color: C.green }}>
                    200
                  </span>
                  <span style={{ fontSize: 38, fontWeight: 700, fontFamily: F.code, color: C.pink, lineHeight: 1 }}>
                    Fc
                  </span>
                  <span
                    className="mt-1.5 uppercase"
                    style={{ fontSize: 8, fontFamily: F.label, color: C.text2, letterSpacing: '0.06em' }}
                  >
                    fetchium
                  </span>
                </div>

                <div className="flex flex-col items-end">
                  <span style={{ fontSize: 9, fontFamily: F.label, color: C.green, marginBottom: 3, marginRight: 2 }}>
                    RESPONSE
                  </span>
                  <div className="flex gap-2">
                    <Tile symbol="Rs" number="6" name="response" color="green" />
                    <Tile symbol="Ck" number="9" name="cache" color="green" />
                  </div>
                </div>
              </div>

              {/* Row 3 */}
              <div className="flex gap-2 items-start">
                <div className="flex flex-col items-start">
                  <div className="flex gap-2">
                    <Tile symbol="Js" number="10" name="json" color="green" />
                    <Tile symbol="Bl" number="11" name="blob" color="green" />
                    <Tile symbol="Tx" number="12" name="text" color="green" />
                  </div>
                  <span style={{ fontSize: 9, fontFamily: F.label, color: C.green, marginTop: 3, marginLeft: 2 }}>
                    BODY TYPES
                  </span>
                </div>
                <div className="w-6" />
                <div className="flex flex-col items-end">
                  <div className="flex gap-2">
                    <Tile symbol="Er" number="13" name="error" color="red" />
                    <Tile symbol="Ab" number="14" name="abort" color="red" />
                  </div>
                  <span style={{ fontSize: 9, fontFamily: F.label, color: C.red, marginTop: 3, marginRight: 2 }}>
                    FAILURE
                  </span>
                </div>
              </div>
            </div>

            {/* Legend */}
            <div className="flex gap-5 mt-4 flex-wrap">
              {[
                { label: 'Composition', color: C.blue },
                { label: 'Pipeline', color: C.pink },
                { label: 'Response', color: C.green },
                { label: 'Resilience', color: C.amber },
                { label: 'Failure', color: C.red },
              ].map(({ label, color }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm" style={{ background: color, opacity: 0.7 }} />
                  <span style={{ fontSize: 10, fontFamily: F.label, color: C.text3 }}>{label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Hero code */}
          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            <Code
              label="queries/GetUser.ts"
              code={`class GetUser extends RESTQuery {\n  params = {\n    id: t.number,\n  };\n\n  path = \`/users/\${this.params.id}\`;\n\n  result = {\n    user: t.entity(User),\n  };\n}`}
            />
            <Code
              label="components/Profile.tsx"
              code={`const UserProfile = component(async () => {\n  const { user } = await fetchQuery(\n    GetUser, { id: 42 }\n  );\n\n  return (\n    <div>\n      <h1>{user.name}</h1>\n      <p>{user.email}</p>\n    </div>\n  );\n});`}
            />
          </div>
        </div>

        {/* CTA */}
        <div className="flex items-center justify-center gap-3 mt-10">
          <div
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm"
            style={{ background: C.bg0, border: `1px solid ${C.border}`, fontFamily: F.code, color: C.text1 }}
          >
            <span style={{ color: C.text3 }}>$</span> npm install fetchium
          </div>
          <Link
            href="/quickstart"
            className="px-5 py-2.5 rounded-lg text-sm font-medium border-none text-white"
            style={{ background: C.pink, fontFamily: F.label }}
          >
            Get started
          </Link>
        </div>
        <p className="text-center mt-3" style={{ fontSize: 12, color: C.text3 }}>
          REST-first. Protocol-agnostic. Built on <span style={{ color: C.green }}>Signalium</span>. Works with React,
          Vue, Svelte, and more.
        </p>
      </section>

      {/* Feature strip */}
      <section
        className="py-5 px-10"
        style={{ borderTop: `1px solid ${C.border}`, borderBottom: `1px solid ${C.border}`, background: C.bg0 }}
      >
        <div className="max-w-6xl mx-auto flex justify-center gap-8 flex-wrap">
          {[
            'Entity normalization',
            'End-to-end type safety',
            'Fine-grained reactivity',
            'Streaming updates',
            'Smart caching',
            'Protocol agnostic',
          ].map(i => (
            <span key={i} style={{ fontSize: 12, fontFamily: F.label, color: C.text2, letterSpacing: '0.02em' }}>
              {i}
            </span>
          ))}
        </div>
      </section>

      {/* Elements of Fetchium */}
      <section className="px-10 py-16 max-w-6xl mx-auto">
        <h2 className="text-center mb-2" style={{ fontSize: 26, fontWeight: 500, fontFamily: F.label }}>
          The elements of Fetchium
        </h2>
        <p className="text-center mb-10 max-w-lg mx-auto" style={{ fontSize: 14, color: C.text2, lineHeight: 1.6 }}>
          Everything you need for production data fetching, nothing you don&apos;t.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-4xl mx-auto">
          <FeatureTile
            symbol="Qr" number="1" name="QUERY" color="pink" title="Queries"
            desc="Class-based templates with type-safe params. Define once, use everywhere. Protocol-agnostic — switch from REST to GraphQL without changing usage sites."
          />
          <FeatureTile
            symbol="Mu" number="2" name="MUTATION" color="pink" title="Mutations"
            desc="Optimistic updates, cache invalidation, and rollback. Mutations share the same class-based pattern as queries for a consistent API."
          />
          <FeatureTile
            symbol="Ts" number="3" name="TYPES" color="amber" title="Type DSL"
            desc="A zero-alloc DSL that is both a runtime validator and TypeScript type. Number masks, not objects. Designed for resilience — optional fields fall back, arrays filter unknown items."
          />
          <FeatureTile
            symbol="En" number="4" name="ENTITY" color="amber" title="Entities"
            desc="Normalized, deduplicated, identity-stable proxy objects. The same user across 10 queries is the exact same reference. Update once, see it everywhere."
          />
          <FeatureTile
            symbol="Sg" number="5" name="SIGNAL" color="green" title="Fine-grained reactivity"
            desc="Built on Signalium. Lazy entanglement means you only pay for what you read. No wasted renders, no stale closures. Works outside React too."
          />
          <FeatureTile
            symbol="St" number="6" name="STREAM" color="green" title="Streaming"
            desc="First-class real-time subscriptions on entities. WebSocket, SSE, or any source — define __subscribe and Fetchium handles the lifecycle."
          />
          <FeatureTile
            symbol="Ck" number="7" name="CACHE" color="blue" title="Cache"
            desc="Normalized entity store with configurable GC, deduplication, and stale-while-revalidate. Smart enough to skip the network when data is fresh."
          />
          <FeatureTile
            symbol="Rf" number="8" name="REFETCH" color="blue" title="Refetching"
            desc="Polling, window focus refetch, network reconnect, and manual invalidation. Configure per-query or globally. Dynamic intervals based on response state."
          />
        </div>
      </section>

      {/* Entity normalization */}
      <section className="px-10 py-16 max-w-6xl mx-auto" style={{ borderTop: `1px solid ${C.border}` }}>
        <div className="flex flex-col lg:flex-row gap-12 items-start">
          <div className="shrink-0 lg:max-w-[340px]">
            <h2 className="mb-3" style={{ fontSize: 22, fontWeight: 500, fontFamily: F.label }}>
              Entities that stay in sync
            </h2>
            <p className="text-sm leading-relaxed mb-4" style={{ color: C.text1 }}>
              When the same user appears in a post and a profile, Fetchium returns the <em>exact same object</em>.
              Update it anywhere, see it everywhere — no manual cache invalidation.
            </p>
            <div className="rounded-lg p-3 mb-3" style={{ background: C.greenBg, borderLeft: `3px solid ${C.green}` }}>
              <span className="text-xs font-medium" style={{ color: C.green, fontFamily: F.label }}>
                Identity stable
              </span>
              <p className="text-xs m-0 mt-1 leading-relaxed" style={{ color: C.text1 }}>
                Entity proxies backed by signals. Lazy entanglement means you only pay for what you read.
              </p>
            </div>
            <div className="rounded-lg p-3" style={{ background: C.pinkBg, borderLeft: `3px solid ${C.pink}` }}>
              <span className="text-xs font-medium" style={{ color: C.pink, fontFamily: F.label }}>
                Works with React
              </span>
              <p className="text-xs m-0 mt-1 leading-relaxed" style={{ color: C.text1 }}>
                Deep cloning with structural sharing at the React boundary. Compatible with memo, compiler, and
                Suspense.
              </p>
            </div>
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-2.5">
            <Code
              label="entities/User.ts"
              code={`class User extends Entity {\n  __typename = t.typename('User');\n  id = t.id;\n  name = t.string;\n  email = t.string;\n  avatar = t.optional(t.string);\n  createdAt = t.format('date-time');\n\n  get fullName() {\n    return this.name;\n  }\n}`}
            />
            <Code
              label="The same object, everywhere"
              compact
              code={`const { user } = await fetchQuery(GetUser, { id: '1' });\nconst { post } = await fetchQuery(GetPost, { id: '5' });\n\n// If post #5's author is user #1:\npost.author === user; // true`}
            />
          </div>
        </div>
      </section>

      {/* Resilient parsing */}
      <section className="px-10 py-16 max-w-6xl mx-auto" style={{ borderTop: `1px solid ${C.border}` }}>
        <div className="flex flex-col-reverse lg:flex-row gap-12 items-start">
          <div className="flex-1 min-w-0">
            <Code
              label="Resilient by default"
              code={`// Optional fields fall back gracefully\nresult = {\n  name: t.string,\n  bio: t.optional(t.string), // unknown? -> undefined\n};\n\n// Arrays filter out unparseable items\nresult = {\n  items: t.array(\n    t.union(TextItem, ImageItem) // unknown? -> skipped\n  ),\n};`}
            />
          </div>
          <div className="shrink-0 lg:max-w-[340px]">
            <h2 className="mb-3" style={{ fontSize: 22, fontWeight: 500, fontFamily: F.label }}>
              APIs change. Your app shouldn&apos;t break.
            </h2>
            <p className="text-sm leading-relaxed mb-4" style={{ color: C.text1 }}>
              Fetchium&apos;s type system is designed for resilience. Optional fields fall back to undefined. Arrays silently
              filter unknown types. Your app keeps running while the API evolves.
            </p>
            <p className="text-sm leading-relaxed" style={{ color: C.text2 }}>
              The type DSL uses number masks under the hood — not objects. A type like{' '}
              <code
                className="text-xs px-1.5 py-0.5 rounded"
                style={{ background: C.bg3, color: C.amber, fontFamily: F.code }}
              >
                t.optional(t.string)
              </code>{' '}
              creates zero allocations.
            </p>
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section className="px-10 py-12" style={{ borderTop: `1px solid ${C.border}`, background: C.bg0 }}>
        <div className="max-w-4xl mx-auto">
          <h2 className="text-center mb-6" style={{ fontSize: 20, fontWeight: 500, fontFamily: F.label }}>
            What you get
          </h2>
          <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${C.border}` }}>
            <table className="w-full border-separate border-spacing-0 rounded-none! border-0! bg-transparent!">
              <thead>
                <tr>
                  {['', 'Fetchium', 'TanStack Query', 'Apollo Client'].map((h, i) => (
                    <th
                      key={h || 'e'}
                      className="text-left px-4 py-2.5"
                      style={{
                        background: C.bg3,
                        fontSize: 12,
                        fontWeight: 500,
                        color: i === 1 ? C.pink : C.text2,
                        textAlign: i > 0 ? 'center' : 'left',
                        borderBottom: `1px solid ${C.border}`,
                        fontFamily: F.label,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {([
                  ['REST support', 'First class', 'BYO fetch fn', '—'],
                  ['GraphQL support', 'Adapter', '—', 'First class'],
                  ['Entity normalization', true, false, true],
                  ['End-to-end type safety', true, 'Partial', 'Partial'],
                  ['Fine-grained reactivity', true, false, false],
                  ['Streaming / real-time', true, false, 'Subscriptions'],
                  ['Protocol agnostic', true, false, false],
                  ['Zero-alloc type DSL', true, false, false],
                ] as const).map(([label, fc, tq, ap], ri) => (
                  <tr key={String(label)}>
                    {[label, fc, tq, ap].map((val, i) => (
                      <td
                        key={`${String(label)}-${i}`}
                        className="px-4 py-2"
                        style={{
                          background: C.bg2,
                          fontSize: 12,
                          color: val === true ? C.green : val === false ? C.text3 : i === 1 ? C.text0 : C.text2,
                          textAlign: i > 0 ? 'center' : 'left',
                          borderBottom: ri < 7 ? `1px solid ${C.border}` : 'none',
                          ...(i > 0 ? { fontFamily: F.label } : {}),
                        }}
                      >
                        {val === true ? '✓' : val === false ? '—' : String(val)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Get started */}
      <section className="px-10 py-16 text-center">
        <h2 className="mb-3" style={{ fontSize: 28, fontWeight: 500, fontFamily: F.label }}>
          Start fetching
        </h2>
        <p className="mb-7" style={{ fontSize: 15, color: C.text2 }}>
          Add Fetchium to your project and define your first query in minutes.
        </p>
        <div className="inline-flex gap-3">
          <div
            className="flex items-center gap-2 px-5 py-3 rounded-lg text-sm"
            style={{ background: C.bg0, border: `1px solid ${C.border}`, color: C.text1, fontFamily: F.code }}
          >
            <span style={{ color: C.text3 }}>$</span> npm install fetchium
          </div>
          <Link
            href="/quickstart"
            className="px-6 py-3 rounded-lg text-sm font-medium border-none text-white"
            style={{ background: C.pink, fontFamily: F.label }}
          >
            Read the docs
          </Link>
        </div>
        <div className="flex justify-center gap-6 mt-8">
          {[
            { s: 'Qr', n: 'Queries', c: 'pink' as const, href: '/core/queries' },
            { s: 'En', n: 'Entities', c: 'amber' as const, href: '/core/entities' },
            { s: 'Mu', n: 'Mutations', c: 'pink' as const, href: '/data/mutations' },
            { s: 'St', n: 'Streaming', c: 'green' as const, href: '/core/streaming' },
          ].map(({ s, n, c, href }) => (
            <Link key={n} href={href} className="flex items-center gap-2 transition-opacity hover:opacity-80">
              <div
                className="w-7 h-7 rounded flex items-center justify-center"
                style={{ background: C.bg2, border: `1px solid ${C.border}` }}
              >
                <span style={{ fontSize: 11, fontWeight: 700, color: colorMap[c].fg, fontFamily: F.code }}>
                  {s}
                </span>
              </div>
              <span style={{ fontSize: 13, color: C.text2, fontFamily: F.label }}>{n}</span>
            </Link>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="flex items-center justify-between px-10 py-6" style={{ borderTop: `1px solid ${C.border}` }}>
        <div className="flex items-center gap-2">
          <span style={{ fontSize: 13, color: C.text3, fontFamily: F.label }}>fetchium</span>
          <span style={{ color: C.text3 }}>—</span>
          <span style={{ fontSize: 11, color: C.text3 }}>The HTTP element</span>
        </div>
        <div className="flex gap-5 text-xs" style={{ color: C.text3 }}>
          {[
            { label: 'GitHub', href: 'https://github.com/Signalium/fetchium' },
            { label: 'npm', href: 'https://www.npmjs.com/package/fetchium' },
          ].map(({ label, href }) => (
            <Link key={label} href={href} className="transition-opacity hover:opacity-80" style={{ color: C.text3 }}>
              {label}
            </Link>
          ))}
        </div>
      </footer>
    </div>
  );
}
