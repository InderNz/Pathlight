import type { ManifestFile } from "@pathlight/manifest-schema";

export type RiskLevel = "critical" | "high" | "medium" | "low";
export type Recommendation = "BLOCKED" | "HOLD" | "GO";

export interface RiskResult {
  recommendation: Recommendation;
  statement: string;
  failingNodes: Array<{
    id: string;
    label: string;
    priority: string;
    riskLevel: RiskLevel;
    businessRules: string[];
  }>;
  untestedNodes: Array<{ id: string; label: string }>;
  passRate: number;
}

type BizRule = { id: string; label?: string; severity?: string; jurisdiction?: string };

function nodeRisk(node: ManifestFile["nodes"][number], rules: BizRule[]): RiskLevel {
  const sevs = (node.businessRuleIds ?? []).map(
    (id) => rules.find((r) => r.id === id)?.severity ?? "low",
  );
  if (sevs.includes("critical")) return "critical";
  const p = (node.priority ?? "medium").toLowerCase();
  if (/^(highest|p0|blocker)$/.test(p) || sevs.includes("high")) return "high";
  if (/^(high|p1)$/.test(p) || sevs.includes("medium")) return "medium";
  return "low";
}

export function computeRisk(
  manifest: ManifestFile,
  testResults: Record<string, { status: string }>,
  intendedNodeIds: string[],
): RiskResult {
  const rules = (manifest.businessRules ?? []) as BizRule[];
  const inScope = manifest.nodes.filter((n) => intendedNodeIds.includes(n.id));
  const total = inScope.length;
  const passed = inScope.filter((n) => testResults[n.id]?.status === "passed").length;
  const passRate = total > 0 ? passed / total : 1;

  const failingNodes = inScope
    .filter((n) => testResults[n.id]?.status === "failed")
    .map((n) => ({
      id: n.id,
      label: n.label ?? n.id,
      priority: n.priority ?? "Medium",
      riskLevel: nodeRisk(n, rules),
      businessRules: (n.businessRuleIds ?? []).map(
        (id) => rules.find((r) => r.id === id)?.label ?? id,
      ),
    }));

  const untestedInScope = inScope.filter(
    (n) => !testResults[n.id] || testResults[n.id].status === "untested",
  );
  const untestedNodes = untestedInScope.map((n) => ({ id: n.id, label: n.label ?? n.id }));

  // An untested journey covering a critical/high business rule is a coverage gap
  // that must block (critical) or hold (high) the release — not silently pass.
  const ruleSeverities = (n: ManifestFile["nodes"][number]) =>
    (n.businessRuleIds ?? []).map((id) => rules.find((r) => r.id === id)?.severity);
  const untestedCritical = untestedInScope.filter((n) => ruleSeverities(n).includes("critical"));
  const untestedHigh = untestedInScope.filter((n) => ruleSeverities(n).includes("high"));

  const hasCriticalFail = failingNodes.some((n) => n.riskLevel === "critical");
  const hasHighFail = failingNodes.some((n) => n.riskLevel === "high");
  const lowPassRate = passRate < 0.8;

  let recommendation: Recommendation;
  let statement: string;

  if (hasCriticalFail || untestedCritical.length > 0) {
    recommendation = "BLOCKED";
    if (hasCriticalFail) {
      const critRules = rules.filter(
        (r) =>
          r.severity === "critical" &&
          inScope.some(
            (n) =>
              (n.businessRuleIds ?? []).includes(r.id) && testResults[n.id]?.status === "failed",
          ),
      );
      const nzRules = critRules.filter((r) => r.jurisdiction === "NZ");
      const auRules = critRules.filter((r) => r.jurisdiction === "AU");
      const critCount = failingNodes.filter((n) => n.riskLevel === "critical").length;
      if (nzRules.length > 0) {
        statement = `${critCount} journey(s) covering NZ Privacy Act obligations are failing. Releasing may carry risk under the Privacy Act 2020 (NZ).`;
      } else if (auRules.length > 0) {
        statement = `${critCount} journey(s) covering AU Privacy Act obligations are failing. Releasing may carry risk under the Privacy Act 1988 (AU).`;
      } else {
        statement = `${critCount} critical journey(s) are failing. Releasing may carry significant risk to the core product promise.`;
      }
    } else {
      const ids = untestedCritical.map((n) => n.id).join(", ");
      statement = `Critical journey ${ids} has no automated verification. Releasing without coverage carries significant risk to the core product promise.`;
    }
  } else if (hasHighFail || untestedHigh.length > 0 || lowPassRate) {
    recommendation = "HOLD";
    if (untestedHigh.length > 0 && !hasHighFail) {
      const ids = untestedHigh.map((n) => n.id).join(", ");
      statement = `High-priority journey ${ids} has no automated verification. Core product flows may not be fully covered.`;
    } else {
      statement = `${failingNodes.length} high-priority journey(s) are failing. Core product flows may not work correctly for all users.`;
    }
  } else {
    recommendation = "GO";
    const gaps = untestedNodes.length;
    statement = `All critical journeys passed. ${passed} of ${total} journeys verified.${gaps > 0 ? ` ${gaps} journey(s) have no automated coverage — see gaps below.` : ""}`;
  }

  return { recommendation, statement, failingNodes, untestedNodes, passRate };
}
