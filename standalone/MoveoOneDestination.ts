/**
 * Moveo One Destination Plugin for Segment Analytics (analytics-next / Web).
 *
 * ──────────────────────────────────────────────────────────────────────────
 * SINGLE-FILE / COPY-PASTE VERSION
 *
 * Drop this one file into your project (e.g. `src/analytics/MoveoOneDestination.ts`)
 * — no extra package to install. The only import is the *type* surface of
 * `@segment/analytics-next`, which you already use and which is erased at compile
 * time, so this adds ZERO runtime dependencies.
 *
 * Usage:
 *
 *   import { AnalyticsBrowser } from "@segment/analytics-next";
 *   import { moveoOneDestination } from "./MoveoOneDestination";
 *
 *   export const analytics = AnalyticsBrowser.load({ writeKey: "YOUR_SEGMENT_WRITE_KEY" });
 *   analytics.register(moveoOneDestination({ apiKey: "YOUR_MOVEO_API_KEY" }));
 *
 * ──────────────────────────────────────────────────────────────────────────
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
import type { Analytics, Context, Plugin } from "@segment/analytics-next";

// ────────────────────────────────────────────────────────────────────────────
// Options & defaults
// ────────────────────────────────────────────────────────────────────────────

/**
 * Configuration for {@link moveoOneDestination}.
 *
 * Only `apiKey` is required; every other option has a production default.
 * Most apps never set any of the optional knobs.
 */
export interface MoveoOneOptions {
  /** Your Moveo One API key. Sent as the `Authorization` header on every request. */
  apiKey: string;
  /** Override the ingestion endpoint. */
  endpoint?: string;
  /** When true, request and response details are logged to the console. */
  debug?: boolean;
  /**
   * When true (default), upload bodies are gzip-compressed (via `CompressionStream`)
   * and sent with `Content-Encoding: gzip`. Falls back to plain JSON automatically
   * when the browser has no `CompressionStream`. Set false to always send plain JSON.
   */
  gzip?: boolean;
  /** Number of events that trigger an immediate flush (default 20). */
  batchSize?: number;
  /** How often the batch is flushed automatically, in ms (default 30000). */
  flushIntervalMs?: number;
  /**
   * Max bytes of queued events held in storage (default 5 MB). When exceeded, the
   * oldest batches are evicted.
   */
  maxQueueBytes?: number;
  /** Max age (ms) of a queued batch before it is evicted (default 7 days). */
  maxQueueAgeMs?: number;
  /** Max upload attempts for a batch before it is dropped (default 10). */
  maxRetries?: number;
  /**
   * Optional property filter. When provided, only events whose properties/traits
   * contain ALL specified keys with a matching value are forwarded. Undefined
   * (default) forwards every event.
   *
   * @example { category: ["purchase", "subscription"], currency: ["USD", "EUR"] }
   */
  filter?: Record<string, string[]>;
}

interface ResolvedOptions {
  apiKey: string;
  endpoint: string;
  debug: boolean;
  gzip: boolean;
  batchSize: number;
  flushIntervalMs: number;
  maxQueueBytes: number;
  maxQueueAgeMs: number;
  maxRetries: number;
  filter?: Record<string, string[]>;
}

const DEFAULTS = {
  endpoint: "https://api.moveo.one/api/analytic/external/segment-destination",
  debug: false,
  gzip: true,
  batchSize: 20,
  flushIntervalMs: 30_000,
  maxQueueBytes: 5_000_000,
  maxQueueAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxRetries: 10,
} as const;

/** The Segment event payload carried by a `Context`. */
type EventPayload = Context["event"];

// Segment-style payload limits — keep a single event and a single request
// comfortably under the Tracking API's 32 KB / 500 KB caps.
const MAX_EVENT_BYTES = 32_000;
const MAX_REQUEST_BYTES = 475_000;

// Exponential backoff parameters.
const BACKOFF_BASE_SEC = 1.0;
const BACKOFF_MAX_SEC = 300.0;
const BACKOFF_JITTER = 0.2;

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return encoder.encode(s).length;
}

// ────────────────────────────────────────────────────────────────────────────
// Event store — a durable, localStorage-backed queue with an in-memory fallback.
// A "batch" is a sealed group of events that maps to exactly one HTTP request.
// ────────────────────────────────────────────────────────────────────────────

