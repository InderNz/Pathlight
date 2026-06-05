import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

// Journey IDs are used as filenames; only allow filesystem-safe characters.
// Must start with a letter and contain only letters, digits, hyphens, or underscores.
export const JOURNEY_ID_RE = /^[A-Za-z][A-Za-z0-9_-]{1,29}$/;

const REQUIRED_COLUMNS = [
  "id",
  "summary",
  "priority",
  "priorityRank",
  "stage",
  "stageName",
  "branchType",
] as const;
const BRANCH_TYPES = ["happy", "unhappy", "edge", "boundary", "system"] as const;

type BranchType = (typeof BRANCH_TYPES)[number];
type RiskLevel = "low" | "medium" | "high" | "critical";

interface JourneyRow {
  id: string;
  summary: string;
  priority: string;
  priorityRank: number;
  stage: string;
  stageName: string;
  branchType: BranchType;
  labels: string;
  linkedStories: string;
  description: string;
}

export interface ManifestNode {
  schemaVersion: "1.0";
  id: string;
  projectKey: string;
  stage: string;
  stageName: string;
  module: string;
  priority: string;
  priorityRank: number;
  storyId?: string;
  storyTitle: string;
  storyHash: string;
  branchType: BranchType;
  label: string;
  risk: RiskLevel;
  businessRuleIds: string[];
  testFiles: string[];
  tags: string[];
  linkedStories: string[];
  deprecated?: boolean;
  supersededBy?: string;
  // JIRA keys tracked against the journey (single source of truth — see app.ts).
  openBugKey?: string;
  openDebtStoryKey?: string;
}

export interface ManifestFile {
  schemaVersion: "1.0";
  projectKey: string;
  lockedAt: string | null;
  lockedBy: string | null;
  businessRules: unknown[];
  nodes: ManifestNode[];
}

export type DraftState = "draft" | "approved" | "rejected";

export interface DraftNode extends ManifestNode {
  draftState: DraftState;
  sourceStoryKey?: string;
  flagged?: boolean;
}

export interface SuggestedBusinessRule {
  label: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  jurisdiction?: string;
  sourceRef?: string;
  appliesToJourneyIds?: string[];
}

export interface DraftManifest {
  schemaVersion: "1.0";
  projectKey: string;
  createdAt: string;
  nodes: DraftNode[];
  suggestedBusinessRules: SuggestedBusinessRule[];
}

export const JOURNEY_TEMPLATE =
  "id,summary,priority,priorityRank,stage,stageName,branchType,labels,linkedStories,description\n" +
  "# Permanent journey ID,short journey summary,display tier,integer display order,stage key,stage label,branch category,comma-separated tags,linked story IDs,journey details\n" +
  'E2E-001,ZovKu recipient rejects a review request,Highest,1,S2,Core SMS Review Flow,unhappy,"@smoke,@critical",US-002,Recipient opts out of the review request\n';

