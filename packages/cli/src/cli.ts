#!/usr/bin/env node
import { HELP_TEXT, runGate } from "./index.js";

const args = process.argv.slice(2);
const command = args[0];
const jsonFlag = args.includes("--json") || args.includes("-j");
const helpFlag = args.includes("--help") || args.includes("-h");
const serverUrl = process.env.PATHLIGHT_SERVER_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:4242";

function die(message: string, code = 1): never {
  if (jsonFlag) {
    console.log(JSON.stringify({ error: message }));
  } else {
    console.error(`error: ${message}`);
  }
  process.exit(code);
}

function flagVal(argList: string[], flag: string): string | undefined {
  return argList
    .find((a) => a.startsWith(`${flag}=`))
    ?.split("=")
    .slice(1)
    .join("=");
}

async function safeFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error("Pathlight server not running. Start with: npm run dev");
  }
}

// Mutating endpoints require the local auth token. Fetch it once per process.
let tokenResolved = false;
let cachedToken: string | undefined;
async function getToken(): Promise<string | undefined> {
  if (tokenResolved) return cachedToken;
  const res = await safeFetch(`${serverUrl}/api/local-token`);
  if (res.status === 404) {
    // Server has no local auth configured; mutating endpoints are open.
    tokenResolved = true;
    return undefined;
  }
  if (res.status === 401 || !res.ok) {
    die("Pathlight server requires authentication. Is the server running?");
  }
  const data = (await res.json()) as { token?: string };
  cachedToken = data.token;
  tokenResolved = true;
  return cachedToken;
}

async function authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
  const token = await getToken();
  return { ...(extra ?? {}), ...(token ? { "X-Pathlight-Token": token } : {}) };
}

if (!command || command === "help" || helpFlag) {
  console.log(HELP_TEXT);
  process.exit(0);
}

