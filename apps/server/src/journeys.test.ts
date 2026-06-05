// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const HEADER =
  "id,summary,priority,priorityRank,stage,stageName,branchType,labels,linkedStories,description";
const VALID_CSV = `${HEADER}\r\nE2E-001,Owner sends review,Highest,1,S2,Core SMS Review Flow,happy,"@smoke,@critical",US-002,Happy request\r\nE2E-002,Owner retries send,High,2,S2,Core SMS Review Flow,edge,@smoke,US-003,Retry handling\r\n`;

describe("US-P004 to US-P006 journey import and manifest locking", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-journeys-"));
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Pathlight", key: "PL" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("downloads the fixed CSV template with one realistic example row", async () => {
    const response = await request(createApp({ projectRoot })).get("/api/journeys/template");

    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain("pathlight-journeys-template.csv");
    const lines = response.text.trim().split(/\r?\n/);
    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^#/);
    expect(lines[2]).toContain("E2E-001");
    expect(lines[2]).toContain("Core SMS Review Flow");
    expect(lines[2]).toContain(",unhappy,");

    const validation = await request(createApp({ projectRoot }))
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(response.text), {
        filename: "pathlight-journeys-template.csv",
        contentType: "text/csv",
      });
    expect(validation.body).toMatchObject({ valid: true, journeyCount: 1 });
  });

  it("validates a CRLF CSV and returns journey, stage and priority totals", async () => {
    const response = await request(createApp({ projectRoot }))
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(VALID_CSV), {
        filename: "journeys.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      valid: true,
      journeyCount: 2,
      stages: { S2: 2 },
      priorities: { Highest: 1, High: 1 },
    });
  });

  it("lists exact validation errors without changing the manifest", async () => {
    const invalidCsv = [
      "id,summary,priorityRank,stage,stageName,branchType",
      "E2E-001,First,high,S2,Core,negative",
      "E2E-001,Second,2,S2,Core,happy",
    ].join("\n");
    const response = await request(createApp({ projectRoot }))
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(invalidCsv), {
        filename: "journeys.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(422);
    expect(response.body.errors).toContain("Required column 'priority' not found in header row.");
    expect(response.body.errors).toContain("Duplicate id 'E2E-001' found on rows 2 and 3.");
    expect(response.body.errors).toContain(
      "Row 2: priorityRank 'high' must be a positive integer.",
    );
    expect(response.body.errors).toContain(
      "Row 2: branchType 'negative' must be one of: happy, unhappy, edge, boundary, system.",
    );
    await expect(readFile(join(projectRoot, "pathlight-manifest.json"))).rejects.toThrow();
  });

  it("rejects non-CSV uploads and files without journey rows", async () => {
    const app = createApp({ projectRoot });
    const wrongType = await request(app)
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(VALID_CSV), {
        filename: "journeys.txt",
        contentType: "text/plain",
      });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.error).toBe("Only .csv files are accepted.");

    const noRows = await request(app)
      .post("/api/journeys/validate")
      .attach("journeys", Buffer.from(`${HEADER}\n`), {
        filename: "journeys.csv",
        contentType: "text/csv",
      });
    expect(noRows.status).toBe(422);
    expect(noRows.body.errors).toContain("No journey rows found. Add at least one journey.");
  });

  it("imports validated rows into an unlocked manifest draft with story hashes", async () => {
    const response = await request(createApp({ projectRoot }))
      .post("/api/journeys/import")
      .attach("journeys", Buffer.from(VALID_CSV), {
        filename: "journeys.csv",
        contentType: "text/csv",
      });

    expect(response.status).toBe(200);
    expect(response.body.message).toBe(
      "2 journeys imported across 1 stage. Manifest ready to lock.",
    );
    const manifest = JSON.parse(
      await readFile(join(projectRoot, "pathlight-manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      schemaVersion: "1.0",
      projectKey: "PL",
      lockedAt: null,
      lockedBy: null,
      businessRules: [],
    });
    expect(manifest.nodes[0]).toMatchObject({
      id: "E2E-001",
      stage: "S2",
      stageName: "Core SMS Review Flow",
      priority: "Highest",
      priorityRank: 1,
      risk: "critical",
      branchType: "happy",
      tags: ["@smoke", "@critical"],
    });
    expect(manifest.nodes[0].storyHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("locks an imported manifest, rejects overwrite until explicit unlock, and detects conflicts", async () => {
    const app = createApp({ projectRoot });
    await request(app).post("/api/journeys/import").attach("journeys", Buffer.from(VALID_CSV), {
      filename: "journeys.csv",
      contentType: "text/csv",
    });
    const draft = (await request(app).get("/api/manifest")).body;

    const locked = await request(app).post("/api/manifest/lock").send({ manifest: draft });
    expect(locked.status).toBe(200);
    expect(locked.body.lockedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(locked.body.lockedBy).toEqual(expect.any(String));

    const reimport = await request(app)
      .post("/api/journeys/import")
      .attach("journeys", Buffer.from(VALID_CSV), {
        filename: "journeys.csv",
        contentType: "text/csv",
      });
    expect(reimport.status).toBe(409);
    expect(reimport.body.error).toBe("Unlock the manifest before importing journeys.");

    const conflict = await request(app)
      .post("/api/manifest/lock")
      .send({ manifest: draft, currentLockedAt: "stale-lock" });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe("MANIFEST_LOCK_CONFLICT");

    const blockedUnlock = await request(app).post("/api/manifest/unlock").send({});
    expect(blockedUnlock.status).toBe(400);
    const unlocked = await request(app).post("/api/manifest/unlock").send({ confirm: true });
    expect(unlocked.status).toBe(200);
    expect(unlocked.body.locked).toBe(false);
  });
});
