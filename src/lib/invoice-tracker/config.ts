/**
 * Invoice Trackers — a config-driven registry of external (SharePoint) invoice
 * workbooks mirrored READ-ONLY into Instinct under one "Invoices" tab.
 *
 * PCNA is the first tracker; adding another company later is a new entry here
 * (+ its share URL). Design choices:
 *   - Access is an EXPLICIT per-tracker viewer allowlist (finance/budget data —
 *     least privilege, no role inheritance, no accidental exposure via a broad
 *     capability). Locked at the API and the nav.
 *   - The source URL is env-overridable so the sharing link can rotate without a
 *     code change; the checked-in default keeps it turnkey (a sharing link is
 *     not a secret, and the underlying file is still gated by SharePoint ACLs +
 *     this allowlist).
 */

export interface InvoiceTracker {
  /** URL slug + cache key, e.g. "pcna". Lowercase. */
  id: string;
  /** Display name of the company/tracker, e.g. "PCNA". */
  company: string;
  /** Worksheet/tab to read from the workbook. */
  sheet: string;
  /** Env var holding the SharePoint share URL; falls back to defaultShareUrl. */
  shareUrlEnv: string;
  /** Fallback share URL when the env var is unset. */
  defaultShareUrl: string;
  /** Emails permitted to view this tracker (compared case-insensitively). */
  viewers: string[];
  /** Headers that use the workbook "section header" pattern (value on the first
   *  row of a group, blank below) and should be forward-filled. Optional. */
  forwardFill?: string[];
}

export const INVOICE_TRACKERS: InvoiceTracker[] = [
  {
    id: "pcna",
    company: "PCNA",
    sheet: "Summary",
    shareUrlEnv: "INVOICE_TRACKER_PCNA_SHARE_URL",
    defaultShareUrl:
      "https://netorg9503444.sharepoint.com/:x:/s/PCNAINTERNAL-BudgetandSOWs/IQBp1H11chEjSKCD0IpMu2gHAe6pNLD0QJFEc_QqHdNDe1Y?e=Iby524",
    viewers: [
      "homyk@thewolfpack.agency",
      "nick@thewolfpack.agency",
      "jorge@thewolfpack.agency",
    ],
  },
];

export function getTracker(id: string | undefined | null): InvoiceTracker | undefined {
  if (!id) return undefined;
  const slug = id.trim().toLowerCase();
  return INVOICE_TRACKERS.find((t) => t.id === slug);
}

/** Case-insensitive allowlist check. Empty/missing email is denied. */
export function canViewTracker(tracker: InvoiceTracker, email: string | null | undefined): boolean {
  if (!email) return false;
  const e = email.trim().toLowerCase();
  return e.length > 0 && tracker.viewers.some((v) => v.toLowerCase() === e);
}

/** Every tracker the given viewer may access (drives the nav + index page). */
export function trackersForViewer(email: string | null | undefined): InvoiceTracker[] {
  return INVOICE_TRACKERS.filter((t) => canViewTracker(t, email));
}

export function shareUrlFor(tracker: InvoiceTracker): string {
  return process.env[tracker.shareUrlEnv] || tracker.defaultShareUrl;
}