/** A sealed group of events that maps to exactly one HTTP request. */
interface BatchFile {
  /** Identifier / storage key. */
  id: string;
  /** Monotonic ordering key. */
  seq: number;
  /** Failed upload attempts so far. */
  attempts: number;
  /** Creation time (epoch ms). */
  createdAtMs: number;
  /** Serialized events (one JSON string per event). */
  events: string[];
}

interface EventStore {
  /** Append one serialized event to the pending (not yet sealed) batch. */
  append(eventJson: string): void;
  currentCount(): number;
  currentBytes(): number;
  /** Seal the pending events into an uploadable batch. No-op if empty. */
  sealCurrent(): void;
  /** Sealed batches, oldest first. */
  batches(): BatchFile[];
  delete(batch: BatchFile): void;
  bumpAttempt(batch: BatchFile): void;
  /** Evict oldest batches that exceed the size/age budget. */
  enforceLimits(maxBytes: number, maxAgeMs: number, debug: boolean): void;
}

interface StoredBatch {
  seq: number;
  attempts: number;
  createdAtMs: number;
  events: string[];
}

/**
 * `localStorage`-backed store. Pending events live under `<prefix>:current`; on
 * seal they are written to `<prefix>:b:<seq>` and uploaded oldest-first, deleted
 * only after a confirmed send. Survives page reloads and crashes.
 */
class LocalStorageEventStore implements EventStore {
  private readonly prefix: string;
  private readonly seqKey: string;
  private readonly currentKey: string;
  private readonly batchPrefix: string;

  private current: string[] = [];
  private currentByteCount = 0;

