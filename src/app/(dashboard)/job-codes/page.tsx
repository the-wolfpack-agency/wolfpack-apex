/**
 * /job-codes — read-only Job Codes browser.
 *
 * Source of truth: the Wolfpack 2026 Job Codes xlsx in SharePoint.
 * This page never lets the user edit codes — they're maintained by
 * finance/HR in the source workbook. The "Refresh now" button is
 * admin-only and triggers a Graph re-pull.
 *
 * Loads via /api/job-codes which:
 *   - returns the cached rows immediately when the cache is fresh
 *   - transparently refreshes from Graph when stale
 *   - falls back to serving the stale cache + a banner when Graph
 *     is down, so the page never blanks on a transient Graph error.
 */

import type { Metadata } from "next";
import { JobCodesTable } from "@/components/job-codes/JobCodesTable";

export const metadata: Metadata = {
  title: "Job Codes — Wolfpack Instinct",
  description: "Read-only view of the Wolfpack job codes synced live from SharePoint.",
};

export default function JobCodesPage() {
  return (
    <main className="flex-1 p-4 md:p-6" data-testid="job-codes-page">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
          Job Codes
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          Live view of the Wolfpack Job Codes workbook in SharePoint. Codes are
          maintained there — Instinct mirrors them here for time tracking and
          search.
        </p>
      </header>
      <JobCodesTable />
    </main>
  );
}
