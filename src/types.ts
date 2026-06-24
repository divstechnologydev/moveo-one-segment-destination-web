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

/** Fully-resolved options with all defaults applied. */
export interface ResolvedOptions {
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

export const DEFAULTS = {
  endpoint: "https://api.moveo.one/api/analytic/external/segment-destination",
  debug: false,
  gzip: true,
  batchSize: 20,
  flushIntervalMs: 30_000,
  maxQueueBytes: 5_000_000,
  maxQueueAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxRetries: 10,
} as const;

/** A sealed group of events that maps to exactly one HTTP request. */
export interface BatchFile {
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

/** Result of a single upload attempt. */
export type SendResult =
  | { kind: "success" }
  | { kind: "permanent"; code: number }
  | { kind: "retryable"; retryAfterSec: number | null };
