"use client";

/**
 * The AI visibility report for one of our own sites on the admin board, with its
 * AI training crawler policy. Loads /api/admin/site-analytics/ai-visibility and
 * /api/admin/forcefield/agent-policy for the selected site (through
 * fetchWithRefresh: a 401 rotates the session) and renders AiVisibilityPanel.
 * The policy is editable only for a caller allowed to change it (canEdit). The
 * cross-site view ("all") asks for a site first: both are per site.
 */
import { useEffect, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { AiVisibilityPanel, type AiVisibilityData, type TrainingControl } from "@/components/forcefield/AiVisibilityPanel";

interface Policy { choices: string[]; blockedAgents: string[]; canEdit: boolean }

export function SiteAiVisibility({ site, days }: { site: string; days: number }) {
  const [data, setData] = useState<AiVisibilityData | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error">("idle");

  useEffect(() => {
    if (!site || site === "all") { setState("idle"); setData(null); setPolicy(null); return; }
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
      // The policy is separate: a failed read hides the control, never the report.
      try {
        const res = await fetchWithRefresh(`/api/admin/forcefield/agent-policy?site=${encodeURIComponent(site)}`);
        if (res.ok && live) {
          // Only a well-formed policy shows the control (an older API or an error
          // body hides it, never breaks the report).
          const b = (await res.json()) as Partial<Policy>;
          if (Array.isArray(b.choices) && Array.isArray(b.blockedAgents)) setPolicy({ choices: b.choices, blockedAgents: b.blockedAgents, canEdit: b.canEdit === true });
        }
      } catch { /* control stays hidden */ }
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
  const control: TrainingControl | undefined = policy && policy.choices.length > 0
    ? {
        choices: policy.choices,
        blocked: policy.blockedAgents,
        canEdit: policy.canEdit,
        save: async (blocked) => {
          const res = await fetchWithRefresh(`/api/admin/forcefield/agent-policy?site=${encodeURIComponent(site)}`, {
            method: "PUT",
            headers: jsonHeaders(),
            body: JSON.stringify({ blockedAgents: blocked }),
          });
          return res.ok;
        },
      }
    : undefined;
  return <AiVisibilityPanel key={site} data={data} testId="admin-ai-visibility" control={control} />;
}