  constructor(apiKey: string) {
    this.prefix = `moveo-one-segment/${hash(apiKey)}`;
    this.seqKey = `${this.prefix}:seq`;
    this.currentKey = `${this.prefix}:current`;
    this.batchPrefix = `${this.prefix}:b:`;

    // Restore any pending (unsealed) events left over from a previous page load.
    const raw = localStorage.getItem(this.currentKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as string[];
        this.current = Array.isArray(parsed) ? parsed : [];
      } catch {
        this.current = [];
      }
      this.currentByteCount = this.current.reduce((n, e) => n + byteLength(e), 0);
    }
  }

  append(eventJson: string): void {
    this.current.push(eventJson);
    this.currentByteCount += byteLength(eventJson);
    localStorage.setItem(this.currentKey, JSON.stringify(this.current));
  }

  currentCount(): number {
    return this.current.length;
  }

  currentBytes(): number {
    return this.currentByteCount;
  }

  sealCurrent(): void {
    if (this.current.length === 0) return;
    const seq = this.nextSeq();
    const key = `${this.batchPrefix}${pad(seq)}`;
    const batch: StoredBatch = {
      seq,
      attempts: 0,
      createdAtMs: Date.now(),
      events: this.current,
    };
    localStorage.setItem(key, JSON.stringify(batch));
    localStorage.removeItem(this.currentKey);
    this.current = [];
    this.currentByteCount = 0;
  }

  batches(): BatchFile[] {
    return this.sealedKeys()
      .map((key) => this.readBatch(key))
      .filter((b): b is BatchFile => b !== null)
      .sort((a, b) => a.seq - b.seq);
  }

  delete(batch: BatchFile): void {
    localStorage.removeItem(batch.id);
  }

  bumpAttempt(batch: BatchFile): void {
    const stored = this.readStored(batch.id);
    if (!stored) return;
    stored.attempts += 1;
    localStorage.setItem(batch.id, JSON.stringify(stored));
  }

  enforceLimits(maxBytes: number, maxAgeMs: number, debug: boolean): void {
    const now = Date.now();

    // Age-based eviction.
    for (const key of this.sealedKeys()) {
      const stored = this.readStored(key);
      if (stored && now - stored.createdAtMs > maxAgeMs) {
        if (debug) console.warn(`[MoveoOne] Evicting aged batch ${key}`);
        localStorage.removeItem(key);
      }
    }

    // Size-based eviction — drop oldest until within budget.
    const remaining = this.sealedKeys()
      .map((key) => ({ key, stored: this.readStored(key) }))
      .filter((x): x is { key: string; stored: StoredBatch } => x.stored !== null)
      .sort((a, b) => a.stored.seq - b.stored.seq);

    let total = remaining.reduce(
      (n, x) => n + x.stored.events.reduce((m, e) => m + byteLength(e), 0),
      0,
    );
    let i = 0;
    while (total > maxBytes && i < remaining.length) {
      const x = remaining[i]!;
      total -= x.stored.events.reduce((m, e) => m + byteLength(e), 0);
      if (debug) console.warn(`[MoveoOne] Evicting over-budget batch ${x.key}`);
      localStorage.removeItem(x.key);
      i++;
    }
  }

  private nextSeq(): number {
    const seq = Number(localStorage.getItem(this.seqKey) ?? "0") || 0;
    localStorage.setItem(this.seqKey, String(seq + 1));
    return seq;
  }

  private sealedKeys(): string[] {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this.batchPrefix)) keys.push(key);
    }
    return keys;
  }

  private readStored(key: string): StoredBatch | null {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredBatch;
      if (!Array.isArray(parsed.events)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private readBatch(key: string): BatchFile | null {
    const stored = this.readStored(key);
    if (!stored) return null;
    return {
      id: key,
      seq: stored.seq,
      attempts: stored.attempts,
      createdAtMs: stored.createdAtMs,
      events: stored.events.filter((e) => e.trim().length > 0),
    };
  }
}

/**
 * In-memory fallback used when `localStorage` is unavailable (e.g. SSR, private
 * mode, or a hardened CSP). Events are NOT durable across page loads.
 */
class InMemoryEventStore implements EventStore {
  private current: string[] = [];
  private sealed: BatchFile[] = [];
  private seq = 0;
  private currentByteCount = 0;

  append(eventJson: string): void {
    this.current.push(eventJson);
    this.currentByteCount += byteLength(eventJson);
  }

  currentCount(): number {
    return this.current.length;
  }

  currentBytes(): number {
    return this.currentByteCount;
  }

  sealCurrent(): void {
    if (this.current.length === 0) return;
    const s = this.seq++;
    this.sealed.push({
      id: `mem-${s}`,
      seq: s,
      attempts: 0,
      createdAtMs: Date.now(),
      events: [...this.current],
    });
    this.current = [];
    this.currentByteCount = 0;
  }

  batches(): BatchFile[] {
    return [...this.sealed].sort((a, b) => a.seq - b.seq);
  }

  delete(batch: BatchFile): void {
    this.sealed = this.sealed.filter((b) => b.id !== batch.id);
  }

  bumpAttempt(batch: BatchFile): void {
    const idx = this.sealed.findIndex((b) => b.id === batch.id);
    if (idx >= 0) this.sealed[idx]!.attempts += 1;
  }

  enforceLimits(maxBytes: number, maxAgeMs: number, _debug: boolean): void {
    const now = Date.now();
    this.sealed = this.sealed.filter((b) => now - b.createdAtMs <= maxAgeMs);
    let total = this.sealed.reduce(
      (n, b) => n + b.events.reduce((m, e) => m + byteLength(e), 0),
      0,
    );
    while (total > maxBytes && this.sealed.length > 0) {
      const removed = this.sealed.shift()!;
      total -= removed.events.reduce((m, e) => m + byteLength(e), 0);
    }
  }
}

/**
 * Returns a durable `localStorage` store when available, otherwise an in-memory
 * fallback.
 */
function buildStore(apiKey: string, debug: boolean): EventStore {
  try {
    if (typeof localStorage === "undefined") throw new Error("no localStorage");
    // Probe that localStorage is actually writable (private mode can throw).
    const probe = "moveo-one-segment:probe";
    localStorage.setItem(probe, "1");
    localStorage.removeItem(probe);
    return new LocalStorageEventStore(apiKey);
  } catch (e) {
    if (debug)
      console.warn(
        "[MoveoOne] localStorage unavailable — using in-memory store (events are NOT durable)",
        e,
      );
    return new InMemoryEventStore();
  }
}

/** Zero-padded sequence key so lexical and numeric order agree. */
function pad(seq: number): string {
  return String(seq).padStart(12, "0");
}

/** Small, stable string hash (djb2-ish) used to namespace storage per API key. */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// ────────────────────────────────────────────────────────────────────────────
// Upload result
// ────────────────────────────────────────────────────────────────────────────

/** Result of a single upload attempt. */
type SendResult =
  | { kind: "success" }
  | { kind: "permanent"; code: number }
  | { kind: "retryable"; retryAfterSec: number | null };

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

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

/**
 * Creates the Moveo One destination plugin for Segment's `@segment/analytics-next`.
 *
 * Every `track`, `page`, `screen`, `identify`, `group`, and `alias` call made
 * through Segment is forwarded to Moveo One, so a single instrumentation feeds
 * both platforms.
 */
export function moveoOneDestination(options: MoveoOneOptions): Plugin {
  return new MoveoOneDestination(options);
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