if (command === "gate") {
  const gateArgs = args.slice(1).filter((a) => a !== "--json" && a !== "-j");
  const minPassRateArg = gateArgs.find((a) => a.startsWith("--min-pass-rate="));
  const minPassRate = minPassRateArg ? parseFloat(minPassRateArg.split("=")[1] ?? "") : undefined;
  if (minPassRate !== undefined && (isNaN(minPassRate) || minPassRate < 0 || minPassRate > 100)) {
    die("--min-pass-rate must be a number between 0 and 100");
  }

  let result: Awaited<ReturnType<typeof runGate>>;
  try {
    result = await runGate({
      serverUrl,
      minPassRate,
      noCriticalFailures: gateArgs.includes("--no-critical-failures"),
      noHighestFailures:
        gateArgs.includes("--no-highest-failures") || !gateArgs.some((a) => a.startsWith("--")),
      branch: flagVal(gateArgs, "--branch"),
      pr: flagVal(gateArgs, "--pr"),
      commit: flagVal(gateArgs, "--commit"),
      environment: flagVal(gateArgs, "--environment"),
    });
  } catch (err) {
    die(err instanceof Error ? err.message : String(err), 2);
  }

  if (jsonFlag) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Run: ${result.runId}  Verdict: ${result.verdict}`);
    console.log(
      `Journeys: ${result.passedJourneys}/${result.totalJourneys} passed  Pass rate: ${result.passRate.toFixed(1)}%`,
    );
    if (result.reasons.length > 0) {
      console.log("\nGate FAILED:");
      result.reasons.forEach((r) => console.log(`  ✗ ${r}`));
    } else {
      console.log("\nGate PASSED");
    }
  }

  process.exit(result.passed ? 0 : 1);
} else if (command === "run") {
  const runArgs = args.slice(1).filter((a) => a !== "--json" && a !== "-j");
  const nodeIdsArg = flagVal(runArgs, "--nodes");
  const nodeIds = nodeIdsArg
    ? nodeIdsArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const suiteTag = flagVal(runArgs, "--suite");
  const environment = flagVal(runArgs, "--environment");
  const branch = flagVal(runArgs, "--branch");
  const pr = flagVal(runArgs, "--pr");
  const commit = flagVal(runArgs, "--commit");

  const body: Record<string, unknown> = {};
  if (nodeIds && nodeIds.length > 0) body.nodeIds = nodeIds;
  if (suiteTag) body.suiteTag = suiteTag;
  if (environment) body.environment = environment;
  if (branch) body.branch = branch;
  if (pr) body.pr = pr;
  if (commit) body.commit = commit;

  const res = await safeFetch(`${serverUrl}/api/runs`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    die((data.error as string | undefined) ?? `Server error ${res.status}`, 1);
  }
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Run started: ${data.runId as string}`);
    console.log(`Stream: ${serverUrl}/api/stream`);
  }
} else if (command === "status") {
  const res = await safeFetch(`${serverUrl}/api/runs/latest`);
  if (!res.ok) {
    die("No completed runs found. Run the test suite first.", 1);
  }
  const data = (await res.json()) as Record<string, unknown>;
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const results = (data.testResults ?? {}) as Record<string, { status: string }>;
    const intended = (data.intendedNodeIds ?? []) as string[];
    const passed = intended.filter((id) => results[id]?.status === "passed").length;
    console.log(`Run:     ${data.runId as string}`);
    console.log(`Status:  ${data.status as string}`);
    console.log(`Verdict: ${(data.verdict as string | undefined) ?? "—"}`);
    console.log(`Passed:  ${passed}/${intended.length}`);
  }
} else if (command === "stop") {
  // The active run ID lives on the health endpoint, not /api/runs/latest
  // (which returns the latest completed run).
  const healthRes = await safeFetch(`${serverUrl}/api/health`);
  const health = (await healthRes.json()) as { activeRunId?: string | null };
  const activeRunId = health.activeRunId;
  if (!activeRunId) {
    console.log("No active run.");
    process.exit(0);
  }

  console.log(`Stopping run ${activeRunId}…`);
  const res = await safeFetch(`${serverUrl}/api/runs/${activeRunId}`, {
    method: "DELETE",
    headers: await authHeaders(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    die((data.error as string | undefined) ?? `Server error ${res.status}`);
  }
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  }
} else if (command === "report") {
  const res = await safeFetch(`${serverUrl}/api/runs/latest`);
  if (!res.ok) {
    die("No completed runs found. Run the test suite first.", 1);
  }
  const data = (await res.json()) as { runId?: string };
  if (!data.runId) die("No run ID in server response.");
  const url = `${serverUrl}/reports/${data.runId}/report.html`;
  if (jsonFlag) {
    console.log(JSON.stringify({ runId: data.runId, url }));
  } else {
    console.log(`Report: ${url}`);
  }
} else if (command === "journeys") {
  const res = await safeFetch(`${serverUrl}/api/manifest`);
  if (!res.ok) {
    die("Manifest not found. Lock the manifest first.", 1);
  }
  const manifest = (await res.json()) as {
    nodes?: Array<{ id: string; label?: string; priority?: string; deprecated?: boolean }>;
  };
  const nodes = (manifest.nodes ?? []).filter((n) => !n.deprecated);
  if (jsonFlag) {
    console.log(JSON.stringify(nodes, null, 2));
  } else {
    console.log(`${nodes.length} journey(s):\n`);
    nodes.forEach((n) => {
      const priority = n.priority ? ` [${n.priority}]` : "";
      console.log(`  ${n.id}${priority}  ${n.label ?? ""}`);
    });
  }
} else if (command === "gaps") {
  const res = await safeFetch(`${serverUrl}/api/risk`);
  if (!res.ok) {
    die("Could not fetch risk data. Run the test suite first.", 1);
  }
  const risk = (await res.json()) as {
    recommendation?: string;
    untestedNodes?: Array<{ id: string; label?: string }>;
  };
  if (jsonFlag) {
    console.log(JSON.stringify(risk, null, 2));
  } else {
    const untested = risk.untestedNodes ?? [];
    console.log(`Recommendation: ${risk.recommendation ?? "—"}`);
    if (untested.length === 0) {
      console.log("No coverage gaps.");
    } else {
      console.log(`\n${untested.length} untested journey(s):`);
      untested.forEach((n) => console.log(`  ${n.id}  ${n.label ?? ""}`));
    }
  }
} else if (command === "generate") {
  const genArgs = args.slice(1).filter((a) => a !== "--json" && a !== "-j");
  const journeyId = flagVal(genArgs, "--journey");
  if (!journeyId) die("--journey=<id> is required. Use 'pathlight journeys' to list IDs.");

  const res = await safeFetch(`${serverUrl}/api/generation/generate`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ journeyId }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    die((data.error as string | undefined) ?? `Server error ${res.status}`);
  }
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Generated test for journey: ${journeyId}`);
  }
} else if (command === "derive") {
  const res = await safeFetch(`${serverUrl}/api/journeys/derive`, {
    method: "POST",
    headers: await authHeaders(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    die((data.error as string | undefined) ?? `Server error ${res.status}`);
  }
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const count = (data.journeyCount as number | undefined) ?? "?";
    console.log(`Derived ${count} journey(s) from JIRA stories.`);
  }
} else if (command === "map") {
  const res = await safeFetch(`${serverUrl}/api/mapping/derive`, {
    method: "POST",
    headers: await authHeaders(),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    die((data.error as string | undefined) ?? `Server error ${res.status}`);
  }
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(`Mapping derived.`);
    if (data.mappings) console.log(JSON.stringify(data.mappings, null, 2));
  }
} else if (command === "scope") {
  const scopeArgs = args.slice(1).filter((a) => a !== "--json" && a !== "-j");
  const pr = flagVal(scopeArgs, "--pr");
  if (!pr) die("--pr=<number> is required.");

  const res = await safeFetch(`${serverUrl}/api/regression-scope?pr=${encodeURIComponent(pr)}`);
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    die((data.error as string | undefined) ?? `Server error ${res.status}`);
  }
  if (jsonFlag) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    const nodeIds = (data.recommendedNodeIds as string[] | undefined) ?? [];
    console.log(`PR #${pr} scope: ${nodeIds.length} journey(s)`);
    nodeIds.forEach((id) => console.log(`  ${id}`));
  }
} else if (command === "query") {
  const question = args
    .slice(1)
    .filter((a) => a !== "--json" && a !== "-j")
    .join(" ");
  if (!question) die("Provide a natural-language question after 'query'.");

  const res = await safeFetch(`${serverUrl}/api/mcp`, {
    method: "POST",
    headers: await authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ method: "pathlight/query", params: { question } }),
  });
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) die(data.error);
  if (jsonFlag) {
    console.log(JSON.stringify(data.result, null, 2));
  } else {
    console.log(
      typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2),
    );
  }
} else {
  die(`Unknown command: ${command}. Run 'pathlight --help' for usage.`);
}
