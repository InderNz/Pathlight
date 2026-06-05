import { describe, expect, it } from "vitest";
import { generateManifest, JOURNEY_TEMPLATE, validateJourneyCsv } from "./index.js";

describe("@pathlight/manifest-schema", () => {
  it("exports the PRD journey template through the shared contract package", () => {
    expect(JOURNEY_TEMPLATE).toContain("id,summary,priority,priorityRank,stage,stageName");
    expect(JOURNEY_TEMPLATE).toContain("E2E-001,ZovKu recipient rejects a review request");
  });

  it("generates project-neutral manifest nodes from a valid journey CSV", () => {
    const csv =
      "id,summary,priority,priorityRank,stage,stageName,branchType,labels,linkedStories,description\n" +
      "FLOW-001,Guest submits request,High,1,S1,Requests,happy,@smoke,US-001,Submission succeeds\n";
    const result = validateJourneyCsv(csv);

    expect(result.errors).toEqual([]);
    const manifest = generateManifest("DEMO", result.rows);
    expect(manifest.projectKey).toBe("DEMO");
    expect(manifest.nodes[0]).toMatchObject({
      id: "FLOW-001",
      label: "Guest submits request",
      priority: "High",
      stage: "S1",
      risk: "high",
    });
  });
});
