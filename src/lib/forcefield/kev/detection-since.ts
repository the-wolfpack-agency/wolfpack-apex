/**
 * When Forcefield began recognizing each known-exploited CVE (YYYY-MM-DD, the day its rule or
 * detector merged). The board's "time to first probe" needs it: the first probe on our sites can
 * only be measured from the day we could see it, so a lead time is shown only for a CVE we were
 * already watching when CISA listed it; otherwise the board says detection began later.
 * Kept here, not in the portable core (kev-rules.ts is vendored by every protected site). A test
 * fails when a CVE the rules reference has no date here. Dates from the repository history:
 *   2026-10-07  9dbef875  Log4Shell payload family
 *   2026-10-24  19b99841  next_server_action probe (React2Shell)
 *   2026-10-26  cd2b1443  body-borne PHP2Shell / React2Shell, and the KEV probe rules
 */
export const KEV_DETECTION_SINCE: Readonly<Record<string, string>> = {
  "CVE-2021-44228": "2026-10-07",
  "CVE-2025-55182": "2026-10-24",
  "CVE-2026-109618": "2026-10-26",
  "CVE-2026-109619": "2026-10-26",
  "CVE-2012-1823": "2026-10-26",
  "CVE-2017-9841": "2026-10-26",
  "CVE-2018-13379": "2026-10-26",
  "CVE-2019-11510": "2026-10-26",
  "CVE-2019-19781": "2026-10-26",
  "CVE-2019-9978": "2026-10-26",
  "CVE-2020-11738": "2026-10-26",
  "CVE-2020-25213": "2026-10-26",
  "CVE-2020-3452": "2026-10-26",
  "CVE-2020-5902": "2026-10-26",
  "CVE-2022-1388": "2026-10-26",
  "CVE-2023-46805": "2026-10-26",
  "CVE-2024-21887": "2026-10-26",
  "CVE-2024-4577": "2026-10-26",
};

const DAY_MS = 86_400_000;
const day = (d: string | null | undefined) => (/^\d{4}-\d{2}-\d{2}/.test(d ?? "") ? Date.parse(`${(d as string).slice(0, 10)}T00:00:00Z`) : NaN);

/** The time from a CVE's KEV listing to its first probe on our sites (pure). `measured` only when
 *  detection was live on the listing day (otherwise an earlier probe could not have been seen). */
export function exploitLead(cve: string, kevAdded: string | null, firstProbe: string | null): { detectionSince: string | null; leadDays: number | null; measured: boolean } {
  const since = KEV_DETECTION_SINCE[cve] ?? null;
  const listed = day(kevAdded), first = day(firstProbe), live = day(since);
  if (!Number.isFinite(listed) || !Number.isFinite(first)) return { detectionSince: since, leadDays: null, measured: false };
  const measured = Number.isFinite(live) && live <= listed;
  return { detectionSince: since, leadDays: Math.round((first - listed) / DAY_MS), measured };
}