function normalise(value: string) {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function riskForPriority(priority: string): RiskLevel {
  const known: Record<string, RiskLevel> = {
    highest: "critical",
    high: "high",
    medium: "medium",
    low: "low",
  };
  return known[priority.toLowerCase()] ?? "medium";
}

function splitList(value: string) {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function validateJourneyCsv(contents: string) {
  const records = parse(contents, {
    bom: true,
    relax_column_count: true,
    skip_empty_lines: true,
    trim: true,
  }) as string[][];
  const headers = records[0] ?? [];
  const errors: string[] = [];

  for (const column of REQUIRED_COLUMNS) {
    if (!headers.includes(column)) {
      errors.push(`Required column '${column}' not found in header row.`);
    }
  }
  if (records.length < 2) {
    errors.push("No journey rows found. Add at least one journey.");
    return { valid: false as const, errors, rows: [] as JourneyRow[] };
  }

  const index = new Map(headers.map((header, position) => [header, position]));
  const seen = new Map<string, number>();
  const rows: JourneyRow[] = [];
  records.slice(1).forEach((values, offset) => {
    const rowNumber = offset + 2;
    if ((values[0] ?? "").startsWith("#")) {
      return;
    }
    const get = (column: string) => values[index.get(column) ?? -1] ?? "";
    const id = get("id");
    if (id && !JOURNEY_ID_RE.test(id)) {
      errors.push(
        `Row ${rowNumber}: id '${id}' must start with a letter and contain only letters, digits, hyphens, or underscores (2-30 characters).`,
      );
    }
    const priorRow = seen.get(id);
    if (id && priorRow) {
      errors.push(`Duplicate id '${id}' found on rows ${priorRow} and ${rowNumber}.`);
    } else if (id) {
      seen.set(id, rowNumber);
    }
    const rankText = get("priorityRank");
    const priorityRank = Number(rankText);
    if (!Number.isInteger(priorityRank) || priorityRank <= 0) {
      errors.push(`Row ${rowNumber}: priorityRank '${rankText}' must be a positive integer.`);
    }
    const branchType = get("branchType");
    if (!(BRANCH_TYPES as readonly string[]).includes(branchType)) {
      errors.push(
        `Row ${rowNumber}: branchType '${branchType}' must be one of: happy, unhappy, edge, boundary, system.`,
      );
    }
    rows.push({
      id,
      summary: get("summary"),
      priority: get("priority"),
      priorityRank,
      stage: get("stage"),
      stageName: get("stageName"),
      branchType: branchType as BranchType,
      labels: get("labels"),
      linkedStories: get("linkedStories"),
      description: get("description"),
    });
  });

  if (rows.length === 0 && !errors.includes("No journey rows found. Add at least one journey.")) {
    errors.push("No journey rows found. Add at least one journey.");
  }
  if (errors.length > 0) {
    return { valid: false as const, errors, rows };
  }
  return { valid: true as const, errors: [], rows };
}

export function summarizeJourneys(rows: JourneyRow[]) {
  const stages: Record<string, number> = {};
  const priorities: Record<string, number> = {};
  for (const row of rows) {
    stages[row.stage] = (stages[row.stage] ?? 0) + 1;
    priorities[row.priority] = (priorities[row.priority] ?? 0) + 1;
  }
  return { journeyCount: rows.length, stages, priorities };
}

export function generateManifest(projectKey: string, rows: JourneyRow[]): ManifestFile {
  return {
    schemaVersion: "1.0",
    projectKey,
    lockedAt: null,
    lockedBy: null,
    businessRules: [],
    nodes: rows.map((row) => ({
      schemaVersion: "1.0",
      id: row.id,
      projectKey,
      stage: row.stage,
      stageName: row.stageName,
      module: row.stageName,
      priority: row.priority,
      priorityRank: row.priorityRank,
      storyTitle: row.summary,
      storyHash: createHash("sha256")
        .update(row.id + normalise(row.summary) + normalise(row.description))
        .digest("hex"),
      branchType: row.branchType,
      label: row.summary,
      risk: riskForPriority(row.priority),
      businessRuleIds: [],
      testFiles: [],
      tags: splitList(row.labels),
      linkedStories: splitList(row.linkedStories),
    })),
  };
}

export function validateManifest(manifest: unknown) {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== "object") {
    return ["Manifest must be a JSON object."];
  }
  const candidate = manifest as Partial<ManifestFile>;
  if (candidate.schemaVersion !== "1.0") {
    errors.push("schemaVersion must be '1.0'.");
  }
  if (!candidate.projectKey) {
    errors.push("projectKey is required.");
  }
  if (!Array.isArray(candidate.nodes)) {
    errors.push("nodes must be an array.");
    return errors;
  }
  const ids = new Set<string>();
  candidate.nodes.forEach((node, index) => {
    if (!node.id) {
      errors.push(`nodes[${index}].id is required.`);
    } else if (!JOURNEY_ID_RE.test(node.id)) {
      errors.push(
        `nodes[${index}].id '${node.id}' must start with a letter and contain only letters, digits, hyphens, or underscores (2-30 characters).`,
      );
    } else if (ids.has(node.id)) {
      errors.push(`nodes[${index}].id '${node.id}' is duplicated.`);
    } else {
      ids.add(node.id);
    }
    if (!node.stage || !node.branchType || !node.label) {
      errors.push(`nodes[${index}] is missing a required manifest node field.`);
    }
  });
  return errors;
}
