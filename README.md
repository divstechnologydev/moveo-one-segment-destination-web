# Moveo One — Segment Destination Plugin (Web / TypeScript)

A Segment destination plugin that forwards every Segment event to Moveo One, so both platforms receive identical event data from a single instrumentation.

Built for Segment's [`@segment/analytics-next`](https://github.com/segmentio/analytics-next) browser SDK.

Three ways to use it:

- **npm package** — `npm install moveo-one-segment-destination-web` (see below).
- **Script tag** — for sites that load Segment with the JavaScript snippet and have no build step. See [Usage with the Segment snippet](#usage-with-the-segment-snippet-script-tag).
- **Copy-paste single file** — drop [`standalone/MoveoOneDestination.ts`](standalone/MoveoOneDestination.ts) into your project, no dependency to install. See [standalone/README.md](standalone/README.md).

---

## Requirements

- [`@segment/analytics-next`](https://github.com/segmentio/analytics-next) `1.x+`

---

## Installation

```bash
npm install moveo-one-segment-destination-web
```

---

## Usage

Initialise Segment as you normally would, then register the plugin. That's it — every `track`, `page`, `screen`, `identify`, `group`, and `alias` call is forwarded to Moveo One automatically.

```ts
import { AnalyticsBrowser } from "@segment/analytics-next";
import { moveoOneDestination } from "moveo-one-segment-destination-web";

export const analytics = AnalyticsBrowser.load({ writeKey: "YOUR_SEGMENT_WRITE_KEY" });

analytics.register(moveoOneDestination({ apiKey: "YOUR_MOVEO_API_KEY" }));
```

---

## Usage with the Segment snippet (script tag)

If your site loads Segment with the JavaScript snippet instead of the npm SDK, add these two tags directly after the snippet:

```html
<script src="https://cdn.jsdelivr.net/npm/moveo-one-segment-destination-web@1/dist/index.global.js"></script>
<script>
  analytics.register(
    MoveoOneSegment.moveoOneDestination({ apiKey: "YOUR_MOVEO_API_KEY" })
  );
</script>
```

Every `track`, `page`, `screen`, `identify`, `group`, and `alias` call is then forwarded to Moveo One. All [configuration](#configuration) options work the same way.

- **Do not add `async` or `defer`** to the first tag. The second tag needs `MoveoOneSegment` to exist when it runs. If your first page view is missing in Moveo One, move the first tag above the Segment snippet.
- **Custom global name.** If your snippet stores Segment under another name, call `register` on that object, for example `window.myAnalytics.register(...)`.
- **Older snippets.** `register` must be in the snippet's method list (snippet 5.x). If it is not, update your snippet from the Segment dashboard.
- **Content Security Policy.** Allow `https://cdn.jsdelivr.net` in `script-src` and `https://api.moveo.one` in `connect-src`.
- **Self-hosting.** You can copy `dist/index.global.js` to your own server and point the first tag at it instead of the CDN.

---

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `apiKey` | `string` | — | **Required.** Your Moveo One API key (sent as the `Authorization` header). |
| `endpoint` | `string` | Production URL | Override the ingestion endpoint. |
| `debug` | `boolean` | `false` | Log request and response details to the console. |
| `gzip` | `boolean` | `true` | Gzip-compress upload bodies (`Content-Encoding: gzip`) via `CompressionStream`. Falls back to plain JSON when unsupported. |
| `batchSize` | `number` | `20` | Number of events that trigger an immediate flush. |
| `flushIntervalMs` | `number` | `30000` | How often the batch is flushed automatically (ms). |
| `maxQueueBytes` | `number` | `5000000` | Max bytes of queued events held in storage. When exceeded, the oldest batches are evicted. |
| `maxQueueAgeMs` | `number` | `604800000` | Max age (ms) of a queued batch before it is evicted (default 7 days). |
| `maxRetries` | `number` | `10` | Max upload attempts for a batch before it is dropped. |
| `filter` | `Record<string, string[]>` | `undefined` | Property filter — see [Filtering events](#filtering-events) below. |

> Most apps never set any of these. The one knob you may want is `flushIntervalMs` or `batchSize`. Everything else has production defaults.

```ts
analytics.register(
  moveoOneDestination({
    apiKey: "YOUR_MOVEO_API_KEY",
    debug: true, // enable console output during development
  }),
);
```

---

## Reliability & delivery

- **Durable queue** — events are written to `localStorage` *before* any network call, so they survive page reloads and crashes. They are deleted only after the server confirms receipt (HTTP `2xx`). If `localStorage` is unavailable (e.g. SSR, private mode, or a hardened CSP), the plugin transparently falls back to an in-memory queue.
- **Batching & flushing** — events are sent when `batchSize` is reached, a request-size limit is hit, the `flushIntervalMs` timer fires, or the page is hidden/unloaded (`visibilitychange` / `pagehide`, using `fetch` `keepalive`).
- **Smart retries** — failed uploads retry with exponential backoff + jitter. HTTP `429` and the `Retry-After` header are honoured; `5xx`/network errors retry; non-`429` `4xx` responses are treated as permanent and dropped. A batch is dropped after `maxRetries` attempts so one bad batch can't block the queue.
- **Bounded** — the queue is capped by `maxQueueBytes` and `maxQueueAgeMs`; when over budget the **oldest** batches are evicted (logged when `debug = true`).
- **Compression** — uploads are gzip-compressed by default (`Content-Encoding: gzip`). The backend handles both gzip and plain JSON; set `gzip = false` to disable.

> **Delivery is at-least-once.** After a crash a batch may be sent twice. Each event carries a stable `messageId`; the Moveo One backend de-duplicates on it.

---

## Filtering events

By default every event is forwarded. Pass a `filter` object to forward only events whose properties or traits match your criteria.

Each entry is a condition: `propertyName: [allowedValue1, allowedValue2, ...]`.
When multiple entries are provided **all conditions must match** (AND logic).
Events that do not match are dropped immediately and never queued.

**Forward only events with a specific property value**

```ts
moveoOneDestination({
  apiKey: "YOUR_MOVEO_API_KEY",
  filter: { category: ["purchase"] },
});
```

**Combine multiple conditions — all must match**

```ts
moveoOneDestination({
  apiKey: "YOUR_MOVEO_API_KEY",
  filter: {
    category: ["purchase", "subscription"],
    currency: ["USD", "EUR"],
  },
});
```

> **Note:** The filter checks `properties` for `track`, `page`, and `screen` events, and `traits` for `identify` and `group` events. Events where a required property is missing or is not a primitive value (string / number / boolean) are dropped.

---

## Event types

| Segment call | Forwarded |
|---|---|
| `analytics.track(...)` | ✅ |
| `analytics.page(...)` | ✅ |
| `analytics.screen(...)` | ✅ |
| `analytics.identify(...)` | ✅ |
| `analytics.group(...)` | ✅ |
| `analytics.alias(...)` | ✅ common fields only |

> `alias` is an advanced call used to merge two user identities. Only the common Segment fields are forwarded.

---

## Development

```bash
npm install
npm run build      # bundles ESM + CJS + script-tag build (index.global.js) + type declarations into dist/
npm run typecheck  # type-checks without emitting
```
