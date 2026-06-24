import type { BatchFile } from "./types.js";

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
function byteLength(s: string): number {
  return encoder.encode(s).length;
}

/**
 * A durable (or in-memory fallback) event queue.
 *
 * A "batch" is a sealed group of events that maps to exactly one HTTP request.
 * Pending events are appended to a "current" buffer; sealing moves them into an
 * uploadable, ordered batch.
 */
export interface EventStore {
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
export class LocalStorageEventStore implements EventStore {
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
export class InMemoryEventStore implements EventStore {
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
export function buildStore(apiKey: string, debug: boolean): EventStore {
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
