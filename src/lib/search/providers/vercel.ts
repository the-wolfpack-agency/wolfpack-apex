/**
 * Vercel provider — fans Universal Search into recent Vercel deployments.
 *
 * Treats the bare query as a project-name substring. "wolfpack-auto" returns
 * the most recent deployments for that project; multi-word queries fall back
 * to a recent-deployments list (caller-side substring match on project name).
 *
 * isEnabled: true whenever VERCEL_API_TOKEN is set.
 * Safety: API wrapper handles its own 5s timeout. Failures degrade silently
 * via the registry's outer Promise.allSettled wrapper.
 */

import type { SearchResult } from "../runSearch";
import type { RunSearchContext, SearchProvider } from "./types";
import { listDeployments, vercelIsConfigured, deploymentDashboardUrl } from "@/lib/integrations/vercel";

async function search(
  query: string,
  perTypeLimit: number,
  _ctx: RunSearchContext,
): Promise<SearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  if (!vercelIsConfigured()) return [];

  // Single-word query → treat as project name. Multi-word → fetch recent
  // deploys across all projects and filter by substring.
  const single = !/\s/.test(q);
  const res = single
    ? await listDeployments({ projectName: q, limit: perTypeLimit })
    : await listDeployments({ limit: perTypeLimit * 3 });
  if (!res.ok || !res.data) return [];

  // Normalize separators so "wolfpack auto" matches "wolfpack-auto" deploy names.
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");
  const deployments = single
    ? res.data.deployments
    : res.data.deployments.filter((d) => norm(d.name).includes(norm(q)));

  return deployments.slice(0, perTypeLimit).map((d): SearchResult => {
    const stateBadge = d.state === "READY" ? "✓" : d.state === "ERROR" ? "✗" : "…";
    const target = d.target ?? "preview";
    const commitMsg = d.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 80) ?? "";
    const branch = d.meta?.githubCommitRef ?? "";
    const snippetParts: string[] = [`${stateBadge} ${d.state}`, target];
    if (branch) snippetParts.push(branch);
    if (commitMsg) snippetParts.push(commitMsg);
    return {
      type: "vercel",
      id: d.uid,
      title: d.name,
      snippet: snippetParts.join(" · "),
      timestamp: new Date(d.readyAt ?? d.createdAt).toISOString(),
      url: deploymentDashboardUrl(d),
    };
  });
}

export const vercelProvider: SearchProvider = {
  type: "vercel",
  name: "Vercel deployments",
  countKey: "vercel",
  isEnabled: () => vercelIsConfigured(),
  search,
};
