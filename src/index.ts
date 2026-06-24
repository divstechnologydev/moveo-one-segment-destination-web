import type { Plugin } from "@segment/analytics-next";
import { MoveoOneDestination } from "./MoveoOneDestination.js";
import type { MoveoOneOptions } from "./types.js";

export { MoveoOneDestination };
export type { MoveoOneOptions };

/**
 * Creates the Moveo One destination plugin for Segment's `@segment/analytics-next`.
 *
 * Every `track`, `page`, `screen`, `identify`, `group`, and `alias` call made
 * through Segment is forwarded to Moveo One, so a single instrumentation feeds
 * both platforms.
 *
 * @example
 * import { AnalyticsBrowser } from "@segment/analytics-next";
 * import { moveoOneDestination } from "moveo-one-segment-destination-web";
 *
 * export const analytics = AnalyticsBrowser.load({ writeKey: "YOUR_SEGMENT_WRITE_KEY" });
 * analytics.register(moveoOneDestination({ apiKey: "YOUR_MOVEO_API_KEY" }));
 */
export function moveoOneDestination(options: MoveoOneOptions): Plugin {
  return new MoveoOneDestination(options);
}
