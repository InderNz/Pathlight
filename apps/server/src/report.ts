import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type NodeStatus =
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "blocked"
  | "abandoned"
  | "untested";
type Verdict = "PASSED" | "WARNING" | "FAILED";

interface ReportNode {
  id: string;
  label?: string;
  stage?: string;
  stageName?: string;
  module?: string;
  priority?: string;
  priorityRank?: number;
  businessRuleIds?: string[];
}

interface BusinessRule {
  id: string;
  label?: string;
  severity?: string;
  draft?: boolean;
  deprecated?: boolean;
}

export interface ReportManifest {
  projectKey?: string;
  nodes: ReportNode[];
  businessRules?: BusinessRule[];
}

export interface ReportRunState {
  runId: string;
  status: "running" | "finished" | "abandoned";
  // CI/run provenance — persisted so reports and history can show where a run came from.
  environment?: string;
  branch?: string;
  pr?: string;
  commit?: string;
  intendedNodeIds: string[];
  testResults: Record<string, { status: string }>;
  nodeTestResults: Record<string, NodeStatus[]>;
  reportReady: boolean;
  reportPath: string | null;
  unknownTestIdCount: number;
  unknownTagCount: number;
  untaggedTestCount: number;
  invalidTagCount: number;
  duplicateEventCount: number;
  invalidPayloadCount: number;
  droppedEventCount: number;
}

interface RunIndexEntry {
  runId: string;
  status: string;
  reportPath?: string | null;
  verdict?: Verdict;
}

function rawStatuses(state: ReportRunState, nodeId: string) {
  return state.nodeTestResults[nodeId] ?? [];
}

export function computeVerdict(manifest: ReportManifest, state: ReportRunState): Verdict {
  if (state.status === "abandoned") {
    return "FAILED";
  }
  const intended = new Set(state.intendedNodeIds);
  const activeRules = (manifest.businessRules ?? []).filter(
    (rule) => !rule.draft && !rule.deprecated,
  );
  const ruleNodes = (rule: BusinessRule) =>
    manifest.nodes.filter((node) => (node.businessRuleIds ?? []).includes(rule.id));
  const inScopeNodes = (rule: BusinessRule) =>
    ruleNodes(rule).filter((node) => intended.has(node.id));

  for (const rule of activeRules.filter(
    (candidate) => candidate.severity === "critical" || candidate.severity === "high",
  )) {
    const covered = ruleNodes(rule);
    if (covered.length === 0) {
      return "FAILED";
    }
    const inScope = inScopeNodes(rule);
    if (inScope.length === 0) {
      continue;
    }
    for (const node of inScope) {
      const statuses = rawStatuses(state, node.id);
      if (
        statuses.length === 0 ||
        statuses.every((status) => status === "untested") ||
        statuses.some((status) => ["failed", "skipped", "blocked"].includes(status))
      ) {
        return "FAILED";
      }
    }
  }

  const scoreable = Object.values(state.testResults).filter(
    (result) => result.status !== "untested" && result.status !== "skipped",
  );
  const passed = scoreable.filter((result) => result.status === "passed").length;
  if (scoreable.length > 0 && passed / scoreable.length < 0.9) {
    return "FAILED";
  }

  let warning = Object.values(state.testResults).some((result) => result.status === "failed");
  for (const rule of activeRules.filter(
    (candidate) => candidate.severity === "low" || candidate.severity === "medium",
  )) {
    const covered = ruleNodes(rule);
    if (covered.length === 0) {
      warning = true;
      continue;
    }
    const inScope = inScopeNodes(rule);
    for (const node of inScope) {
      const statuses = rawStatuses(state, node.id);
      if (
        statuses.length === 0 ||
        statuses.every((status) => status === "untested") ||
        statuses.some((status) => ["failed", "skipped", "blocked"].includes(status))
      ) {
        warning = true;
      }
    }
  }
  for (const nodeId of intended) {
    const statuses = rawStatuses(state, nodeId);
    if (
      statuses.length === 0 ||
      statuses.every((status) => status === "untested") ||
      statuses.some((status) => status === "skipped" || status === "blocked")
    ) {
      warning = true;
    }
  }
  return warning ? "WARNING" : "PASSED";
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function prioritySortValue(priority: string | undefined): number {
  const normalized = (priority ?? "").trim().toLowerCase();
  if (/^(highest|p0|p-0|critical|blocker)$/.test(normalized)) return 0;
  if (/^(high|p1|p-1)$/.test(normalized)) return 1;
  if (/^(medium|med|p2|p-2)$/.test(normalized)) return 2;
  if (/^(low|p3|p-3)$/.test(normalized)) return 3;
  return 99;
}

interface NodeMetrics {
  durations: Map<string, number>;
  retryCounts: Map<string, number>;
}

function extractNodeMetrics(eventsPath: string): NodeMetrics {
  const durations = new Map<string, number>();
  const retryCounts = new Map<string, number>();
  if (!existsSync(eventsPath)) return { durations, retryCounts };
  try {
    const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          type: string;
          payload?: Record<string, unknown>;
        };
        const p = event.payload;
        if (!p) continue;
        const testId = typeof p.testId === "string" ? p.testId : null;
        if (!testId) continue;
        if (
          (event.type === "test.passed" || event.type === "test.failed") &&
          typeof p.duration === "number"
        ) {
          const existing = durations.get(testId);
          if (existing === undefined || p.duration > existing) {
            durations.set(testId, p.duration);
          }
        }
        if (
          (event.type === "test.passed" || event.type === "test.failed") &&
          typeof p.retryCount === "number" &&
          p.retryCount > 0
        ) {
          retryCounts.set(testId, p.retryCount as number);
        }
      } catch {
        // skip corrupt lines
      }
    }
  } catch {
    // events file unreadable
  }
  return { durations, retryCounts };
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
}

