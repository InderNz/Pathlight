// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const MANIFEST = {
  schemaVersion: "1.0",
  projectKey: "PL",
  lockedAt: "2026-05-29T00:00:00.000Z",
  lockedBy: "dev@example.com",
  businessRules: [],
  nodes: [
    {
      id: "E2E-007",
      stage: "S2",
      stageName: "Core SMS Review Flow",
      module: "Review Flow",
      priority: "High",
      priorityRank: 2,
      label: "SMS gateway times out",
      risk: "high",
      storyTitle: "SMS gateway times out",
      storyHash: "abc",
      branchType: "system",
      tags: [],
      linkedStories: [],
      testFiles: [],
      schemaVersion: "1.0",
      projectKey: "PL",
    },
  ],
};

const MOCK_GENERATED = `import { test, expect } from '@playwright/test';

test('[E2E-007] SMS gateway times out', async ({ page }) => {
  await page.goto('/review'); // Selector assumption — verify against live UI
  expect(page).toBeTruthy();
});
`;

describe("US-V4-001 to US-V4-006 AI test generation", () => {
  let projectRoot: string;
  let testDir: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-gen-"));
    testDir = join(projectRoot, "tests/e2e");
    await mkdir(testDir, { recursive: true });
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "ZovKu", key: "ZOVK" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot,
        testDir: "tests/e2e",
      }),
    );
    await writeFile(join(projectRoot, "pathlight-manifest.json"), JSON.stringify(MANIFEST));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  const mockClaude = () => async () => MOCK_GENERATED;

  it("generates a test and saves it to testDir/generated/", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    const res = await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });

    expect(res.status).toBe(201);
    expect(res.body.journeyId).toBe("E2E-007");
    expect(res.body.qualityChecks.passed).toBe(true);
    expect(res.body.qualityChecks.hasJourneyId).toBe(true);
    expect(res.body.qualityChecks.hasExpect).toBe(true);
    expect(res.body.styleScore).toBeDefined();

    const savedContent = await readFile(join(testDir, "generated", "E2E-007.spec.ts"), "utf8");
    expect(savedContent).toContain("[E2E-007]");

    const meta = JSON.parse(
      await readFile(join(projectRoot, "pathlight-generated-tests.json"), "utf8"),
    );
    expect(meta.tests).toHaveLength(1);
    expect(meta.tests[0].journeyId).toBe("E2E-007");
    expect(meta.tests[0].status).toBe("pending");
  });

  it("returns 503 when ANTHROPIC_API_KEY is not set and no callClaude override", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    expect(res.status).toBe(503);
  });

  it("returns 400 when testDir is not configured", async () => {
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "ZovKu", key: "ZOVK" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot,
        // no testDir
      }),
    );
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    const res = await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("testDir");
  });

  it("returns 404 when journey is not in manifest", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    const res = await request(app).post("/api/generation/generate").send({ journeyId: "E2E-999" });
    expect(res.status).toBe(404);
  });

  it("retries generation when quality checks fail on first attempt", async () => {
    const badContent = "test('no brackets here', async () => { /* nothing */ });";
    let calls = 0;
    const flakyClaude = async () => {
      calls++;
      return calls === 1 ? badContent : MOCK_GENERATED;
    };
    const app = createApp({ projectRoot, callClaude: flakyClaude });
    const res = await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    expect(res.status).toBe(201);
    expect(calls).toBe(2);
    expect(res.body.qualityChecks.passed).toBe(true);
  });

  it("lists all generated tests without content", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    const res = await request(app).get("/api/generation");
    expect(res.status).toBe(200);
    expect(res.body.tests).toHaveLength(1);
    expect(res.body.tests[0].content).toBeUndefined();
    expect(res.body.tests[0].journeyId).toBe("E2E-007");
    expect(res.body.tests[0].status).toBe("pending");
  });

  it("gets a single generated test with content", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    const res = await request(app).get("/api/generation/E2E-007");
    expect(res.status).toBe(200);
    expect(res.body.content).toContain("[E2E-007]");
    expect(res.body.qualityChecks.passed).toBe(true);
  });

  it("updates content inline and recomputes quality checks", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    const edited = MOCK_GENERATED.replace("[E2E-007]", "wrong-id");
    const res = await request(app).patch("/api/generation/E2E-007").send({ content: edited });
    expect(res.status).toBe(200);
    expect(res.body.qualityChecks.hasJourneyId).toBe(false);
    expect(res.body.qualityChecks.passed).toBe(false);
  });

  it("regenerates a test with a hint", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    const res = await request(app)
      .post("/api/generation/E2E-007/regenerate")
      .send({ hint: "Use API mock for gateway" });
    expect(res.status).toBe(200);
    expect(res.body.qualityChecks).toBeDefined();
  });

  it("approves a test, saves to journeys/, updates mapping, and marks approved", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    // Mark as run-passed so the server-side gate allows approval
    const genPath = join(projectRoot, "pathlight-generated-tests.json");
    const genData = JSON.parse(await readFile(genPath, "utf8")) as {
      tests: Array<Record<string, unknown>>;
    };
    genData.tests[0].runPassed = true;
    await writeFile(genPath, JSON.stringify(genData, null, 2) + "\n", "utf8");
    const res = await request(app).post("/api/generation/E2E-007/approve");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const approvedContent = await readFile(join(testDir, "journeys", "E2E-007.spec.ts"), "utf8");
    expect(approvedContent).toContain("[E2E-007]");

    const mapping = JSON.parse(
      await readFile(join(projectRoot, "pathlight-test-mapping.json"), "utf8"),
    );
    const journey = mapping.mappings.find((m: { journeyId: string }) => m.journeyId === "E2E-007");
    expect(journey).toBeDefined();
    expect(journey.matchedTests[0].approved).toBe(true);
    expect(journey.matchedTests[0].generated).toBe(true);

    const meta = JSON.parse(
      await readFile(join(projectRoot, "pathlight-generated-tests.json"), "utf8"),
    );
    expect(meta.tests[0].status).toBe("approved");
  });

  it("discards a generated test and removes the file", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    await request(app).post("/api/generation/generate").send({ journeyId: "E2E-007" });
    const res = await request(app).delete("/api/generation/E2E-007");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const meta = JSON.parse(
      await readFile(join(projectRoot, "pathlight-generated-tests.json"), "utf8"),
    );
    expect(meta.tests).toHaveLength(0);
  });

  it("starts a batch and reports status", async () => {
    const app = createApp({ projectRoot, callClaude: mockClaude() });
    const batchRes = await request(app)
      .post("/api/generation/batch")
      .send({ journeyIds: ["E2E-007"] });
    expect(batchRes.status).toBe(202);
    expect(batchRes.body.batchId).toBeDefined();
    expect(batchRes.body.total).toBe(1);

    // Wait for batch to complete
    await new Promise((r) => setTimeout(r, 200));
    const statusRes = await request(app).get("/api/generation/batch-status");
    expect(statusRes.status).toBe(200);
    expect(["done", "running"]).toContain(statusRes.body.status);
  });
});
