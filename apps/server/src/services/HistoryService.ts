import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface HistoryRun {
  runId: string;
  status: string;
  verdict?: string;
  reportPath?: string | null;
  completedAt?: string;
  environment?: string;
  branch?: string;
  pr?: string;
  commit?: string;
  testResults?: Record<string, { status: string }>;
}

export async function readRunHistory(projectRoot: string): Promise<HistoryRun[]> {
  try {
    const index = JSON.parse(await readFile(join(projectRoot, "runs", "index.json"), "utf8")) as {
      runs?: HistoryRun[];
    };
    const runs = index.runs ?? [];
    // Load all runs; pagination happens at the /api/history endpoint. A prior
    // 50-item cap here silently emptied page 2+ once history exceeded 50 runs.
    return await Promise.all(
      runs.map(async (run) => {
        try {
          const summary = JSON.parse(
            await readFile(join(projectRoot, "reports", run.runId, "summary.json"), "utf8"),
          ) as {
            testResults?: Record<string, { status: string }>;
            verdict?: string;
            environment?: string;
            branch?: string;
            pr?: string;
            commit?: string;
          };
          return {
            ...run,
            testResults: summary.testResults,
            verdict: summary.verdict,
            environment: summary.environment,
            branch: summary.branch,
            pr: summary.pr,
            commit: summary.commit,
          };
        } catch {
          return run;
        }
      }),
    );
  } catch {
    return [];
  }
}

export function computeHealthScores(
  runs: HistoryRun[],
): Record<string, { score: number; badge: string }> {
  const journeyData: Record<string, { total: number; passed: number; statuses: string[] }> = {};
  for (const run of runs.slice(0, 10)) {
    for (const [id, result] of Object.entries(run.testResults ?? {})) {
      const h = journeyData[id] ?? { total: 0, passed: 0, statuses: [] };
      h.total += 1;
      if (result.status === "passed") h.passed += 1;
      h.statuses.push(result.status);
      journeyData[id] = h;
    }
  }
  return Object.fromEntries(
    Object.entries(journeyData).map(([id, { total, passed, statuses }]) => {
      const rate = total > 0 ? passed / total : 0;
      let badge: string;
      if (total < 5) badge = "Insufficient data";
      else if (rate >= 0.9) badge = "Stable";
      else if (rate >= 0.7) badge = "Unstable";
      else badge = "Flaky";
      const alternating =
        total >= 5 &&
        statuses.every((s, i) =>
          i === 0 ? true : (s === "passed") !== (statuses[i - 1] === "passed"),
        );
      if (alternating) badge = "Flaky";
      return [id, { score: Math.round(rate * 100), badge }];
    }),
  );
}

export function detectRegressions(runs: HistoryRun[]): Set<string> {
  const regressions = new Set<string>();
  if (runs.length < 2) return regressions;
  const [latest, ...previous] = runs;
  for (const [id, result] of Object.entries(latest.testResults ?? {})) {
    if (result.status !== "failed") continue;
    const consecutivePasses = previous
      .slice(0, 5)
      .every((r) => r.testResults?.[id]?.status === "passed");
    if (consecutivePasses) regressions.add(id);
  }
  return regressions;
}