function donutSegment(
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  startAngle: number,
  endAngle: number,
  color: string,
): string {
  if (Math.abs(endAngle - startAngle) < 0.01) return "";
  const p1 = polarToCartesian(cx, cy, outer, startAngle);
  const p2 = polarToCartesian(cx, cy, outer, endAngle);
  const p3 = polarToCartesian(cx, cy, inner, endAngle);
  const p4 = polarToCartesian(cx, cy, inner, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;
  const d =
    `M${p1.x.toFixed(2)},${p1.y.toFixed(2)} ` +
    `A${outer},${outer} 0 ${largeArc} 1 ${p2.x.toFixed(2)},${p2.y.toFixed(2)} ` +
    `L${p3.x.toFixed(2)},${p3.y.toFixed(2)} ` +
    `A${inner},${inner} 0 ${largeArc} 0 ${p4.x.toFixed(2)},${p4.y.toFixed(2)} Z`;
  return `<path d="${d}" fill="${color}" />`;
}

function buildDonutChart(manifest: ReportManifest, state: ReportRunState): string {
  const inScope = manifest.nodes.filter((n) => state.intendedNodeIds.includes(n.id));
  const counts = {
    passed: inScope.filter((n) => state.testResults[n.id]?.status === "passed").length,
    failed: inScope.filter((n) => state.testResults[n.id]?.status === "failed").length,
    skipped: inScope.filter((n) => state.testResults[n.id]?.status === "skipped").length,
    blocked: inScope.filter((n) => state.testResults[n.id]?.status === "blocked").length,
    untested: inScope.filter(
      (n) =>
        !state.testResults[n.id] ||
        state.testResults[n.id].status === "untested" ||
        state.testResults[n.id].status === "abandoned",
    ).length,
  };
  const segments: Array<[number, string, string]> = [
    [counts.passed, "#2d9e6b", "Passed"],
    [counts.failed, "#e53e3e", "Failed"],
    [counts.skipped, "#e09e26", "Skipped"],
    [counts.blocked, "#c05621", "Blocked"],
    [counts.untested, "#a0aec0", "Untested"],
  ];
  const total = segments.reduce((s, [n]) => s + n, 0);
  if (total === 0) return "";
  const cx = 80;
  const cy = 80;
  let angle = 0;
  let paths = "";
  for (const [count, color] of segments) {
    if (count === 0) continue;
    const span = (count / total) * 360;
    paths += donutSegment(cx, cy, 40, 70, angle, angle + span, color);
    angle += span;
  }
  const legend = segments
    .filter(([count]) => count > 0)
    .map(
      ([count, color, label], i) =>
        `<rect x="170" y="${10 + i * 18}" width="12" height="12" fill="${color}" />` +
        `<text x="186" y="${21 + i * 18}" font-size="12" fill="#333">${escapeHtml(label)}: ${count}</text>`,
    )
    .join("");
  return (
    `<svg viewBox="0 0 320 180" style="width:320px;height:180px;display:block">` +
    paths +
    `<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="bold" fill="#333">${total}</text>` +
    `<text x="${cx}" y="${cy + 20}" text-anchor="middle" font-size="10" fill="#666">journeys</text>` +
    legend +
    `</svg>`
  );
}

function buildDurationChart(
  manifest: ReportManifest,
  state: ReportRunState,
  metrics: NodeMetrics,
): string {
  if (metrics.durations.size === 0) return "";
  const inScope = manifest.nodes.filter((n) => state.intendedNodeIds.includes(n.id));
  const withDuration = inScope
    .map((n) => ({ id: n.id, label: n.label ?? n.id, duration: metrics.durations.get(n.id) ?? 0 }))
    .filter((n) => n.duration > 0)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 15);
  if (withDuration.length === 0) return "";
  const maxDuration = Math.max(...withDuration.map((n) => n.duration));
  const barW = 32;
  const gap = 6;
  const chartH = 120;
  const labelH = 40;
  const totalW = withDuration.length * (barW + gap) + gap + 40;
  const bars = withDuration
    .map((n, i) => {
      const barH = Math.max(4, Math.round((n.duration / maxDuration) * chartH));
      const x = gap + 40 + i * (barW + gap);
      const y = chartH - barH;
      const color = state.testResults[n.id]?.status === "passed" ? "#2d9e6b" : "#e53e3e";
      const abbr = n.id.length > 8 ? n.id.slice(-6) : n.id;
      const secs = (n.duration / 1000).toFixed(1);
      return (
        `<rect x="${x}" y="${y}" width="${barW}" height="${barH}" fill="${color}" />` +
        `<text x="${x + barW / 2}" y="${chartH + 12}" text-anchor="middle" font-size="9" fill="#555" transform="rotate(-30,${x + barW / 2},${chartH + 12})">${escapeHtml(abbr)}</text>` +
        `<text x="${x + barW / 2}" y="${y - 3}" text-anchor="middle" font-size="9" fill="#333">${secs}s</text>`
      );
    })
    .join("");
  const yAxis = `<line x1="40" y1="0" x2="40" y2="${chartH}" stroke="#ccc" stroke-width="1"/>
<text x="36" y="10" text-anchor="end" font-size="9" fill="#666">${(maxDuration / 1000).toFixed(1)}s</text>
<text x="36" y="${chartH}" text-anchor="end" font-size="9" fill="#666">0s</text>`;
  return (
    `<svg viewBox="0 0 ${totalW} ${chartH + labelH}" style="width:min(100%,${totalW}px);height:${chartH + labelH}px;display:block;overflow:visible">` +
    yAxis +
    bars +
    `</svg>`
  );
}

