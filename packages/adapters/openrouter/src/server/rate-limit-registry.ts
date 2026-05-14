/**
 * Module-scoped rate-limit registry for OpenRouter.
 *
 * When OpenRouter returns 429 for a particular API key + model pair, callers
 * record the reset timestamp here. Subsequent runs check `peek()` before
 * burning a network round-trip, short-circuiting to a transient-retry
 * AdapterExecutionResult that Paperclip's heartbeat reschedules at the
 * registered reset time.
 *
 * State is in-memory and per-process. Lost on restart — fine, because the
 * first post-restart call will hit OpenRouter, observe the 429, and re-mark.
 * If/when Paperclip becomes multi-process, replace the Map with a shared
 * store (Redis/DB) — the public surface stays the same.
 */

import { createHash } from "node:crypto";

interface RateLimitEntry {
  resetAtMs: number;
  reason: string;
  markedAt: number;
}

const entries = new Map<string, RateLimitEntry>();

function hashApiKey(apiKey: string): string {
  // 8 hex chars (32 bits) is plenty to distinguish keys without leaking the
  // key itself when the registry contents end up in logs or telemetry.
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 8);
}

function buildKey(apiKey: string, model: string): string {
  return `${hashApiKey(apiKey)}::${model}`;
}

/**
 * Record a rate-limit for a (key, model) pair. If an entry already exists
 * with a LATER expiry, this call is a no-op — a 60-second per-minute limit
 * must never shorten an already-recorded 24-hour daily limit.
 */
export function mark(
  apiKey: string,
  model: string,
  resetAtMs: number,
  reason: string,
): void {
  if (!Number.isFinite(resetAtMs) || resetAtMs <= Date.now()) return;
  const k = buildKey(apiKey, model);
  const existing = entries.get(k);
  if (existing && existing.resetAtMs >= resetAtMs) return;
  entries.set(k, {
    resetAtMs,
    reason: reason.slice(0, 200),
    markedAt: Date.now(),
  });
}

/**
 * Return the active rate-limit for a (key, model) pair, or null when not
 * rate-limited. Auto-expires entries whose resetAtMs has passed.
 */
export function peek(
  apiKey: string,
  model: string,
): { resetAtMs: number; reason: string } | null {
  const k = buildKey(apiKey, model);
  const entry = entries.get(k);
  if (!entry) return null;
  if (Date.now() >= entry.resetAtMs) {
    entries.delete(k);
    return null;
  }
  return { resetAtMs: entry.resetAtMs, reason: entry.reason };
}

/** Test-only — drop all entries. */
export function clearAll(): void {
  entries.clear();
}

/** Test-only — entry count, useful for asserting cleanup. */
export function size(): number {
  return entries.size;
}
