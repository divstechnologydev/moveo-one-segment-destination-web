# Moveo One — Segment Destination (single-file / copy-paste)

This folder is the **copy-paste** distribution of the plugin: the entire implementation in one
self-contained file, [`MoveoOneDestination.ts`](MoveoOneDestination.ts). Use this if you'd
rather not add a package dependency.

It is functionally identical to the npm package in the repo root — same behaviour, same options.

## Install

1. Copy [`MoveoOneDestination.ts`](MoveoOneDestination.ts) into your project, e.g.
   `src/analytics/MoveoOneDestination.ts`.
2. That's it. The only import is the **type** surface of `@segment/analytics-next` — the Segment
   SDK you already use. It's erased at compile time, so this adds **zero runtime dependencies**.

> Not using TypeScript? Run the file through your bundler/`tsc`, or ask for a plain `.js` version.

## Usage

```ts
import { AnalyticsBrowser } from "@segment/analytics-next";
import { moveoOneDestination } from "./analytics/MoveoOneDestination";

export const analytics = AnalyticsBrowser.load({ writeKey: "YOUR_SEGMENT_WRITE_KEY" });

analytics.register(moveoOneDestination({ apiKey: "YOUR_MOVEO_API_KEY" }));
```

See the [root README](../README.md) for the full configuration table, reliability details, and
event-filtering docs — all options apply identically here.