function buildStageCoverageChart(manifest: ReportManifest, state: ReportRunState): string {
  const stageMap = new Map<string, { total: number; passed: number }>();
  for (const n of manifest.nodes.filter((n) => state.intendedNodeIds.includes(n.id))) {
    const key = n.stage ?? "Other";
    const entry = stageMap.get(key) ?? { total: 0, passed: 0 };
    entry.total += 1;
    if (state.testResults[n.id]?.status === "passed") entry.passed += 1;
    stageMap.set(key, entry);
  }
  if (stageMap.size === 0) return "";
  const barH = 22;
  const gap = 6;
  const labelW = 60;
  const chartW = 240;
  const rows = [...stageMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([stage, { total, passed }], i) => {
      const pct = total > 0 ? passed / total : 0;
      const fillW = Math.round(pct * chartW);
      const color = pct === 1 ? "#2d9e6b" : pct > 0.5 ? "#e09e26" : "#e53e3e";
      const y = i * (barH + gap);
      return (
        `<text x="${labelW - 4}" y="${y + barH - 6}" text-anchor="end" font-size="11" fill="#333">${escapeHtml(stage)}</text>` +
        `<rect x="${labelW}" y="${y}" width="${chartW}" height="${barH}" fill="#f0f0f0" rx="3"/>` +
        `<rect x="${labelW}" y="${y}" width="${fillW}" height="${barH}" fill="${color}" rx="3"/>` +
        `<text x="${labelW + chartW + 6}" y="${y + barH - 6}" font-size="11" fill="#555">${Math.round(pct * 100)}%</text>`
      );
    })
    .join("");
  const svgH = stageMap.size * (barH + gap);
  return (
    `<svg viewBox="0 0 ${labelW + chartW + 60} ${svgH}" style="width:${labelW + chartW + 60}px;height:${svgH}px;display:block">` +
    rows +
    `</svg>`
  );
}

