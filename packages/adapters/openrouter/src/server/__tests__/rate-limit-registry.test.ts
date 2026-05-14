import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearAll,
  mark,
  peek,
  size,
} from "../rate-limit-registry.js";

describe("rate-limit-registry", () => {
  beforeEach(() => {
    clearAll();
    vi.useRealTimers();
  });

  it("returns null for an unknown (key, model) pair", () => {
    expect(peek("sk-or-v1-abc", "deepseek/deepseek-r1:free")).toBeNull();
  });

  it("mark + peek round-trips for the same key/model", () => {
    const future = Date.now() + 30_000;
    mark("sk-or-v1-abc", "deepseek/deepseek-r1:free", future, "test reason");
    const got = peek("sk-or-v1-abc", "deepseek/deepseek-r1:free");
    expect(got).not.toBeNull();
    expect(got?.resetAtMs).toBe(future);
    expect(got?.reason).toBe("test reason");
  });

  it("auto-expires entries whose resetAtMs has passed and removes them from the map", () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 4, 14, 12, 0, 0);
    vi.setSystemTime(now);
    mark("sk-or-v1-abc", "x:free", now + 1000, "soon");
    expect(peek("sk-or-v1-abc", "x:free")).not.toBeNull();
    expect(size()).toBe(1);
    vi.setSystemTime(now + 2000);
    expect(peek("sk-or-v1-abc", "x:free")).toBeNull();
    expect(size()).toBe(0);
  });

  it("never downgrades a later expiry to an earlier one", () => {
    const farFuture = Date.now() + 24 * 60 * 60 * 1000;
    const nearFuture = Date.now() + 60_000;
    mark("sk-or-v1-abc", "x:free", farFuture, "daily quota");
    mark("sk-or-v1-abc", "x:free", nearFuture, "per-minute limit");
    expect(peek("sk-or-v1-abc", "x:free")?.resetAtMs).toBe(farFuture);
    expect(peek("sk-or-v1-abc", "x:free")?.reason).toBe("daily quota");
  });

  it("upgrades the expiry when a later reset is observed", () => {
    const initial = Date.now() + 60_000;
    const later = Date.now() + 120_000;
    mark("sk-or-v1-abc", "x:free", initial, "first");
    mark("sk-or-v1-abc", "x:free", later, "second");
    expect(peek("sk-or-v1-abc", "x:free")?.resetAtMs).toBe(later);
    expect(peek("sk-or-v1-abc", "x:free")?.reason).toBe("second");
  });

  it("isolates entries by api key", () => {
    const future = Date.now() + 60_000;
    mark("sk-or-v1-aaa", "x:free", future, "key-A");
    expect(peek("sk-or-v1-aaa", "x:free")).not.toBeNull();
    expect(peek("sk-or-v1-bbb", "x:free")).toBeNull();
  });

  it("isolates entries by model", () => {
    const future = Date.now() + 60_000;
    mark("sk-or-v1-abc", "a:free", future, "model-A");
    expect(peek("sk-or-v1-abc", "a:free")).not.toBeNull();
    expect(peek("sk-or-v1-abc", "b:free")).toBeNull();
  });

  it("silently ignores marks with a non-future resetAtMs", () => {
    mark("sk-or-v1-abc", "x:free", Date.now() - 1000, "stale");
    expect(peek("sk-or-v1-abc", "x:free")).toBeNull();
    expect(size()).toBe(0);
  });

  it("truncates very long reasons to 200 chars to keep logs sane", () => {
    const future = Date.now() + 60_000;
    const longReason = "x".repeat(500);
    mark("sk-or-v1-abc", "x:free", future, longReason);
    expect(peek("sk-or-v1-abc", "x:free")?.reason.length).toBe(200);
  });
});
