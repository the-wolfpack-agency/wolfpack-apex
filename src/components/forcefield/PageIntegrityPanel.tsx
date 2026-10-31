"use client";

/**
 * Page integrity: what visitors' browsers saw a site's pages load from places the
 * site never uses (an injected card skimmer, a hijacked script, a form posting to
 * a stranger). Presentational only: the report comes from page-integrity.ts (the
 * client dashboard via /api/forcefield/my-stats, our own sites via
 * /api/admin/site-analytics/page-integrity). Renders explicit empty and learning
 * states.
 */
import { GlassPanel } from "@/components/console";

type Directive = "script-src" | "frame-src" | "connect-src" | "form-action";

export interface PageIntegrityData {
  learning: { startedAt: string; endsAt: string; active: boolean } | null;
  origins: Array<{
    directive: Directive;
    origin: string;
    status: "baseline" | "new";
    wouldAlert: boolean;
    firstSeen: string;
    lastSeen: string;
    reports: number;
    sessions: number;
    pages: number;
    sessions24h: number;
    pages24h: number;
    topPage: string | null;
  }>;
  totals: { origins: number; newOrigins: number; wouldAlert: number };
}

const WHAT: Record<Directive, string> = {
  "script-src": "Runs a script from",
  "frame-src": "Embeds a frame from",
  "connect-src": "Sends data to",
  "form-action": "Submits a form to",
};
const MUTED = "var(--wp-muted, #9aa0a6)";
const day = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
};

function Headline({ data, testId }: { data: PageIntegrityData; testId: string }) {
  const { totals, learning } = data;
  if (learning?.active) {
    return (
      <p data-testid={`${testId}-learning`} className="text-sm" style={{ color: MUTED }}>
        Learning what your pages normally load, until {day(learning.endsAt)}. Nothing seen in this time is treated as new.
      </p>
    );
  }
  if (totals.wouldAlert > 0) {
    return (
      <p data-testid={`${testId}-headline`} className="text-sm font-medium" style={{ color: "#f87171" }}>
        {totals.wouldAlert === 1 ? "1 new place is" : `${totals.wouldAlert} new places are`} reaching many of your visitors' browsers. Check the rows marked below with whoever manages your site.
      </p>
    );
  }
  if (totals.newOrigins > 0) {
    return (
      <p data-testid={`${testId}-headline`} className="text-sm" style={{ color: "#fbbf24" }}>
        {totals.newOrigins === 1 ? "1 new place has" : `${totals.newOrigins} new places have`} appeared since the baseline, each for only a few visitors. That is usually a browser extension on one person's computer, not your site.
      </p>
    );
  }
  return (
    <p data-testid={`${testId}-headline`} className="text-sm" style={{ color: "#34d399" }}>
      Your pages load only what they loaded during the baseline.
    </p>
  );
}

export function PageIntegrityPanel({ data, testId = "page-integrity" }: { data: PageIntegrityData; testId?: string }) {
  return (
    <GlassPanel>
      <div data-testid={testId}>
        <h3 className="mb-1 text-base font-semibold">Page integrity</h3>
        <p className="mb-3 text-sm" style={{ color: MUTED }}>
          Each visitor's browser reports when a page loads something from a place your site does not use, such as an injected card skimmer or a hijacked script. This only watches: nothing on your pages is changed or blocked.
        </p>
        {data.learning === null ? (
          <p data-testid={`${testId}-empty`} className="text-sm" style={{ color: MUTED }}>
            No reports yet. They start once your pages send the page integrity header, and an empty list means visitors' browsers have seen nothing unexpected.
          </p>
        ) : (
          <>
            <Headline data={data} testId={testId} />
            {data.origins.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr style={{ color: MUTED }}>
                      <th className="py-1 pr-3 font-normal">What the page did</th>
                      <th className="py-1 pr-3 font-normal">Status</th>
                      <th className="py-1 pr-3 text-right font-normal">Visitors</th>
                      <th className="py-1 pr-3 text-right font-normal">Pages</th>
                      <th className="py-1 font-normal">Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.origins.map((o, i) => (
                      <tr key={`${o.directive}|${o.origin}`} data-testid={`${testId}-row-${i}`} className="border-t" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
                        <td className="py-2 pr-3">
                          <span style={{ color: MUTED }}>{WHAT[o.directive] ?? o.directive} </span>
                          <span className="font-mono break-all">{o.origin}</span>
                          {o.topPage && <span className="block text-xs" style={{ color: MUTED }}>most often on {o.topPage}</span>}
                        </td>
                        <td className="py-2 pr-3" data-testid={`${testId}-status-${i}`}>
                          {o.wouldAlert ? (
                            <span style={{ color: "#f87171" }}>New, many visitors</span>
                          ) : o.status === "new" ? (
                            <span style={{ color: "#fbbf24" }}>New since {day(o.firstSeen)}</span>
                          ) : (
                            <span style={{ color: MUTED }}>Seen in the baseline</span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-right tabular-nums">{o.sessions.toLocaleString()}</td>
                        <td className="py-2 pr-3 text-right tabular-nums">{o.pages.toLocaleString()}</td>
                        <td className="py-2">{day(o.lastSeen)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </GlassPanel>
  );
}
