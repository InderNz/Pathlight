// @vitest-environment node
import { describe, expect, it } from "vitest";
import { redactOutput } from "./redact.js";

describe("redactOutput", () => {
  it("redacts Bearer tokens in Authorization headers", () => {
    expect(redactOutput("authorization: bearer abc123xyz")).toBe(
      "authorization: bearer [REDACTED]",
    );
  });

  it("is case-insensitive for Authorization header", () => {
    expect(redactOutput("Authorization: Bearer SECRET_TOKEN")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  it("redacts api_key assignments", () => {
    expect(redactOutput("api_key=mySecretKey")).toBe("api_key=[REDACTED]");
  });

  it("redacts token= assignments", () => {
    expect(redactOutput("token=abc123")).toBe("token=[REDACTED]");
  });

  it("redacts password: assignments", () => {
    expect(redactOutput("password: hunter2")).toBe("password: [REDACTED]");
  });

  it("redacts secret= assignments", () => {
    expect(redactOutput("secret=my-secret-value")).toBe("secret=[REDACTED]");
  });

  it("leaves safe output untouched", () => {
    const safe = "Test passed in 1234ms\nExpect assertions: 3";
    expect(redactOutput(safe)).toBe(safe);
  });

  it("handles multiline output with mixed content", () => {
    const input = "stdout: starting\ntoken=supersecret\nstdout: done";
    const output = redactOutput(input);
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("supersecret");
    expect(output).toContain("stdout: starting");
    expect(output).toContain("stdout: done");
  });
});
