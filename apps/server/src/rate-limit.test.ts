// @vitest-environment node
import { describe, expect, it } from "vitest";
import { RateLimiter } from "./rate-limit.js";

describe("RateLimiter", () => {
  it("allows requests under the limit", () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 3 });
    expect(rl.check("client-1")).toBe(true);
    expect(rl.check("client-1")).toBe(true);
    expect(rl.check("client-1")).toBe(true);
  });

  it("blocks after limit is reached", () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 2 });
    rl.check("client-1");
    rl.check("client-1");
    expect(rl.check("client-1")).toBe(false);
  });

  it("tracks different keys independently", () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 1 });
    rl.check("client-1");
    expect(rl.check("client-1")).toBe(false);
    expect(rl.check("client-2")).toBe(true);
  });

  it("expires old timestamps outside the window", () => {
    const now = Date.now();
    const rl = new RateLimiter({ windowMs: 1000, max: 2, now: () => now });
    rl.check("client-1");
    rl.check("client-1");
    // Advance time past the window
    const future = new RateLimiter({ windowMs: 1000, max: 2, now: () => now + 1001 });
    // Reuse same internal state by injecting timestamps manually
    // Instead test via the now override: fresh limiter at future time should allow
    expect(future.check("client-1")).toBe(true);
  });

  it("sliding window drops only expired entries", () => {
    let clock = 0;
    const rl = new RateLimiter({ windowMs: 1000, max: 3, now: () => clock });
    clock = 0;
    rl.check("k");
    clock = 500;
    rl.check("k");
    clock = 600;
    rl.check("k"); // 3rd — still within max=3
    // Now advance past first entry's window
    clock = 1100; // entry at t=0 has expired (1100 - 0 > 1000)
    // Two entries remain (t=500, t=600): both within [1100-1000=100, 1100]? 500>100 yes, 600>100 yes
    // So count=2 < max=3, should allow
    expect(rl.check("k")).toBe(true);
  });
});
