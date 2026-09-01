"use client";

/**
 * /builds/insight-scan - results against plan, and what the data will not carry.
 *
 * ORDERED AS AN ARGUMENT. The actions first, because that is what a team came
 * for. Then what was NOT actioned and why, then what the scan refuses to claim
 * at all, then the plan it measured against. A reader who stops after the
 * first section has the recommendations; a reader who keeps going can take any
 * one of them apart.
 *
 * The competitor's version has no equivalent of the second and third sections,
 * which is why it can only be accepted or rejected whole.
 */

import { useEffect, useState } from "react";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/insight-scan")!;

interface Gap {
  dimension: string;
  value: string;
  planned: number;
  actual: number;
  variance: number;
  records: number;
}
interface Recommendation {
  action: string;
  gap: Gap;
  confidence: "strong" | "limited" | "insufficient";
  basis: string;
  successSignal: string;
  wouldBeWrongIf: string;
}
interface Scan {
  readable: boolean;
  summary?: string;
  records?: number;
  documents?: number;
  unattributed?: number;
  plan?: { dimension: string; value: string; planned: number; unit: string }[];
  withheld?: { claim: string; why: string }[];
  recommendations?: Recommendation[];
  notActionable?: { about: string; why: string }[];
  durationMs?: number;
}

export default function InsightScanPage() {
  const [scan, setScan] = useState<Scan | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    /* Authenticated page: send a signed-out visitor to the login screen rather
       than drawing an empty shell, which is the April 16 regression. */
    if (!getInstinctToken()) {
      window.location.href = "/login?next=/builds/insight-scan";
      return;
    }
    fetchWithRefresh("/api/insights/dataset-scan")
      .then((r) => r.json())
      .then((d: Scan) => setScan(d))
      .catch(() => setFailed(true));
  }, []);

  return (
    <main className="wp-pilot" data-testid="insight-scan">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Results against plan</p>
        <h1>What to do, and what the data will not carry</h1>
        <p className="wp-pilot-sub">
          Every action below names the gap it closes, the records under it, what would show it
          worked, and what would make it wrong. The ones this will not recommend are on the page
          too, with the reason, because a page that hides its refusals describes a cleaner dataset
          than the one it read.
        </p>
      </header>

      {failed || (scan && !scan.readable) ? (
        <section className="wp-pilot-section" data-testid="scan-unreadable">
          <p className="wp-pilot-aside">
            This dataset could not be read, which is not the same as it having nothing in it.
            Nothing here should be taken as a result.
          </p>
        </section>
      ) : !scan ? (
        <p className="wp-pilot-aside" data-testid="scan-loading">
          Reading the records…
        </p>
      ) : (
        <>
          <section className="wp-pilot-section" data-testid="scan-actions">
            <h2>For the C&amp;I team</h2>
            <p className="wp-pilot-aside" data-testid="scan-summary">
              {scan.summary}
            </p>
            <ul className="wp-build-findings">
              {(scan.recommendations ?? []).map((r) => (
                <li key={r.action}>
                  <h3>{r.action}</h3>
                  <p className="wp-build-evidence">
                    <span className={`wp-build-travel wp-build-travel--${r.confidence}`}>
                      {r.confidence}
                    </span>{" "}
                    {r.basis}
                  </p>
                  <p>
                    <strong>Worked if:</strong> {r.successSignal}
                  </p>
                  <p>
                    <strong>Wrong if:</strong> {r.wouldBeWrongIf}
                  </p>
                </li>
              ))}
              {(scan.recommendations ?? []).length === 0 ? (
                <li data-testid="scan-no-actions">
                  <p>
                    Nothing in this dataset clears the bar for an action. That is a result, not an
                    empty page.
                  </p>
                </li>
              ) : null}
            </ul>
          </section>

          {(scan.notActionable ?? []).length > 0 ? (
            <section className="wp-pilot-section" data-testid="scan-not-actioned">
              <h2>Gaps left alone, and why</h2>
              <p className="wp-pilot-aside">
                Real differences against plan that this will not turn into an action. Each one is a
                line a less careful scan would have recommended acting on.
              </p>
              <ul className="wp-pilot-list">
                {(scan.notActionable ?? []).map((n) => (
                  <li key={n.about}>
                    <strong>{n.about}</strong> {n.why}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {(scan.withheld ?? []).length > 0 ? (
            <section className="wp-pilot-section" data-testid="scan-withheld">
              <h2>What this scan will not claim</h2>
              <ul className="wp-pilot-list">
                {(scan.withheld ?? []).map((w) => (
                  <li key={w.claim}>
                    <strong>{w.claim}.</strong> {w.why}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {/* THE PLAN, ON THE PAGE. A variance is meaningless without the
              number it was measured against, and a reader who cannot see the
              plan can only trust the gap rather than check it. */}
          <section className="wp-pilot-section" data-testid="scan-plan">
            <h2>What it measured against</h2>
            <p className="wp-pilot-aside">
              An illustrative plan, ours rather than the client&apos;s. Read from{" "}
              {scan.records?.toLocaleString()} records across {scan.documents} documents in{" "}
              {Math.round((scan.durationMs ?? 0) / 100) / 10}s.
              {scan.unattributed ? (
                <>
                  {" "}
                  {scan.unattributed.toLocaleString()} records had a field that could not be
                  attributed to a row, so the totals read as at least this many rather than exactly.
                </>
              ) : null}
            </p>
            <div className="wp-build-table-wrap">
              <table className="wp-build-table">
                <thead>
                  <tr>
                    <th scope="col">Dimension</th>
                    <th scope="col">Value</th>
                    <th scope="col">Planned</th>
                  </tr>
                </thead>
                <tbody>
                  {(scan.plan ?? []).map((p) => (
                    <tr key={`${p.dimension}-${p.value}`}>
                      <td>{p.dimension}</td>
                      <td>{p.value}</td>
                      <td>
                        {p.planned.toLocaleString()} {p.unit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
