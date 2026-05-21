/**
 * /job-codes/[code] — per-code dossier.
 *
 * The Instinct differentiator: a single code's view rolls up data
 * from the SharePoint cache, applied receipt scans, and the audit
 * log. Editing stays on the index page; this view is read-only.
 *
 * Server component shell + client `<CodeDossierView>` that fetches
 * the dossier through `fetchWithRefresh`. We can't fetch from the
 * server component because JWTs live in localStorage; the same
 * client-fetch pattern as the rest of the dashboard is the right
 * call here.
 */

import type { Metadata } from "next";
import { CodeDossierView } from "@/components/job-codes/CodeDossierView";

export const metadata: Metadata = {
  title: "Job Code Dossier — Wolfpack Instinct",
  description: "Cross-source dossier for one job code: rollups, receipts, activity.",
};

export default async function JobCodeDossierPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return (
    <main className="flex-1 p-4 md:p-6" data-testid="job-code-dossier-page">
      <CodeDossierView code={code} />
    </main>
  );
}