function buildPriorityTable(manifest: ReportManifest, state: ReportRunState): string {
  const tiers = ["Highest", "High", "Medium", "Low"];
  const rows = tiers
    .map((tier) => {
      const nodes = manifest.nodes.filter(
        (n) =>
          state.intendedNodeIds.includes(n.id) &&
          prioritySortValue(n.priority) === prioritySortValue(tier),
      );
      if (nodes.length === 0) return null;
      const total = nodes.length;
      const passed = nodes.filter((n) => state.testResults[n.id]?.status === "passed").length;
      const failed = nodes.filter((n) => state.testResults[n.id]?.status === "failed").length;
      const skipped = nodes.filter((n) => state.testResults[n.id]?.status === "skipped").length;
      const untested = nodes.filter(
        (n) =>
          !state.testResults[n.id] ||
          state.testResults[n.id].status === "untested" ||
          state.testResults[n.id].status === "abandoned",
      ).length;
      const passRate = total > 0 ? `${Math.round((passed / total) * 100)}%` : "—";
      const rowStyle = failed > 0 && tier === "Highest" ? ' style="background:#fff5f5"' : "";
      return (
        `<tr${rowStyle}>` +
        `<td>${escapeHtml(tier)}</td><td>${total}</td><td>${passed}</td>` +
        `<td>${failed}</td><td>${skipped}</td><td>${untested}</td><td>${passRate}</td>` +
        `</tr>`
      );
    })
    .filter(Boolean)
    .join("");
  if (!rows) return "";
  return (
    `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:13px">` +
    `<thead><tr><th>Priority</th><th>Total</th><th>Passed</th><th>Failed</th><th>Skipped</th><th>Untested</th><th>Pass rate</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

function buildRetryList(
  manifest: ReportManifest,
  state: ReportRunState,
  metrics: NodeMetrics,
): string {
  if (metrics.retryCounts.size === 0) return "";
  const items = [...metrics.retryCounts.entries()]
    .filter(([id]) => state.intendedNodeIds.includes(id))
    .sort(([, a], [, b]) => b - a)
    .map(([id, retries]) => {
      const node = manifest.nodes.find((n) => n.id === id);
      const status = state.testResults[id]?.status ?? "untested";
      return `<li>${escapeHtml(id)} — ${escapeHtml(node?.label ?? "")} — ${retries} retr${retries === 1 ? "y" : "ies"} — ${escapeHtml(status)}</li>`;
    })
    .join("");
  return items
    ? `<section><h2>Tests that needed retries (flakiness signal)</h2><ul>${items}</ul></section>`
    : "";
}

function buildRiskSection(manifest: ReportManifest, state: ReportRunState): string {
  type BizRule = { id: string; label?: string; severity?: string; jurisdiction?: string };
  const rules = (manifest.businessRules ?? []) as BizRule[];
  const inScope = manifest.nodes.filter((n) => state.intendedNodeIds.includes(n.id));
  const total = inScope.length;
  const passed = inScope.filter((n) => state.testResults[n.id]?.status === "passed").length;
  const passRate = total > 0 ? passed / total : 1;

  function nodeRiskLevel(node: ReportNode): string {
    const bizSev = (node.businessRuleIds ?? []).map(
      (id) => rules.find((r) => r.id === id)?.severity ?? "low",
    );
    if (bizSev.includes("critical")) return "critical";
    const p = (node.priority ?? "medium").toLowerCase();
    if (/^(highest|p0|blocker)$/.test(p) || bizSev.includes("high")) return "high";
    if (/^(high|p1)$/.test(p)) return "medium";
    return "low";
  }

  const hasCriticalFail = inScope.some(
    (n) => state.testResults[n.id]?.status === "failed" && nodeRiskLevel(n) === "critical",
  );
  const hasHighFail = inScope.some(
    (n) => state.testResults[n.id]?.status === "failed" && nodeRiskLevel(n) === "high",
  );

  let recommendation: "BLOCKED" | "HOLD" | "GO";
  let statement: string;
  if (hasCriticalFail) {
    recommendation = "BLOCKED";
    const critRules = rules.filter(
      (r) =>
        r.severity === "critical" &&
        inScope.some(
          (n) =>
            (n.businessRuleIds ?? []).includes(r.id) &&
            state.testResults[n.id]?.status === "failed",
        ),
    );
    const nzRules = critRules.filter((r) => r.jurisdiction === "NZ");
    const auRules = critRules.filter((r) => r.jurisdiction === "AU");
    if (nzRules.length > 0) {
      statement = `Journeys covering NZ Privacy Act obligations are failing. Releasing may carry risk under the Privacy Act 2020 (NZ).`;
    } else if (auRules.length > 0) {
      statement = `Journeys covering AU Privacy Act obligations are failing. Releasing may carry risk under the Privacy Act 1988 (AU).`;
    } else {
      statement = `Critical journey(s) are failing. Releasing may carry significant risk.`;
    }
  } else if (hasHighFail || passRate < 0.8) {
    recommendation = "HOLD";
    statement = `High-priority journey(s) are failing. Core product flows may not work correctly for all users.`;
  } else {
    recommendation = "GO";
    const gaps = inScope.filter(
      (n) => !state.testResults[n.id] || state.testResults[n.id].status === "untested",
    ).length;
    statement = `All critical journeys passed. ${passed} of ${total} journeys verified.${gaps > 0 ? ` ${gaps} journey(s) have no automated coverage.` : ""}`;
  }

  const recColour =
    recommendation === "BLOCKED" ? "#c0392b" : recommendation === "HOLD" ? "#e09e26" : "#2d9e6b";

  const failRows = inScope
    .filter((n) => state.testResults[n.id]?.status === "failed")
    .map(
      (n) =>
        `<tr><td>${escapeHtml(n.id)}</td><td>${escapeHtml(n.label ?? "")}</td><td>${escapeHtml(nodeRiskLevel(n))}</td></tr>`,
    )
    .join("");

  return `<section><h2>Release recommendation: <span style="color:${recColour}">${recommendation}</span></h2>
<p>${escapeHtml(statement)}</p>
<p>Pass rate: ${Math.round(passRate * 100)}%</p>
${failRows ? `<h3>Failing journeys</h3><table border="1" cellpadding="6" style="border-collapse:collapse;font-size:13px"><thead><tr><th>ID</th><th>Label</th><th>Risk level</th></tr></thead><tbody>${failRows}</tbody></table>` : ""}
</section>`;
}

function buildMetricCards(
  manifest: ReportManifest,
  state: ReportRunState,
  finishedPayload: Record<string, unknown>,
  metrics: NodeMetrics,
): string {
  const inScope = manifest.nodes.filter((n) => state.intendedNodeIds.includes(n.id));
  const total = inScope.length;
  const passed = inScope.filter((n) => state.testResults[n.id]?.status === "passed").length;
  const passRate = total > 0 ? `${Math.round((passed / total) * 100)}%` : "—";

  const failedNodes = inScope.filter((n) => state.testResults[n.id]?.status === "failed");
  const firstFailure = failedNodes[0];
  const firstFailureText = firstFailure
    ? `${escapeHtml(firstFailure.id)}${metrics.durations.has(firstFailure.id) ? ` after ${((metrics.durations.get(firstFailure.id) ?? 0) / 1000).toFixed(1)}s` : ""}`
    : "—";

  const longestEntry = [...metrics.durations.entries()].sort(([, a], [, b]) => b - a)[0];
  const longestText = longestEntry
    ? `${escapeHtml(longestEntry[0])} ${(longestEntry[1] / 1000).toFixed(1)}s`
    : "—";

  const retryCount = [...metrics.retryCounts.keys()].filter((id) =>
    state.intendedNodeIds.includes(id),
  ).length;
  const retryRate = total > 0 ? `${Math.round((retryCount / total) * 100)}%` : "—";

  const activeRules = (manifest.businessRules ?? []).filter((r) => !r.draft && !r.deprecated);
  const verifiedRules = activeRules.filter((rule) => {
    const nodes = manifest.nodes.filter(
      (n) => (n.businessRuleIds ?? []).includes(rule.id) && state.intendedNodeIds.includes(n.id),
    );
    return nodes.length > 0 && nodes.every((n) => state.testResults[n.id]?.status === "passed");
  });

  const totalDuration = typeof finishedPayload.duration === "number" ? finishedPayload.duration : 0;
  const durationText = totalDuration > 0 ? `${(totalDuration / 1000).toFixed(1)}s` : "—";

  const cards: Array<[string, string]> = [
    ["Total journeys", String(total)],
    ["Pass rate", passRate],
    ["Total duration", durationText],
    ["First failure at", firstFailureText],
    ["Longest journey", longestText],
    ["Retry rate", retryRate],
    [`Business rules verified`, `${verifiedRules.length} of ${activeRules.length}`],
  ];

  const cardHtml = cards
    .map(
      ([label, value]) =>
        `<div style="border:1px solid #e2e8f0;border-radius:6px;padding:12px 16px;min-width:140px;display:inline-block;margin:4px;vertical-align:top">` +
        `<div style="font-size:11px;color:#718096;text-transform:uppercase;letter-spacing:.05em">${escapeHtml(label)}</div>` +
        `<div style="font-size:20px;font-weight:700;margin-top:4px;color:#1a202c">${value}</div>` +
        `</div>`,
    )
    .join("");
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:16px">${cardHtml}</div>`;
}

type HealthState = "good" | "warning" | "critical" | "idle";

export function computeReportHealthState(
  manifest: ReportManifest,
  state: ReportRunState,
): HealthState {
  const inScope = manifest.nodes.filter((n) => state.intendedNodeIds.includes(n.id));
  const results = inScope.map((n) => state.testResults[n.id]?.status ?? "untested");
  const active = results.filter((s) => s !== "untested" && s !== "abandoned");
  if (active.length === 0) return "idle";

  const anyFailed = active.some((s) => s === "failed");
  if (!anyFailed) return "good";

  const highestNodes = inScope.filter((n) => prioritySortValue(n.priority) === 0);
  const anyHighestFailed = highestNodes.some((n) => state.testResults[n.id]?.status === "failed");
  const failureRate = active.filter((s) => s === "failed").length / active.length;

  if (anyHighestFailed || failureRate >= 0.3) return "critical";
  return "warning";
}

function buildSpeedometerSvg(health: HealthState): string {
  const angles: Record<HealthState, number> = { idle: 0, good: 65, warning: 0, critical: -65 };
  const labels: Record<HealthState, string> = {
    idle: "—",
    good: "Good",
    warning: "Warning",
    critical: "Critical",
  };
  const segColors = ["#c0392b", "#d95c1a", "#e88820", "#e0b820", "#c4c820", "#86c020", "#2db840"];
  const segDeg = 162 / 7;
  const cx = 200,
    cy = 208,
    outerR = 183,
    innerR = 108;
  const angleDeg = angles[health];
  const label = labels[health];

  function sector(startDeg: number, endDeg: number): string {
    const d = Math.PI / 180;
    const c1 = Math.cos(startDeg * d),
      s1 = Math.sin(startDeg * d);
    const c2 = Math.cos(endDeg * d),
      s2 = Math.sin(endDeg * d);
    const f = (n: number) => n.toFixed(1);
    return (
      `M${f(cx + outerR * c1)},${f(cy - outerR * s1)} ` +
      `A${outerR},${outerR} 0 0 0 ${f(cx + outerR * c2)},${f(cy - outerR * s2)} ` +
      `L${f(cx + innerR * c2)},${f(cy - innerR * s2)} ` +
      `A${innerR},${innerR} 0 0 1 ${f(cx + innerR * c1)},${f(cy - innerR * s1)} Z`
    );
  }

  const sectors = segColors
    .map((color, i) => {
      const start = 180 - i * (segDeg + 3);
      const end = start - segDeg;
      return `<path d="${sector(start, end)}" fill="${color}"/>`;
    })
    .join("");

  const needlePath = `M${cx},${cy - 122} L${cx - 7},${cy} A7,7 0 0 1 ${cx + 7},${cy} Z`;

  return (
    `<svg viewBox="0 0 400 220" style="width:140px;height:77px;display:inline-block;vertical-align:middle" aria-label="Health: ${escapeHtml(label)}" role="img">` +
    sectors +
    `<path d="${needlePath}" fill="#2d3748" transform="rotate(${angleDeg} ${cx} ${cy})"/>` +
    `<circle cx="${cx}" cy="${cy}" r="16" fill="#2d3748"/>` +
    `<circle cx="${cx}" cy="${cy}" r="9" fill="#718096"/>` +
    `<text x="${cx}" y="218" text-anchor="middle" font-size="14" fill="#4a5568" font-weight="500">${escapeHtml(label)}</text>` +
    `</svg>`
  );
}

function writeFileAtomicSync(filePath: string, content: string): void {
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

export function updateRunIndex(projectRoot: string, entry: RunIndexEntry) {
  const indexPath = join(projectRoot, "runs", "index.json");
  let index: { latest: string; runs: RunIndexEntry[] } = { latest: entry.runId, runs: [] };
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8")) as typeof index;
  } catch {
    // First run creates the index.
  }
  const runs = index.runs.filter((run) => run.runId !== entry.runId);
  runs.unshift(entry);
  mkdirSync(dirname(indexPath), { recursive: true });
  writeFileAtomicSync(indexPath, `${JSON.stringify({ latest: entry.runId, runs }, null, 2)}\n`);
}

export function publishReport(
  projectRoot: string,
  manifest: ReportManifest,
  state: ReportRunState,
  finishedPayload: Record<string, unknown>,
) {
  const reportPath = `reports/${state.runId}/report.html`;
  const eventsPath = join(projectRoot, "reports", state.runId, "events.jsonl");
  const outputPath = join(projectRoot, "reports", state.runId, "output.log");
  const playwrightOutput = existsSync(outputPath)
    ? readFileSync(outputPath, "utf8").slice(-6000)
    : "";
  const reporterEvents = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { eventId?: string })
        .filter((event) => event.eventId?.startsWith("evt_")).length
    : 0;
  const totalEventsSent = Number(finishedPayload.totalEventsSent ?? 0);
  const rejected = state.unknownTestIdCount + state.duplicateEventCount + state.invalidPayloadCount;
  const deliveryWarning = reporterEvents !== totalEventsSent - rejected;
  const verdict = computeVerdict(manifest, state);

  const metrics = extractNodeMetrics(eventsPath);

  // ── Existing sections ────────────────────────────────────────────────────
  const rows = manifest.nodes
    .filter((node) => state.intendedNodeIds.includes(node.id))
    .map(
      (node, index) =>
        `<text x="20" y="${30 + index * 24}">${escapeHtml(node.id)}: ${escapeHtml(
          state.testResults[node.id]?.status ?? "untested",
        )}</text>`,
    )
    .join("");
  const modules = new Map<string, Array<{ status: string }>>();
  for (const node of manifest.nodes.filter((candidate) =>
    state.intendedNodeIds.includes(candidate.id),
  )) {
    const module = node.module ?? node.stage ?? "Unassigned";
    const results = modules.get(module) ?? [];
    results.push({ status: state.testResults[node.id]?.status ?? "untested" });
    modules.set(module, results);
  }
  const moduleBreakdown = [...modules.entries()]
    .map(([module, results]) => {
      const p = results.filter(({ status }) => status === "passed").length;
      const f = results.filter(({ status }) => status === "failed").length;
      return `<li>${escapeHtml(module)}: ${p} passed, ${f} failed, ${results.length} total</li>`;
    })
    .join("");
  const failedBranches = manifest.nodes
    .filter((node) => state.testResults[node.id]?.status === "failed")
    .map((node) => `<li>${escapeHtml(node.id)}: ${escapeHtml(node.label ?? "Failed")}</li>`)
    .join("");
  const ruleCoverage = (manifest.businessRules ?? [])
    .map((rule) => {
      let result = rule.draft ? "DRAFT" : rule.deprecated ? "DEPRECATED" : "UNTESTED";
      if (!rule.draft && !rule.deprecated) {
        const covered = manifest.nodes.filter((node) =>
          (node.businessRuleIds ?? []).includes(rule.id),
        );
        const statuses = covered.flatMap((node) => state.nodeTestResults[node.id] ?? []);
        result = statuses.includes("failed")
          ? "FAIL"
          : statuses.includes("blocked")
            ? "BLOCKED"
            : statuses.includes("skipped")
              ? "SKIPPED"
              : statuses.length > 0 && statuses.every((status) => status === "passed")
                ? "PASS"
                : "UNTESTED";
      }
      return `<li>${escapeHtml(rule.id)} ${escapeHtml(rule.label ?? "")}: ${result}</li>`;
    })
    .join("");
  const untestedPaths = state.intendedNodeIds
    .filter((nodeId) => (state.nodeTestResults[nodeId] ?? []).length === 0)
    .map((nodeId) => `<li>${escapeHtml(nodeId)}</li>`)
    .join("");
  const healthGuidance =
    state.untaggedTestCount > 0
      ? `<p>${state.untaggedTestCount} tests have no bracketed journey ID such as [E2E-005] and were excluded from tracking</p>`
      : "";
  const deliveryWarningHtml = deliveryWarning
    ? "<p>WARNING: server-side event drop detected</p>"
    : "";

  // ── New charts ───────────────────────────────────────────────────────────
  const health = computeReportHealthState(manifest, state);
  const speedometerSvg = buildSpeedometerSvg(health);
  const riskSection = buildRiskSection(manifest, state);
  const metricCards = buildMetricCards(manifest, state, finishedPayload, metrics);
  const donutChart = buildDonutChart(manifest, state);
  const durationChart = buildDurationChart(manifest, state, metrics);
  const stageCoverageChart = buildStageCoverageChart(manifest, state);
  const priorityTable = buildPriorityTable(manifest, state);
  const retrySection = buildRetryList(manifest, state, metrics);

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pathlight ${escapeHtml(state.runId)}</title></head>
<body>
<header><h1>Release confidence: <strong>${verdict}</strong> ${speedometerSvg}</h1><p>${escapeHtml(state.runId)}</p></header>
${riskSection}
<section><h2>Summary metrics</h2>
${metricCards}
<p>Total ${escapeHtml(finishedPayload.total)} Passed ${escapeHtml(finishedPayload.passed)} Failed ${escapeHtml(finishedPayload.failed)} Skipped ${escapeHtml(finishedPayload.skipped)}</p>
</section>
${donutChart ? `<section><h2>Journey status</h2>${donutChart}</section>` : ""}
${durationChart ? `<section><h2>Slowest journeys</h2>${durationChart}</section>` : ""}
${stageCoverageChart ? `<section><h2>Stage coverage</h2>${stageCoverageChart}</section>` : ""}
${priorityTable ? `<section><h2>Priority tier breakdown</h2>${priorityTable}</section>` : ""}
${retrySection}
<section><h2>Fishbone snapshot</h2><svg viewBox="0 0 600 ${Math.max(60, manifest.nodes.length * 24 + 30)}">${rows}</svg></section>
<section><h2>Module breakdown</h2><ul>${moduleBreakdown || "<li>No in-scope modules.</li>"}</ul></section>
<section><h2>Failed branches</h2><ul>${failedBranches || "<li>No failed branches.</li>"}</ul></section>
<section><h2>Business rule coverage</h2><ul>${ruleCoverage || "<li>No business rules configured.</li>"}</ul></section>
<section><h2>Untested paths</h2><ul>${untestedPaths || "<li>No untested paths.</li>"}</ul></section>
<section><h2>Run health</h2>${deliveryWarningHtml}${healthGuidance}<p>unknownTestIdCount: ${state.unknownTestIdCount} unknownTagCount: ${state.unknownTagCount} untaggedTestCount: ${state.untaggedTestCount} invalidTagCount: ${state.invalidTagCount}</p></section>
${playwrightOutput ? `<section><h2>Playwright output</h2><pre>${escapeHtml(playwrightOutput)}</pre></section>` : ""}
<section><h2>Run metadata</h2><p>Project: ${escapeHtml(manifest.projectKey)} Run ID: ${escapeHtml(state.runId)}</p></section>
</body></html>`;

  const reportDirectory = join(projectRoot, "reports", state.runId);
  mkdirSync(reportDirectory, { recursive: true });
  writeFileAtomicSync(join(reportDirectory, "report.html"), html);
  writeFileAtomicSync(
    join(reportDirectory, "summary.json"),
    `${JSON.stringify({ ...state, verdict, finishedPayload }, null, 2)}\n`,
  );
  updateRunIndex(projectRoot, {
    runId: state.runId,
    status: state.status,
    reportPath,
    verdict,
  });
  return reportPath;
}
