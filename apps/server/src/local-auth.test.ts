// @vitest-environment node
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";
import { createLocalAuthMiddleware, generateToken } from "./local-auth.js";

function makeReq(headers: Record<string, string> = {}): Request {
  return { headers, method: "POST" } as unknown as Request;
}

function makeRes() {
  let statusCode = 200;
  const res = {
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(_body: unknown) {
      return res;
    },
    get statusCode() {
      return statusCode;
    },
  };
  return res as unknown as Response;
}

describe("generateToken", () => {
  it("returns a non-empty string", () => {
    const token = generateToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(10);
  });

  it("returns different values on each call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe("createLocalAuthMiddleware", () => {
  it("calls next() when correct token is present", () => {
    const token = "test-token-abc";
    const middleware = createLocalAuthMiddleware(token);
    const req = makeReq({ "x-pathlight-token": token });
    const res = makeRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it("returns 401 when token is missing", () => {
    const middleware = createLocalAuthMiddleware("test-token-abc");
    const req = makeReq({});
    const res = makeRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when token is wrong", () => {
    const middleware = createLocalAuthMiddleware("correct-token");
    const req = makeReq({ "x-pathlight-token": "wrong-token" });
    const res = makeRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
