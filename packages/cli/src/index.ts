export const HELP_TEXT = `
Pathlight CLI — quality gates and CI/CD integration

Commands:
  run           Trigger a test run (optional: --nodes=ID,ID --suite=TAG --environment=NAME --branch=NAME --pr=N --commit=SHA)
  status        Show the result of the latest run
  stop          Stop the currently running test suite
  report        Print the URL of the latest HTML report
  journeys      List journeys from the locked manifest
  gaps          Show journeys with no automated coverage
  generate      Generate a test for a specific journey (--journey=ID)
  derive        Derive journeys from JIRA stories
  map           Derive story-to-journey mapping
  scope         List journeys in scope for a PR (--pr=NUMBER)
  gate          Run the release quality gate against the last run
  query         Ask a natural-language question about your test results
  help          Show this help

Global options:
  --json        Return machine-readable JSON output
  --help        Show command help

Gate options:
  --min-pass-rate=N           Fail if overall pass rate is below N% (0-100)
  --no-critical-failures      Fail if any journey with a Critical business rule failed
  --no-highest-failures       Fail if any Highest priority journey failed (default)

Environment:
  PATHLIGHT_SERVER_URL        Pathlight server base URL (default: http://127.0.0.1:4242)

Examples:
  pathlight run
  pathlight run --nodes=login,checkout --environment=staging
  pathlight status
  pathlight report
  pathlight journeys
  pathlight gaps
  pathlight generate --journey=user-login
  pathlight scope --pr=247
  pathlight gate --min-pass-rate=90 --json
  pathlight query "which journeys failed in the last run?"
`.trim();

export type NodeStatus = "passed" | "failed" | "skipped" | "blocked" | "abandoned" | "untested";

export interface RunSummary {
  runId: string;
  status: string;
  verdict?: string;
  intendedNodeIds: string[];
  testResults: Record<string, { status: NodeStatus }>;
}

export interface ManifestNode {
  id: string;
  label?: string;
  priority?: string;
  businessRuleIds?: string[];
}

export interface ManifestData {
  nodes: ManifestNode[];
  businessRules?: Array<{ id: string; severity?: string }>;
}

export interface GateOptions {
  serverUrl: string;
  minPassRate?: number;
  noCriticalFailures: boolean;
  noHighestFailures: boolean;
  branch?: string;
  pr?: string;
  commit?: string;
  environment?: string;
}

export interface GateResult {
  passed: boolean;
  runId: string;
  verdict: string;
  passRate: number;
  totalJourneys: number;
  passedJourneys: number;
  failedJourneys: number;
  highestFailures: string[];
  criticalRuleFailures: string[];
  reasons: string[];
  branch?: string;
  pr?: string;
  commit?: string;
  environment?: string;
}

function isHighest(priority: string | undefined): boolean {
  const n = (priority ?? "").trim().toLowerCase();
  return /^(highest|p0|p-0|critical|blocker)$/.test(n);
}

export async function runGate(options: GateOptions): Promise<GateResult> {
  const { serverUrl, minPassRate, noCriticalFailures, noHighestFailures } = options;
  // CI environment variable auto-detection
  const branch = options.branch ?? process.env.GITHUB_REF ?? process.env.CI_BRANCH;
  const pr = options.pr ?? process.env.GITHUB_PR_NUMBER ?? process.env.CI_PR_NUMBER;
  const commit = options.commit ?? process.env.GITHUB_SHA ?? process.env.CI_COMMIT;
  const environment = options.environment ?? process.env.CI_ENVIRONMENT;

  // Fetch latest run
  let runResp: Response;
  try {
    runResp = await fetch(`${serverUrl}/api/runs/latest`);
  } catch {
    throw new Error("Pathlight server not running. Start with: npm run dev");
  }
  if (!runResp.ok) {
    throw new Error("No completed runs found. Run the test suite first.");
  }
  const run = (await runResp.json()) as RunSummary;

  // Fetch manifest for node priorities and business rules
  let manifest: ManifestData = { nodes: [] };
  try {
    const manifestResp = await fetch(`${serverUrl}/api/manifest`);
    if (manifestResp.ok) {
      manifest = (await manifestResp.json()) as ManifestData;
    }
  } catch {
    // Proceed without manifest priority info.
  }

  const nodeMap = new Map(manifest.nodes.map((n) => [n.id, n]));
  const results = run.testResults ?? {};
  const intended = run.intendedNodeIds ?? [];

  const passedJourneys = intended.filter((id) => results[id]?.status === "passed").length;
  const failedJourneys = intended.filter((id) => results[id]?.status === "failed").length;
  const totalJourneys = intended.length;
  const passRate = totalJourneys > 0 ? (passedJourneys / totalJourneys) * 100 : 100;

  const highestFailures = intended.filter(
    (id) => results[id]?.status === "failed" && isHighest(nodeMap.get(id)?.priority),
  );

  const criticalRuleFailures: string[] = [];
  const untestedCriticalJourneys: string[] = [];
  for (const rule of manifest.businessRules ?? []) {
    if (rule.severity !== "critical" && rule.severity !== "high") continue;
    const ruleNodes = manifest.nodes.filter((n) => (n.businessRuleIds ?? []).includes(rule.id));
    const anyFailed = ruleNodes.some((n) => results[n.id]?.status === "failed");
    if (anyFailed && rule.severity === "critical") criticalRuleFailures.push(rule.id);
    // Untested intended journeys covering critical/high business rules also fail the gate.
    for (const node of ruleNodes) {
      if (
        intended.includes(node.id) &&
        (!results[node.id] || results[node.id].status === "untested")
      ) {
        untestedCriticalJourneys.push(node.id);
      }
    }
  }

  const reasons: string[] = [];

  // Untested critical journeys fail before pass-rate check.
  if (untestedCriticalJourneys.length > 0) {
    reasons.push(
      `${untestedCriticalJourneys.length} journey(s) covering critical/high business rules are untested: ${[...new Set(untestedCriticalJourneys)].join(", ")}`,
    );
  }
  if (noHighestFailures && highestFailures.length > 0) {
    reasons.push(
      `${highestFailures.length} Highest priority journey(s) failed: ${highestFailures.join(", ")}`,
    );
  }
  if (noCriticalFailures && criticalRuleFailures.length > 0) {
    reasons.push(
      `${criticalRuleFailures.length} Critical business rule(s) failed: ${criticalRuleFailures.join(", ")}`,
    );
  }
  if (minPassRate !== undefined && passRate < minPassRate) {
    reasons.push(`Pass rate ${passRate.toFixed(1)}% is below required ${minPassRate}%`);
  }

  return {
    passed: reasons.length === 0,
    runId: run.runId,
    verdict: run.verdict ?? "UNKNOWN",
    passRate,
    totalJourneys,
    passedJourneys,
    failedJourneys,
    highestFailures,
    criticalRuleFailures,
    reasons,
    ...(branch ? { branch } : {}),
    ...(pr ? { pr } : {}),
    ...(commit ? { commit } : {}),
    ...(environment ? { environment } : {}),
  };
}
