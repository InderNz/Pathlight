import type { ManifestFile } from "@pathlight/manifest-schema";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface ComplianceSummary {
  runId?: string;
  verdict?: string;
  intendedNodeIds?: string[];
  testResults?: Record<string, { status: string }>;
  nodeTestResults?: Record<string, string[]>;
}

export function buildComplianceHtml(
  targetRunId: string,
  manifest: ManifestFile,
  summary: ComplianceSummary,
): string {
  type BizRule = { id: string; label?: string; severity?: string; jurisdiction?: string };
  const rules = (manifest.businessRules ?? []) as BizRule[];
  const ruleRows = rules
    .map((rule) => {
      const nodes = manifest.nodes.filter((n) => (n.businessRuleIds ?? []).includes(rule.id));
      const statuses = nodes.flatMap((n) => summary.nodeTestResults?.[n.id] ?? []);
      const status = statuses.includes("failed")
        ? "FAIL"
        : statuses.every((s) => s === "passed")
          ? "PASS"
          : "UNTESTED";
      return `<tr><td>${escapeHtml(rule.id)}</td><td>${escapeHtml(rule.label ?? "")}</td><td>${escapeHtml(rule.severity ?? "")}</td><td>${escapeHtml(rule.jurisdiction ?? "")}</td><td>${status}</td></tr>`;
    })
    .join("");

  const journeyRows = manifest.nodes
    .filter((n) => (summary.intendedNodeIds ?? []).includes(n.id))
    .map(
      (n) =>
        `<tr><td>${escapeHtml(n.id)}</td><td>${escapeHtml(n.label ?? "")}</td><td>${escapeHtml(summary.testResults?.[n.id]?.status ?? "untested")}</td></tr>`,
    )
    .join("");

  const now = new Date().toISOString();
  const verdictColor =
    summary.verdict === "PASSED"
      ? "#2d9e6b"
      : summary.verdict === "WARNING"
        ? "#e09e26"
        : "#c0392b";

  return `<!doctype html>
<html><head><meta charset="utf-8">
<title>Pathlight Compliance Audit Trail — ${escapeHtml(targetRunId)}</title>
<style>
body{font-family:Georgia,serif;max-width:800px;margin:0 auto;padding:40px;color:#1a202c}
h1{font-size:22px;border-bottom:2px solid #2d9e6b;padding-bottom:8px}
h2{font-size:16px;margin-top:24px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{border:1px solid #e2e8f0;padding:8px;text-align:left}
th{background:#f7fafc;font-weight:600}
.verdict{font-size:20px;font-weight:700;color:${verdictColor}}
.meta{font-size:12px;color:#718096}
.disclaimer{font-size:12px;color:#975a16;background:#fffaf0;border:1px solid #f6e05e;border-radius:4px;padding:10px 12px;margin-bottom:16px}
</style></head><body>
<p class="disclaimer">This is a Pathlight compliance summary report. It is not a legally binding document.</p>
<h1>Pathlight Compliance Audit Trail</h1>
<p class="meta">Project: ${escapeHtml(manifest.projectKey)} · Run: ${escapeHtml(targetRunId)} · Generated: ${escapeHtml(now)}</p>
<p class="verdict">Release verdict: ${escapeHtml(summary.verdict ?? "UNKNOWN")}</p>
<h2>Business rule verification</h2>
${ruleRows ? `<table><thead><tr><th>Rule ID</th><th>Label</th><th>Severity</th><th>Jurisdiction</th><th>Status</th></tr></thead><tbody>${ruleRows}</tbody></table>` : "<p>No business rules configured.</p>"}
<h2>Journey results</h2>
<table><thead><tr><th>Journey ID</th><th>Label</th><th>Status</th></tr></thead><tbody>
${journeyRows}
</tbody></table>
<p class="meta">Immutable audit record. Run ID: ${escapeHtml(targetRunId)}. Manifest locked by: ${escapeHtml(manifest.lockedBy ?? "unknown")} at ${escapeHtml(manifest.lockedAt ?? "unknown")}.</p>
</body></html>`;
}
