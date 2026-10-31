"use client";

/**
 * Page integrity for one of our own sites on the admin board. Loads
 * /api/admin/site-analytics/page-integrity for the selected site (through
 * fetchWithRefresh: a 401 rotates the session) and renders PageIntegrityPanel.
 * The cross-site view ("all") asks for a site first: the report is per site.
 */
import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { PageIntegrityPanel, type PageIntegrityData } from "@/components/forcefield/PageIntegrityPanel";

export function SitePageIntegrity({ site }: { site: string }) {
  const [data, setData] = useState<PageIntegrityData | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!site || site === "all") { setState("idle"); setData(null); return; }
    let live = true;
    setState("loading");
    (async () => {
      try {
        const res = await fetchWithRefresh(`/api/admin/site-analytics/page-integrity?site=${encodeURIComponent(site)}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { integrity: PageIntegrityData };
        if (live) { setData(body.integrity); setState("ready"); }
      } catch {
        if (live) setState("error");
      }
    })();
    return () => { live = false; };
  }, [site]);

  if (state === "idle") {
    return (
      <p data-testid="admin-page-integrity-pick" className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
        Choose a site above to see what its visitors&apos; browsers saw its pages load.
      </p>
    );
  }
  if (state === "loading") return <p data-testid="admin-page-integrity-loading" className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>Loading page integrity...</p>;
  if (state === "error" || !data) return <p data-testid="admin-page-integrity-error" className="text-sm" style={{ color: "#f87171" }}>Page integrity could not be loaded. Try again in a moment.</p>;
  return <PageIntegrityPanel key={site} data={data} testId="admin-page-integrity" />;
}
