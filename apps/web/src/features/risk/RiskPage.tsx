import { useEffect, useState } from "react";
import { apiFetch } from "../../api";

type Recommendation = "BLOCKED" | "HOLD" | "GO";

interface FailingNode {
  id: string;
  label: string;
  priority: string;
  riskLevel: "critical" | "high" | "medium" | "low";
  businessRules: string[];
}

interface UntestedNode {
  id: string;
  label: string;
}

interface RuleRow {
  id: string;
  label?: string;
  severity?: string;
  jurisdiction?: string;
  status: "PASS" | "FAIL" | "UNTESTED";
}

interface RiskData {
  recommendation: Recommendation;
  statement: string;
  passRate: number;
  failingNodes: FailingNode[];
  untestedNodes: UntestedNode[];
  ruleCoverage: RuleRow[];
  manifest: { projectKey?: string };
}

const RECOMMENDATION_COLOUR: Record<Recommendation, string> = {
  BLOCKED: "#c0392b",
  HOLD: "#e09e26",
  GO: "#2d9e6b",
};

const RISK_BADGE: Record<string, string> = {
  critical: "#c0392b",
  high: "#e09e26",
  medium: "#3498db",
  low: "#95a5a6",
};

export function RiskPage() {
  const [data, setData] = useState<RiskData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch("/api/risk");
        if (!res.ok) {
          const body = (await res.json()) as { error?: string };
          setError(body.error ?? "Unable to load risk data.");
          return;
        }
        setData((await res.json()) as RiskData);
      } catch {
        setError("Unable to reach Pathlight server.");
      }
    })();
  }, []);

  if (error) {
    return (
      <main style={{ padding: 32 }}>
        <p style={{ color: "#c0392b" }}>{error}</p>
        <a href="/config">Back to config</a>
      </main>
    );
  }

  if (!data) {
    return <main style={{ padding: 32 }}>Loading risk assessment…</main>;
  }

  const recColour = RECOMMENDATION_COLOUR[data.recommendation];

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 900, margin: "0 auto", padding: 32 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <a href="/" style={{ textDecoration: "none", color: "#5c687a", fontSize: 14 }}>
          ← Fishbone
        </a>
        <h1 style={{ margin: 0, fontSize: 20 }}>Release risk assessment</h1>
      </header>

      <section
        style={{
          background: recColour + "18",
          border: `2px solid ${recColour}`,
          borderRadius: 8,
          padding: "20px 24px",
          marginBottom: 24,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 8 }}>
          <span
            style={{
              fontSize: 32,
              fontWeight: 700,
              color: recColour,
              letterSpacing: 2,
            }}
          >
            {data.recommendation}
          </span>
          <span style={{ fontSize: 14, color: "#5c687a" }}>
            Pass rate: {Math.round(data.passRate * 100)}%
          </span>
        </div>
        <p style={{ margin: 0, color: "#2d3748", lineHeight: 1.6 }}>{data.statement}</p>
      </section>

      {data.failingNodes.length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Failing journeys</h2>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
            border={1}
            cellPadding={8}
          >
            <thead>
              <tr style={{ background: "#f7fafc" }}>
                <th style={{ textAlign: "left" }}>Journey</th>
                <th style={{ textAlign: "left" }}>Priority</th>
                <th style={{ textAlign: "left" }}>Risk level</th>
                <th style={{ textAlign: "left" }}>Business rules</th>
              </tr>
            </thead>
            <tbody>
              {data.failingNodes.map((n) => (
                <tr
                  key={n.id}
                  style={{ background: n.riskLevel === "critical" ? "#fff5f5" : "white" }}
                >
                  <td>
                    <strong>{n.id}</strong> {n.label}
                  </td>
                  <td>{n.priority}</td>
                  <td>
                    <span
                      style={{
                        background: RISK_BADGE[n.riskLevel] + "22",
                        color: RISK_BADGE[n.riskLevel],
                        padding: "2px 8px",
                        borderRadius: 4,
                        fontWeight: 600,
                        textTransform: "capitalize",
                      }}
                    >
                      {n.riskLevel}
                    </span>
                  </td>
                  <td>{n.businessRules.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {data.untestedNodes.length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>Untested journeys</h2>
          <p style={{ fontSize: 13, color: "#718096", marginTop: 0 }}>
            These journeys have no automated verification. They are not included in the pass rate.
          </p>
          <ul style={{ fontSize: 13 }}>
            {data.untestedNodes.map((n) => (
              <li key={n.id}>
                <strong>{n.id}</strong> {n.label}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {data.ruleCoverage.length > 0 ? (
        <section>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>Business rule compliance</h2>
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
            border={1}
            cellPadding={8}
          >
            <thead>
              <tr style={{ background: "#f7fafc" }}>
                <th style={{ textAlign: "left" }}>Rule</th>
                <th style={{ textAlign: "left" }}>Severity</th>
                <th style={{ textAlign: "left" }}>Jurisdiction</th>
                <th style={{ textAlign: "left" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.ruleCoverage.map((r) => (
                <tr key={r.id}>
                  <td>
                    <strong>{r.id}</strong> {r.label ?? ""}
                  </td>
                  <td style={{ textTransform: "capitalize" }}>{r.severity ?? "—"}</td>
                  <td>{r.jurisdiction ?? "—"}</td>
                  <td
                    style={{
                      color:
                        r.status === "PASS"
                          ? "#2d9e6b"
                          : r.status === "FAIL"
                            ? "#c0392b"
                            : "#718096",
                      fontWeight: 600,
                    }}
                  >
                    {r.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
