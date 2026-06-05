// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const header =
  "id,summary,priority,priorityRank,stage,stageName,branchType,labels,linkedStories,description\n";
const validCsv =
  header +
  'E2E-001,Owner sends single review request,Highest,1,S2,Core SMS Review Flow,happy,"@smoke,@critical",US-002,Request submitted\n' +
  "E2E-002,Recipient rejects request,High,2,S3,Review Decision,unhappy,@regression,US-003,Request rejected\n";

describe("US-P004 to US-P006 journey CSV and manifest lock", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-manifest-"));
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "ZovKu", key: "ZVK" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("downloads the fixed CSV template with the ordered header and one example row", async () => {
    const response = await request(createApp({ projectRoot })).get("/api/journeys/template");

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain("pathlight-journeys-template.csv");
    const lines = response.text.trim().split("\n");
    expect(lines[0]).toBe(header.trim());
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^#/);
    expect(lines[2]).toContain("E2E-001");
    expect(lines[2]).toContain("ZovKu");
    expect(lines[2]).toContain(",unhappy,");
  });

  it("validates valid CSV before import and reports stage and priority breakdowns", async () => {
    const response = await request(createApp({ projectRoot }))
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(validCsv), {
        filename: "journeys.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      valid: true,
      journeyCount: 2,
      stages: { S2: 1, S3: 1 },
      priorities: { Highest: 1, High: 1 },
    });
    await expect(readFile(join(projectRoot, "pathlight-manifest.json"))).rejects.toThrow();
  });

  it("rejects invalid file types, header omissions, duplicates and malformed fields with row details", async () => {
    const app = createApp({ projectRoot });
    const notCsv = await request(app)
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(validCsv), { filename: "journeys.txt" });
    expect(notCsv.status).toBe(400);
    expect(notCsv.body.errors).toEqual(["Only .csv files are accepted."]);

    const invalidCsv =
      "id,summary,priorityRank,stage,stageName,branchType\n" +
      "E2E-001,One,high,S2,Core,negative\n" +
      "E2E-001,Two,2,S2,Core,happy\n";
    const invalid = await request(app)
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(invalidCsv), { filename: "invalid.csv" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.errors).toContain("Required column 'priority' not found in header row.");
    expect(invalid.body.errors).toContain("Row 2: priorityRank 'high' must be a positive integer.");
    expect(invalid.body.errors).toContain(
      "Row 2: branchType 'negative' must be one of: happy, unhappy, edge, boundary, system.",
    );
    expect(invalid.body.errors).toContain("Duplicate id 'E2E-001' found on rows 2 and 3.");
  });

  it("imports a validated CSV as an unlocked draft manifest with stable hashes and renderer fields", async () => {
    const response = await request(createApp({ projectRoot }))
      .post("/api/journeys/import")
      .attach("journeys", Buffer.from(validCsv), {
        filename: "journeys.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(
      "2 journeys imported across 2 stages. Manifest ready to lock.",
    );
    const manifest = JSON.parse(
      await readFile(join(projectRoot, "pathlight-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: "1.0",
      projectKey: "ZVK",
      lockedAt: null,
      lockedBy: null,
      businessRules: [],
    });
    expect(manifest.nodes[0]).toMatchObject({
      id: "E2E-001",
      projectKey: "ZVK",
      stage: "S2",
      stageName: "Core SMS Review Flow",
      priority: "Highest",
      priorityRank: 1,
      risk: "critical",
      tags: ["@smoke", "@critical"],
      branchType: "happy",
    });
    expect(manifest.nodes[0].storyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("validates and locks a draft, protects it from re-import, then unlocks explicitly", async () => {
    const app = createApp({ projectRoot, identity: "dev@example.com" });
    await request(app)
      .post("/api/journeys/import")
      .attach("journeys", Buffer.from(validCsv), { filename: "journeys.csv" });
    const manifest = JSON.parse(
      await readFile(join(projectRoot, "pathlight-manifest.json"), "utf8"),
    );

    const locked = await request(app).post("/api/manifest/lock").send({ manifest });
    expect(locked.status).toBe(200);
    expect(locked.body.lockedBy).toBe("dev@example.com");
    expect(locked.body.lockedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const refusedImport = await request(app)
      .post("/api/journeys/import")
      .attach("journeys", Buffer.from(validCsv), { filename: "journeys.csv" });
    expect(refusedImport.status).toBe(409);

    const conflict = await request(app)
      .post("/api/manifest/lock")
      .send({ manifest, currentLockedAt: "stale" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("MANIFEST_LOCK_CONFLICT");
    expect(conflict.body.currentLockedAt).toBe(locked.body.lockedAt);

    const unlocked = await request(app).post("/api/manifest/unlock").send({ confirm: true });
    expect(unlocked.status).toBe(200);
    const importedAgain = await request(app)
      .post("/api/journeys/import")
      .attach("journeys", Buffer.from(validCsv), { filename: "journeys.csv" });
    expect(importedAgain.status).toBe(200);
  });
});
