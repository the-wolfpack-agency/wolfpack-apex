"use client";

/**
 * The AI visibility report for one of our own sites on the admin board. Loads
 * /api/admin/site-analytics/ai-visibility for the selected site (through
 * fetchWithRefresh: a 401 rotates the session) and renders AiVisibilityPanel.
 * The cross-site view ("all") asks for a site first: the report is per site.
 */
import { useEffect, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { AiVisibilityPanel, type AiVisibilityData } from "@/components/forcefield/AiVisibilityPanel";

export function SiteAiVisibility({ site, days }: { site: string; days: number }) {
  const [data, setData] = useState<AiVisibilityData | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!site || site === "all") { setState("idle"); setData(null); return; }
    let live = true;
    setState("loading");
    (async () => {
      try {
        const res = await fetchWithRefresh(`/api/admin/site-analytics/ai-visibility?site=${encodeURIComponent(site)}&days=${days}`);
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { visibility: AiVisibilityData };
        if (live) { setData(body.visibility); setState("ready"); }
      } catch {
        if (live) setState("error");
      }
    })();
    return () => { live = false; };
  }, [site, days]);

  if (state === "idle") {
    return (
      <p data-testid="admin-ai-visibility-pick" className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>
        Choose a site above to see which AI agents and search engines read it.
      </p>
    );
  }
  if (state === "loading") return <p data-testid="admin-ai-visibility-loading" className="text-sm" style={{ color: "var(--wp-muted, #9aa0a6)" }}>Loading AI visibility...</p>;
  if (state === "error" || !data) return <p data-testid="admin-ai-visibility-error" className="text-sm" style={{ color: "#f87171" }}>AI visibility could not be loaded. Try again in a moment.</p>;
  return <AiVisibilityPanel data={data} testId="admin-ai-visibility" />;
}
