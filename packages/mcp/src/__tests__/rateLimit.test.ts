import { describe, it, expect } from "vitest";
import { RateLimiter } from "../middleware/rateLimit.js";

describe("RateLimiter", () => {
  it("allows requests within limits", () => {
    const limiter = new RateLimiter({ rpm: 60, burst: 5 }, { rpm: 30, burst: 3 });
    expect(limiter.check("test_tool", "read")).toBe(true);
    expect(limiter.check("test_tool", "read")).toBe(true);
  });

  it("blocks requests when burst exceeded", () => {
    const limiter = new RateLimiter({ rpm: 60, burst: 2 }, { rpm: 30, burst: 1 });
    expect(limiter.check("test_tool", "read")).toBe(true);
    expect(limiter.check("test_tool", "read")).toBe(true);
    expect(limiter.check("test_tool", "read")).toBe(false);
  });

  it("uses separate buckets for read and write", () => {
    const limiter = new RateLimiter({ rpm: 60, burst: 1 }, { rpm: 30, burst: 1 });
    expect(limiter.check("test_tool", "read")).toBe(true);
    expect(limiter.check("test_tool", "read")).toBe(false);
    // У записи своя корзина
    expect(limiter.check("test_tool", "write")).toBe(true);
  });

  it("uses separate buckets per tool name", () => {
    const limiter = new RateLimiter({ rpm: 60, burst: 1 }, { rpm: 30, burst: 1 });
    expect(limiter.check("tool_a", "read")).toBe(true);
    expect(limiter.check("tool_a", "read")).toBe(false);
    // У другого инструмента своя корзина
    expect(limiter.check("tool_b", "read")).toBe(true);
  });

  it("applies different limits for read vs write", () => {
    const limiter = new RateLimiter({ rpm: 120, burst: 3 }, { rpm: 30, burst: 1 });
    // У чтения burst 3
    expect(limiter.check("tool", "read")).toBe(true);
    expect(limiter.check("tool", "read")).toBe(true);
    expect(limiter.check("tool", "read")).toBe(true);
    expect(limiter.check("tool", "read")).toBe(false);
    // У записи burst 1
    expect(limiter.check("tool", "write")).toBe(true);
    expect(limiter.check("tool", "write")).toBe(false);
  });
});
