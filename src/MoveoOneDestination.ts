import type { Analytics, Context, Plugin } from "@segment/analytics-next";
import {
  DEFAULTS,
  type MoveoOneOptions,
  type ResolvedOptions,
  type SendResult,
} from "./types.js";
import { buildStore, type EventStore } from "./store.js";

/** The Segment event payload carried by a `Context`. */
type EventPayload = Context["event"];

const encoder = new TextEncoder();

// Segment-style payload limits — keep a single event and a single request
// comfortably under the Tracking API's 32 KB / 500 KB caps.
const MAX_EVENT_BYTES = 32_000;
const MAX_REQUEST_BYTES = 475_000;

// Exponential backoff parameters.
const BACKOFF_BASE_SEC = 1.0;
const BACKOFF_MAX_SEC = 300.0;
const BACKOFF_JITTER = 0.2;

/**
 * Moveo One Destination Plugin for Segment Analytics (analytics-next / Web).
 *
 * Intercepts all Segment events and forwards them to the Moveo One API, so you
 * can use a single Segment instrumentation to feed both Segment and Moveo One.
 *
 * Production behaviour:
 *  • Durability — events are written to `localStorage` before the network is
 *    touched, so they survive page reloads and crashes. They are deleted only
 *    after the server confirms receipt (HTTP 2xx). When `localStorage` is
 *    unavailable the plugin transparently falls back to an in-memory store.
 *  • Batching — events accumulate until `batchSize` is reached, a size limit is
 *    hit, the `flushIntervalMs` timer fires, or the page is hidden/unloaded.
 *  • Retries — failed uploads retry with exponential backoff + jitter. HTTP 429
 *    and a `Retry-After` header are honoured. 5xx/network errors retry; non-429
 *    4xx are treated as permanent and dropped. A batch is dropped after
 *    `maxRetries` attempts so one poison batch can't block the queue forever.
 *  • Bounded — the queue is capped by `maxQueueBytes`/`maxQueueAgeMs`; when over
 *    budget the OLDEST batches are evicted.
 *
 * Delivery is at-least-once: after a crash a batch may be sent twice. The backend
 * de-duplicates on `messageId`, which is included on every event.
 */
export class MoveoOneDestination implements Plugin {
  readonly name = "Moveo One";
  readonly type = "enrichment" as const;
  readonly version = "1.0.0";

  private readonly options: ResolvedOptions;

  // Durable (or in-memory fallback) event queue. Initialised in load().
  private store!: EventStore;
  private loaded = false;

  // Retry/backoff state.
  private consecutiveFailures = 0;
  private nextAllowedSendAtMs = 0;

  // Guard so overlapping flushes never run concurrently (the browser is
  // single-threaded, but flush I/O is async), serializing all store + network
  // access.
  private flushing = false;
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private onVisibilityChange?: () => void;
  private onPageHide?: () => void;

