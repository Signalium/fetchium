---
title: Types
---

Fetchium includes a DSL for defining the shape of your data - parameters, results, and entity fields. Fetchium uses these shapes to **parse API responses**, **normalize entities** into the cache, and **infer TypeScript types** so your queries are fully typed end-to-end.

This type validation system is focused on validating **JSON**. It is not a general-purpose validator, such as tools like [Zod](https://zod.dev/), which can be used to validate and parse nearly _any_ object that can be described with _TypeScript_. They support input values like _functions_, _custom classes_, objects with _circular references_, and so on.

By contrast, Fetchium's scope is _intentionally narrow_ and focused on _performance and evolution_. The DSL only includes the bare necessities to describe the _majority_ of JSON based APIs, with certain edge-case anti-patterns excluded entirely. It also includes an opinionated set of default behaviors designed to help you build robust APIs that can change over time.

## DSL Reference

The type DSL includes the usual suspects of such systems:

- Base primitives
- Objects/Arrays/Records
- Unions
- Helpers for optional/nullable/nullish union types

| Definition          | TypeScript type          |
| ------------------- | ------------------------ |
| `t.string`          | `string`                 |
| `t.number`          | `number`                 |
| `t.boolean`         | `boolean`                |
| `t.null`            | `null`                   |
| `t.undefined`       | `undefined`              |
| `t.object({ ... })` | `{ ... }`                |
| `t.array(type)`     | `T[]`                    |
| `t.record(type)`    | `Record<string, T>`      |
| `t.union(...types)` | Union of types           |
| `t.optional(type)`  | `T \| undefined`         |
| `t.nullable(type)`  | `T \| null`              |
| `t.nullish(type)`   | `T \| undefined \| null` |

These can be combined in standard, predictable ways:

```ts
t.union(t.string, t.number);

t.object({ foo: t.string, bar: t.number });

t.array(t.nullable(t.boolean));
```

Notably there are no _chaining_ APIs, e.g. `t.string.optional`. While convenient and readable, chaining APIs add a lot of _weight_. Every primitive type becomes an object, and every combination of primitive types becomes a _new_ object. Under the hood, Fetchium represents primitive types as _number masks_, meaning that for a type definition like:

```ts
t.object({
  name: t.string,
  desc: t.optional(t.string),
  currentState: t.union(t.string, t.number),
});
```

Only a single object is created - the object definition. Every other type union is a masking operation, and the result is an object of numbers.

In addition to these basic primitives, there are a number of additional special type validators:

| Definition                          | TypeScript type         | Desc                                                                                                                                                                                              |
| ----------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t.const(value)`                    | Literal type of `value` | Constant value                                                                                                                                                                                    |
| `t.enum(...values)`                 | Union of literals       | One of a set of constant values                                                                                                                                                                   |
| `t.enum.caseInsensitive(...values)` | Union of literals       | Case-insensitive set of values. All values get coerced to the casing in the _definition_. While not _recommended_, this is helpful for legacy APIs which may have inconsistent casing             |
| `t.typename(value)`                 | Literal string          | Type identifier for object and [Entity](./entities) types                                                                                                                                         |
| `t.id`                              | `string \| number`      | Identifier for [Entity](./entities) types                                                                                                                                                         |
| `t.result(type)`                    | `ParseResult<T>`        | Parse result for explicit handling of parse errors                                                                                                                                                |
| `t.format(name)`                    | Registered format type  | Formatted string or number value, such as `date` or `date-time`. Formatted values are serialized and deserialized via a registered format function, and types are registered in a global registry |
| `t.entity(EntityClass)`             | Entity class instance   | An instance of the given [Entity](./entities) class                                                                                                                                               |

## Designed for Evolving APIs

APIs change. New fields are added, new types appear in lists, response shapes grow. There are many small changes like these that generally don't warrant a "v2" of the API, and that may _appear_ additive and safely non-breaking at first, but that cause regressions when shipped in an app.

For instance, consider the following API Response:

```ts
interface TextItem {
  type: 'text';
  content: string;
}

interface ImageItem {
  type: 'image';
  url: string;
  caption: string;
}

type FeedItem = TextItem | ImageItem;

interface FeedResponse {
  items: FeedItem[];
}
```

Here we have a feed with two types of items, perhaps the initial MVP implementation of our feed page. We get it out the door and onto devices, and immediately product turns around and asks to add a Video feed item.

Now, if the developer of the client portion was thoughtful during the build out, they would have realized that even though there are only two items available currently, there _may_ be more in the future, and their implementation would have done something like the following:

```tsx
import { ImageFeedItem, TextFeedItem } from './feed-components';

export function Feed() {
  const { items, isReady } = useFeedItems();

  if (!isReady) return <div>Loading...</div>;

  return (
    <div>
      {items.map((item) => {
        switch (item.type) {
          case 'text':
            return <TextFeedItem item={item} />;
          case 'image':
            return <ImageFeedItem item={item} />;
          default:
            // Unknown feed item type, render nothing, log to telemetry
            telemetry.log('unknown feed item type');
        }
      })}
    </div>
  );
}
```

But maybe they didn't think about this, and instead threw an error if an unknown type was added. Or even before that, maybe their _type validators_ didn't account for the possibility of new types, and they throw an error on parse.

Fetchium's philosophy is based on _resilience_ to changes like these, and it achieves this through a core assumption:

> Showing _nothing_ is a better default than throwing an error.

This is not always true, there are times when you do want to show errors and tell users about explicit failures. But additive changes which have no impact on _existing clients_ out in the world should not cause failures by default. In the world of _native app_ development, where users may not upgrade for some time, this becomes exceedingly relevant.

Fetchium achieves this with two main default behaviors:

1. **Optional fields fall back gracefully.** If a field is wrapped in `t.optional(...)` and the incoming value doesn't match, it falls back to `undefined` instead of throwing a failure. This allows you to turn
   - `t.optional(t.string)` into
   - `t.optional(t.union(t.string, t.number))`
     Without it being a breaking change to older clients.
2. **Arrays filter out unparseable items.** If an element in an array fails to parse, it's silently removed from the result rather than failing the entire response. This lets you add new types to a polymorphic array - clients that don't know about the new type simply don't see those items.

These two default behaviors are _safe_ because in both cases, we know that the code itself must be capable of handling it. In the case of optional fields, developers must already handle the `undefined` branch, and in the case of arrays, we simply skip over the unparsed items as if they didn't exist.

{% callout title="Logging parse failure events" type="note" %}
While these types of failures are typically expected, you may still want to know about them to understand if many clients are seeing a dramatic uptick in them. If every item in the array fails to parse, and users are seeing nothing in their feed, that is notable and still not ideal.

Failures can be captured by passing in a custom `log` object when creating the QueryClient. These failures are captured via `log.warn`, which has the same type signature as `console.warn`.
{% /callout %}

### Parse Results

You can also handle these failures more explicitly with `t.result`:

```ts
// Produces string | undefined
t.optional(t.string);

// Produces ParseResult<string>
t.result(t.string);
```

When you wrap a type in `t.result`, it returns a parse result of the value:

```ts
interface ParseSuccess<T> {
  success: true;
  value: T;
}

interface ParseError {
  success: false;
  error: unknown;
}

type ParseResult<T> = ParseSuccess<T> | ParseError;
```

Parse results fail explicitly instead of silently and force the user to handle the error, ensure that it is safe to fail. They only apply to the _immediate_ child, so nested properties will still default to `undefined` if possible before attempting to throw.

## Unions and Performance

Unions are one of the trickiest parts of any parsing system. In particular, there are two main areas where things get difficult:

1. Unions of multiple different types of well-defined objects
2. Unions of unbounded _collections_ (e.g. arrays and records)

Unions of primitives types are fairly trivial (simply check `typeof`), and unions that include _one_ complex object type are also fairly straightforward, but when we need to distinguish between object shapes, it becomes much more difficult.

### Unions of Multiple Object Types

Imagine if we removed the `type` property from our earlier `FeedItem` example:

```ts
interface TextItem {
  content: string;
}

interface ImageItem {
  url: string;
  caption: string;
}

type FeedItem = TextItem | ImageItem;
```

The only way for us to tell if a `FeedItem` is a text or image item is through checking for the individual fields of one or the other. For validation libraries, this ends up meaning we parse _each type sequentially_ until we find one that matches the given object, which results in repeated traversals and errors being created and caught.

This is a massive performance penalty on one of the most common patterns in API unions, and libraries like Zod have added their own `discriminatedUnion` type functions to short circuit this by looking up a _discriminator field_, like our original `type` string in the first example. However, this strategy relies on developers _knowing and remembering_ to use a special type of union in these cases, which leaves you one small mistake away from a performance regression.

This brings us to Fetchium's _first_ major restriction on unions:

> **Object/entity unions must be discriminated.** When a union contains multiple object or entity types, each must have a _type_ field, denoted with `t.typename(...)`. This field can be _any_ field (you can call it `type` or `typename` or `__typename` or anything else that is a valid string), but ALL objects in a union must have the _same_ typename field, and each object must have a _unique_ typename _value_.

So for example, to define our `TextItem` and `ImageItem` types, we could do the following:

```ts
// ✅ Valid, same typename property with distinct values
const TextItem = t.object({
  type: t.typename('text'),
  content: t.string,
});

const ImageItem = t.object({
  type: t.typename('image'),
  url: t.string,
  caption: t.string,
});

const FeedItem = t.union(TextItem, ImageItem);
```

But these would be invalid:

```ts
// 🛑 Invalid, different typenames
const TextItem = t.object({
  type: t.typename('text'),
  content: t.string,
});

const ImageItem = t.object({
  typename: t.typename('image'),
  url: t.string,
  caption: t.string,
});

const FeedItem = t.union(TextItem, ImageItem);

// 🛑 Invalid, overlapping typenames
const TextItem = t.object({
  type: t.typename('text'),
  content: t.string,
});

const ExpandedTextItem = t.object({
  typename: t.typename('text'),
  content: t.string,
  fullContent: t.string,
});

const FeedItem = t.union(TextItem, ExpandedTextItem);

// 🛑 Invalid, missing typenames on some objects
const TextItem = t.object({
  content: t.string,
});

const ImageItem = t.object({
  typename: t.typename('image'),
  url: t.string,
  caption: t.string,
});

const FeedItem = t.union(TextItem, ImageItem);
```

### Unions of Collections

The other major pain point in parsing is _unions of collections_. To be clear, we are not talking about _collections of unions_. To illustrate:

```ts
// Union of Collections
type UoC = string[] | number[] | TextItem[] | ImageItem[];

// Collection of Unions
type CoU = (string | number | TextItem | ImageItem)[];
```

Collections of unions are actually completely fine, given they follow the previously established rules around `typename` for objects. But the reverse is difficult because of the potential for overlapping unions. Consider:

```ts
type Overlapping = (string | number)[] | (string | boolean)[];
```

This type gives us a few problems:

- If we receive an array of _only_ strings, which type is it? We can't tell based on the value alone.
- If we receive an array with a number, many strings, and then a boolean, how do we maintain the context that we've already selected into one of the types?
- For even more complex type unions with more complex overlapping, how do we narrow progressively as we're parsing?

In other words, this is a can of worms for a behavior that is _fairly_ niche, and which can be solved (perhaps less ideally) by using a Collection of Unions instead. This leads to the _second_ major restriction Fetchium places on unions

> **Unions may only contain one type of each collection (records and arrays).** Unions may contain a record type and/or an array type, along with any number of primitive types and discriminated object types. But they cannot contain _more_ than one record or array type.

Some examples of valid and invalid collection unions:

```ts
// ✅ Valid, array of unions
t.array(t.union(t.string, t.number));

// ✅ Valid, primitive + 1 array type
t.union(t.string, t.array(t.string));

// ✅ 1 array type + 1 record type
t.union(t.array(t.string), t.record(t.string));

// ✅ 1 array type + 1 record type
t.union(
  t.array(t.union(t.string, t.number)),
  t.record(t.union(t.string, t.number)),
);

// ✅ Valid, primitive + 1 array type + object type
t.union(t.string, t.array(t.string), t.object({ prop: t.string }));

// 🛑 Invalid, 2 array types
t.union(t.array(t.string), t.array(t.number));

// 🛑 Invalid, 2 record types
t.union(t.record(t.string), t.record(t.number));
```

## Formatted Values

Formats transform raw JSON values into richer types during parsing and serialize them back for caching. Two formats are included by default, matching the OpenAPI spec for formats:

| Format        | Raw type | Parsed type | Description                |
| ------------- | -------- | ----------- | -------------------------- |
| `'date'`      | `string` | `Date`      | `YYYY-MM-DD` parsed as UTC |
| `'date-time'` | `string` | `Date`      | ISO 8601 string to Date    |

```tsx
startDate = t.format('date');
createdAt = t.format('date-time');
```

Register custom formats with `registerFormat()`:

```tsx
import { registerFormat, Mask } from 'fetchium';

registerFormat(
  'currency',
  Mask.STRING,
  (raw) => parseFloat(raw.replace(/[$,]/g, '')),
  (value) => `$${value.toFixed(2)}`,
);

// Then use it:
price = t.format('currency');
```

To add TypeScript types for custom formats, use module augmentation:

```ts
declare global {
  namespace SignaliumQuery {
    interface FormatRegistry {
      'my-format': MyType;
    }
  }
}
```

By default, formats are parsed eagerly. Pass `{ eager: false }` to defer parsing until the field is first read.
