// @vitest-environment node
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("evidence summarise endpoint", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-evidence-"));
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "T", key: "T" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns a summary from mocked Claude for a failed journey", async () => {
    const callClaude = async ({ userContent }: { system: string; userContent: string }) => {
      return `The test was verifying that ${userContent.includes("Submit review") ? "the review submission flow" : "something"}. It completed 2 steps before failing.`;
    };
    const app = createApp({ projectRoot, callClaude });

    const res = await request(app)
      .post("/api/evidence/E2E-001/summarise")
      .send({
        attemptId: "attempt-001",
        steps: ["Navigate to review page", "Fill form"],
        error: "Timeout waiting for submit button",
        journeyLabel: "Submit review",
        branchType: "happy",
      });

    expect(res.status).toBe(200);
    expect(typeof res.body.summary).toBe("string");
    expect(res.body.summary.length).toBeGreaterThan(0);
  });

  it("returns 503 when AI is not configured", async () => {
    const app = createApp({ projectRoot });

    const res = await request(app).post("/api/evidence/E2E-001/summarise").send({
      attemptId: "attempt-001",
      steps: [],
      error: "error",
      journeyLabel: "Submit review",
      branchType: "happy",
    });

    expect(res.status).toBe(503);
  });

  it("returns 400 when attemptId is missing", async () => {
    const callClaude = async () => "summary";
    const app = createApp({ projectRoot, callClaude });

    const res = await request(app)
      .post("/api/evidence/E2E-001/summarise")
      .send({ steps: [], error: "error", journeyLabel: "Submit review", branchType: "happy" });

    expect(res.status).toBe(400);
  });
});