  constructor(options: MoveoOneOptions) {
    if (!options || !options.apiKey) {
      throw new Error("[MoveoOne] `apiKey` is required");
    }
    this.options = {
      apiKey: options.apiKey,
      endpoint: options.endpoint ?? DEFAULTS.endpoint,
      debug: options.debug ?? DEFAULTS.debug,
      gzip: options.gzip ?? DEFAULTS.gzip,
      batchSize: options.batchSize ?? DEFAULTS.batchSize,
      flushIntervalMs: options.flushIntervalMs ?? DEFAULTS.flushIntervalMs,
      maxQueueBytes: options.maxQueueBytes ?? DEFAULTS.maxQueueBytes,
      maxQueueAgeMs: options.maxQueueAgeMs ?? DEFAULTS.maxQueueAgeMs,
      maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
      filter: options.filter,
    };
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lifecycle — runs when the plugin is registered with analytics-next.
  // ──────────────────────────────────────────────────────────────────────────

  async load(_ctx: Context, _instance: Analytics): Promise<void> {
    this.store = buildStore(this.options.apiKey, this.options.debug);
    this.registerLifecycle();

    // Seal any leftover partial buffer from a previous load and try to flush.
    void this.flush();
    this.flushTimer = setInterval(() => void this.flush(), this.options.flushIntervalMs);

    this.loaded = true;
  }

  async unload(): Promise<void> {
    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (typeof document !== "undefined" && this.onVisibilityChange) {
      document.removeEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined" && this.onPageHide) {
      window.removeEventListener("pagehide", this.onPageHide);
    }
    await this.flush();
    this.loaded = false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Segment plugin overrides — intercept every event and forward a copy. The
  // context is returned unchanged so the rest of the Segment pipeline is intact.
  // ──────────────────────────────────────────────────────────────────────────

  track(ctx: Context): Context {
    this.ship(ctx.event);
    return ctx;
  }

  page(ctx: Context): Context {
    this.ship(ctx.event);
    return ctx;
  }

  screen(ctx: Context): Context {
    this.ship(ctx.event);
    return ctx;
  }

  identify(ctx: Context): Context {
    this.ship(ctx.event);
    return ctx;
  }

  group(ctx: Context): Context {
    this.ship(ctx.event);
    return ctx;
  }

  alias(ctx: Context): Context {
    this.ship(ctx.event);
    return ctx;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Immediately flushes the pending batch and any queued events.
   * Called automatically on the interval timer and when the page is hidden.
   */
  async flush(): Promise<void> {
    await this.doFlush();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ──────────────────────────────────────────────────────────────────────────

  private ship(event: EventPayload): void {
    if (!this.passesFilter(event)) return;
    const body = JSON.stringify(this.buildPayload(event));

    if (byteLength(body) > MAX_EVENT_BYTES) {
      if (this.options.debug)
        console.warn(
          `[MoveoOne] Event ${event.messageId} is too large (${body.length} chars) — skipped`,
        );
      return;
    }

    try {
      this.store.append(body);
      if (
        this.store.currentCount() >= this.options.batchSize ||
        this.store.currentBytes() >= MAX_REQUEST_BYTES
      ) {
        void this.flush();
      }
    } catch (e) {
      if (this.options.debug) console.warn("[MoveoOne] Failed to enqueue event", e);
    }
  }

  /**
   * Seals the pending events into a batch and uploads everything that is due.
   * Guarded so only one flush runs at a time.
   */
  private async doFlush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      try {
        this.store.sealCurrent();
      } catch (e) {
        if (this.options.debug) console.warn("[MoveoOne] Seal failed", e);
      }

      const now = Date.now();
      if (now < this.nextAllowedSendAtMs) {
        if (this.options.debug)
          console.debug(
            `[MoveoOne] Backing off — skipping uploads for ${this.nextAllowedSendAtMs - now}ms`,
          );
        return;
      }

      this.store.enforceLimits(
        this.options.maxQueueBytes,
        this.options.maxQueueAgeMs,
        this.options.debug,
      );

      for (const batch of this.store.batches()) {
        if (batch.events.length === 0) {
          this.store.delete(batch);
          continue;
        }
        const result = await this.postBatch(batch.events);
        if (result.kind === "success") {
          this.store.delete(batch);
          this.onSendSuccess();
          if (this.options.debug)
            console.debug(`[MoveoOne] Sent batch ${batch.id} (${batch.events.length} events)`);
        } else if (result.kind === "permanent") {
          this.store.delete(batch);
          if (this.options.debug)
            console.warn(
              `[MoveoOne] Dropped batch ${batch.id} — HTTP ${result.code} (non-retryable)`,
            );
        } else {
          const nextAttempt = batch.attempts + 1;
          if (nextAttempt > this.options.maxRetries) {
            this.store.delete(batch);
            if (this.options.debug)
              console.warn(
                `[MoveoOne] Dropped batch ${batch.id} after ${this.options.maxRetries} failed attempts`,
              );
            continue;
          }
          this.store.bumpAttempt(batch);
          this.onSendFailure(result.retryAfterSec);
          if (this.options.debug)
            console.warn(
              `[MoveoOne] Batch ${batch.id} failed (attempt ${nextAttempt}) — backing off`,
            );
          return; // respect the backoff window before trying anything else
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private onSendSuccess(): void {
    this.consecutiveFailures = 0;
    this.nextAllowedSendAtMs = 0;
  }

  private onSendFailure(retryAfterSec: number | null): void {
    this.consecutiveFailures++;
    let delaySec: number;
    if (retryAfterSec !== null && retryAfterSec > 0) {
      delaySec = retryAfterSec;
    } else {
      const expo = BACKOFF_BASE_SEC * Math.pow(2, this.consecutiveFailures - 1);
      const capped = Math.min(expo, BACKOFF_MAX_SEC);
      delaySec = capped + capped * BACKOFF_JITTER * Math.random();
    }
    this.nextAllowedSendAtMs = Date.now() + Math.floor(delaySec * 1000);
  }

  /**
   * Returns true if the event should be forwarded to Moveo One.
   * When no filter is set all events pass. When a filter is set, all specified
   * key/value conditions must match against the event's properties or traits.
   */
  private passesFilter(event: EventPayload): boolean {
    const filter = this.options.filter;
    if (!filter || Object.keys(filter).length === 0) return true;

    let bag: Record<string, unknown> | undefined;
    switch (event.type) {
      case "track":
      case "page":
      case "screen":
        bag = event.properties as Record<string, unknown> | undefined;
        break;
      case "identify":
      case "group":
        bag = event.traits as Record<string, unknown> | undefined;
        break;
      default:
        return true;
    }
    const properties = bag ?? {};

    return Object.entries(filter).every(([key, allowedValues]) => {
      const value = properties[key];
      if (value === null || value === undefined) return false;
      // Only primitive values count (string / number / boolean), matched as strings.
      if (typeof value === "object") return false;
      return allowedValues.includes(String(value));
    });
  }

  /**
   * Builds the JSON body sent to the Moveo One API.
   * Follows the Segment event spec so the same fields are available on both sides.
   */
  private buildPayload(event: EventPayload): Record<string, unknown> {
    const out: Record<string, unknown> = {
      type: String(event.type).toLowerCase(),
      messageId: event.messageId,
      anonymousId: event.anonymousId,
      timestamp: normalizeTimestamp(event.timestamp),
      originalTimestamp: normalizeTimestamp(event.timestamp),
    };

    if (typeof event.userId === "string" && event.userId.trim().length > 0) {
      out["userId"] = event.userId;
    }

    out["context"] = event.context;
    out["integrations"] = event.integrations;

    switch (event.type) {
      case "track":
        out["event"] = event.event;
        out["properties"] = event.properties;
        break;
      case "page":
      case "screen":
        out["name"] = event.name;
        out["properties"] = event.properties;
        break;
      case "identify":
        out["traits"] = event.traits;
        break;
      case "group":
        out["groupId"] = event.groupId;
        out["traits"] = event.traits;
        break;
      default:
        // alias — common fields above are sufficient
        break;
    }

    return out;
  }

  private async postBatch(events: string[]): Promise<SendResult> {
    const sentAt = new Date().toISOString();
    const wrapped = events.map((raw) => {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(obj, "sentAt")) return obj;
      return { ...obj, sentAt };
    });
    const body = JSON.stringify({ events: wrapped });
    return this.sendRequest(body);
  }

  private async sendRequest(body: string): Promise<SendResult> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: this.options.apiKey,
    };

    let payload: BodyInit = body;
    if (this.options.gzip) {
      const gzipped = await gzip(body);
      if (gzipped) {
        payload = gzipped;
        headers["Content-Encoding"] = "gzip";
      }
    }

    if (this.options.debug) {
      console.debug("[MoveoOne] ──────────────────────────────────────");
      console.debug(
        `[MoveoOne] → POST ${this.options.endpoint}${headers["Content-Encoding"] ? " (gzip)" : ""}`,
      );
      console.debug(`[MoveoOne] → Authorization: ${this.options.apiKey.slice(0, 8)}…`);
      console.debug(`[MoveoOne] → Body: ${body}`);
    }

    let res: Response;
    try {
      res = await fetch(this.options.endpoint, {
        method: "POST",
        headers,
        body: payload,
        // keepalive lets in-flight requests complete during page unload.
        keepalive: true,
      });
    } catch (e) {
      if (this.options.debug) console.warn("[MoveoOne] Network error while uploading", e);
      return { kind: "retryable", retryAfterSec: null };
    }

    const code = res.status;
    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));

    if (this.options.debug) {
      const responseBody = await res.text().catch(() => "(empty)");
      console.debug(`[MoveoOne] ← HTTP ${code}`);
      console.debug(`[MoveoOne] ← Response: ${responseBody || "(empty)"}`);
      console.debug("[MoveoOne] ──────────────────────────────────────");
    }

    if (code >= 200 && code <= 299) return { kind: "success" };
    if (code === 429) return { kind: "retryable", retryAfterSec: retryAfter };
    if (code >= 500 && code <= 599) return { kind: "retryable", retryAfterSec: retryAfter };
    if (code >= 400 && code <= 499) return { kind: "permanent", code };
    return { kind: "retryable", retryAfterSec: retryAfter };
  }

  private registerLifecycle(): void {
    // Flush when the page is hidden or unloaded so queued events aren't lost.
    if (typeof document !== "undefined") {
      this.onVisibilityChange = () => {
        if (document.visibilityState === "hidden") void this.flush();
      };
      document.addEventListener("visibilitychange", this.onVisibilityChange);
    }
    if (typeof window !== "undefined") {
      this.onPageHide = () => void this.flush();
      window.addEventListener("pagehide", this.onPageHide);
    }
  }
}

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/** Normalises a Segment timestamp (Date | string | undefined) to an ISO string. */
function normalizeTimestamp(ts: unknown): string | undefined {
  if (ts === undefined || ts === null) return undefined;
  if (ts instanceof Date) return ts.toISOString();
  return String(ts);
}

/** Parses a `Retry-After` header value (delta-seconds) into a number, or null. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const n = parseInt(value.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Gzip-compresses a string via `CompressionStream` when available. Returns null
 * when compression is unsupported so the caller can send plain JSON instead.
 */
async function gzip(s: string): Promise<Blob | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([s]).stream().pipeThrough(new CompressionStream("gzip"));
    return await new Response(stream).blob();
  } catch {
    return null;
  }
}
