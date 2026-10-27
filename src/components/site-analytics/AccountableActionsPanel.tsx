"use client";

/**
 * "Actions need a person": per protected site, who was accountable for each
 * state-changing request (form submit, login, sign-up, checkout, account
 * change, data export), and how many "hold for review" WOULD have held.
 *
 * Watch mode: nothing is held. The would-hold column is the number that
 * decides whether holding is ever turned on (docs/forcefield/accountable-
 * actions.md). Every state is explicit: not loaded or the read failed (an
 * error, never a zero), and an empty window. Presentational: the page owns the
 * fetch (the board summary carries it, forcefield.view only).
 */
import type { CSSProperties } from "react";
import { card, label } from "@/components/site-analytics/styles";
import type { AccountableActionsSummary } from "@/lib/site-analytics-accountability";

const muted: CSSProperties = { fontSize: "0.76rem", color: "var(--wp-text-muted, #9ca3af)", margin: 0, lineHeight: 1.5 };
const th: CSSProperties = { textAlign: "right", fontWeight: 600, fontSize: "0.68rem", textTransform: "uppercase", letterSpacing: "0.03em", color: "var(--wp-text-muted, #9ca3af)", padding: "0.3rem 0.5rem", borderBottom: "1px solid var(--wp-dark-border, #262a33)", whiteSpace: "nowrap" };
const td: CSSProperties = { textAlign: "right", padding: "0.35rem 0.5rem", fontSize: "0.8rem", color: "var(--wp-text, #eee)", borderBottom: "1px solid var(--wp-dark-border, #1d2129)", fontVariantNumeric: "tabular-nums" };
const AMBER = "var(--wp-warning, #f5a623)";

/** Plain-language names for why an action would have been held. */
export const HOLD_REASON_LABEL: Record<string, string> = {
  principal_unverified: "agent's signature did not verify",
  agent_without_principal: "known agent, no person or organization named",
  browser_from_datacenter: "browser from a cloud network",
  no_fetch_metadata: "browser without browser request headers",
  header_mismatch: "claims a browser, does not look like one",
  headless_browser: "automated browser",
  script_client: "script or tool",
  verified_principal: "signed agent outside its mandate",
};

export function AccountableActionsPanel({ data, rangeDays }: { data?: AccountableActionsSummary; rangeDays: number }) {
  const ok = !!data && data.available !== false && !!data.totals && Array.isArray(data.sites);
  return (
    <div style={{ ...card, display: "grid", gap: "0.8rem" }} data-testid="ff-accountable">
      <div style={{ display: "flex", alignItems: "baseline", gap: "0.5rem", flexWrap: "wrap" }}>
        <span style={label}>Actions need a person &middot; last {rangeDays}d</span>
        <span style={{ fontSize: "0.7rem", color: "var(--wp-text-muted, #8b90a0)" }}>
          watch mode: recorded, never held
        </span>
      </div>
      <p style={muted}>
        Anyone may read the site. A form submission, login, sign-up, checkout, account change or export should come from a real browser, or from an AI agent whose verified signature names who it acts for.
      </p>

      {!ok && (
        <p data-testid="ff-accountable-error" role="alert" style={{ ...muted, color: AMBER }}>
          Action accountability could not be loaded. The counts are unknown, not zero.
        </p>
      )}
      {ok && data.totals.total === 0 && (
        <p data-testid="ff-accountable-empty" style={muted}>
          No state-changing requests were recorded in this window. This fills in as protected sites report form submissions, logins and other actions.
        </p>
      )}
      {ok && data.totals.total > 0 && <Ready data={{ ...data, heldReasons: data.heldReasons ?? [], kinds: data.kinds ?? [] }} />}
    </div>
  );
}

function Ready({ data }: { data: AccountableActionsSummary }) {
  const t = data.totals;
  return (
    <>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "1.4rem", alignItems: "baseline" }}>
        <span>
          <strong data-testid="ff-accountable-total" style={{ fontSize: "1.4rem", color: "var(--wp-text, #eee)" }}>{t.total.toLocaleString()}</strong>{" "}
          <span style={muted}>actions</span>
        </span>
        <span>
          <strong data-testid="ff-accountable-would-hold" style={{ fontSize: "1.4rem", color: t.wouldHold > 0 ? AMBER : "var(--wp-text, #eee)" }}>{t.wouldHold.toLocaleString()}</strong>{" "}
          <span style={muted}>would have been held for review if holding were on</span>
        </span>
      </div>

      <div style={{ overflowX: "auto", maxWidth: "100%" }}>
        <table data-testid="ff-accountable-table" style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: "left" }}>Site</th>
              <th style={th}>Browser</th>
              <th style={th}>Signed agent, in mandate</th>
              <th style={th}>Signed agent, outside</th>
              <th style={th}>Unaccountable</th>
              <th style={th}>Would hold</th>
            </tr>
          </thead>
          <tbody>
            {data.sites.map((s) => (
              <tr key={s.site} data-testid={`ff-accountable-site-${s.site}`}>
                <td style={{ ...td, textAlign: "left" }}>{s.site}</td>
                <td style={td}>{s.browserSession.toLocaleString()}</td>
                <td style={td}>{s.signedWithin.toLocaleString()}</td>
                <td style={td}>{s.signedOutside.toLocaleString()}</td>
                <td style={td}>{s.unaccountable.toLocaleString()}</td>
                <td style={{ ...td, color: s.wouldHold > 0 ? AMBER : td.color, fontWeight: s.wouldHold > 0 ? 700 : 400 }}>{s.wouldHold.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data.heldReasons.length > 0 && (
        <div data-testid="ff-accountable-reasons" style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem" }}>
          {data.heldReasons.map((r) => (
            <span
              key={r.reason}
              data-testid={`ff-accountable-reason-${r.reason}`}
              style={{ display: "inline-flex", gap: "0.3rem", fontSize: "0.72rem", color: "var(--wp-text, #eee)", border: `1px dashed ${AMBER}`, borderRadius: 999, padding: "0.15rem 0.55rem" }}
            >
              {HOLD_REASON_LABEL[r.reason] ?? r.reason.replace(/_/g, " ")} <strong style={{ color: AMBER }}>{r.count.toLocaleString()}</strong>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
