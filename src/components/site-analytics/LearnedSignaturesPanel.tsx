/**
 * Learned hostile-tradecraft signatures panel: shadow (proving) / enforcing /
 * operators auto-blocked. Presentational; reads only the learnedSignatures slice.
 */
import { card, label } from "@/components/site-analytics/styles";

export interface LearnedSignaturesData { shadow: number; enforcing: number; autoBlocked: number }

export function LearnedSignaturesPanel({ data }: { data?: LearnedSignaturesData }) {
  return (
          <details className="ff-collapse" style={card} data-testid="ff-learned-signatures">
            <summary>
              <span style={label}>Learned hostile-tradecraft signatures</span>
              <span style={{ ...label, display: "flex", alignItems: "center", gap: "0.4rem" }}>
                {((data?.shadow ?? 0) + (data?.enforcing ?? 0)).toLocaleString()} <span className="ff-chev">&#9656;</span>
              </span>
            </summary>
            <div style={{ fontSize: "0.8rem", color: "var(--wp-text-muted, #9ca3af)", marginTop: "0.35rem", lineHeight: 1.5 }}>
              Recurring tool/action combos mined from operators we&apos;ve already caught. A signature must be exhibited by multiple distinct hostiles and prove zero false positives against good agents before it earns auto-block, so the corpus makes detection faster without risking legitimate traffic.
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "1rem", marginTop: "0.8rem" }}>
              <div>
                <div style={{ ...label, color: "var(--wp-gold, #e8b528)" }}>Shadow (proving)</div>
                <div data-testid="sig-shadow" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {(data?.shadow ?? 0).toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-error, #ef4444)" }}>Enforcing</div>
                <div data-testid="sig-enforcing" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {(data?.enforcing ?? 0).toLocaleString()}
                </div>
              </div>
              <div>
                <div style={{ ...label, color: "var(--wp-error, #ef4444)" }}>Operators auto-blocked</div>
                <div data-testid="sig-autoblocked" style={{ marginTop: "0.25rem", fontSize: "1.5rem", fontWeight: 700, color: "var(--wp-text, #eee)" }}>
                  {(data?.autoBlocked ?? 0).toLocaleString()}
                </div>
              </div>
            </div>
          </details>
  );
}
