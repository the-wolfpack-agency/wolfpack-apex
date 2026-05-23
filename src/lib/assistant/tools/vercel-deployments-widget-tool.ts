/**
 * vercel_deployments_widget — fetches recent Vercel deploys for a named
 * project and renders them inline in chat with state, environment,
 * commit message, and click-through to the Vercel dashboard.
 *
 * Trigger phrases:
 *   "show vercel deploys for wolfpack-auto"
 *   "latest deploys of wolfpack-auto"
 *   "deploy status for instinct"
 *   "vercel deployments"
 *
 * Intent regex requires either an explicit "vercel" / "deploy" keyword AND
 * a recognizable project name, OR the bare phrase "vercel deployments".
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";
import {
  listDeployments,
  vercelIsConfigured,
  deploymentDashboardUrl,
} from "@/lib/integrations/vercel";

const ParamSchema = z.object({
  projectName: z.string().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(20).default(8),
});
type Params = z.infer<typeof ParamSchema>;

interface VercelToolData {
  kind: "vercel_deployments";
  projectName: string | null;
  itemCount: number;
  durationMs: number;
}

const DEPLOY_KEYWORD_RE = /\b(vercel|deploy(?:s|ed|ment|ments|ing)?|builds?)\b/i;
// Explicit "for|of|on <project>" capture — only path that sets projectName.
// Bare phrasings like "vercel deployments" leave projectName undefined so the
// tool returns recent deploys across all projects.
const PROJECT_AFTER_PHRASE_RE =
  /(?:for|of|on)\s+([a-z][a-z0-9-]{2,49})\b/i;
// Reserved words we must never accept as a project name even when captured.
const PROJECT_NAME_BLOCKLIST = new Set([
  "deploy", "deploys", "deployed", "deployment", "deployments", "deploying",
  "vercel", "build", "builds", "status", "preview", "production", "the",
]);

function matchVercelIntent(message: string): Params | null {
  const trimmed = message.trim();
  if (!DEPLOY_KEYWORD_RE.test(trimmed)) return null;
  const explicit = PROJECT_AFTER_PHRASE_RE.exec(trimmed);
  let projectName: string | undefined;
  if (explicit) {
    const candidate = explicit[1].toLowerCase();
    if (!PROJECT_NAME_BLOCKLIST.has(candidate)) {
      projectName = explicit[1];
    }
  }
  return { projectName, limit: 8 };
}

export const vercelDeploymentsWidgetTool: ToolDef<Params, VercelToolData> = {
  name: "vercel_deployments_widget",
  description:
    "Fetch recent Vercel deployments for a named project and render them inline in chat. Read-only.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent: matchVercelIntent,
  async handler(params, ctx): Promise<ToolResult<VercelToolData>> {
    const started = Date.now();
    if (!vercelIsConfigured()) {
      return {
        ok: true,
        data: {
          kind: "vercel_deployments",
          projectName: params.projectName ?? null,
          itemCount: 0,
          durationMs: 0,
        },
        answer:
          "Vercel isn't connected yet. Set VERCEL_API_TOKEN (and optionally VERCEL_TEAM_ID) in this workspace's environment to enable Vercel deploy lookups.",
        widget: {
          kind: "vercel_deployments",
          projectName: params.projectName ?? null,
          title: "Vercel not connected",
          subtitle: "Set VERCEL_API_TOKEN to enable this widget.",
          items: [],
        },
      };
    }

    const res = await listDeployments({
      projectName: params.projectName,
      limit: params.limit,
    });
    const durationMs = Date.now() - started;
    const ok = res.ok;
    const deployments = res.ok ? (res.data?.deployments ?? []) : [];

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "vercel_deployments",
      project_name: params.projectName ?? "",
      item_count: deployments.length,
      duration_ms: durationMs,
      ok,
    });

    const spec: WidgetSpec = {
      kind: "vercel_deployments",
      projectName: params.projectName ?? null,
      title: ok
        ? deployments.length === 0
          ? params.projectName
            ? `No deploys found for ${params.projectName}`
            : "No recent deploys"
          : params.projectName
            ? `${deployments.length} recent deploy${deployments.length === 1 ? "" : "s"} of ${params.projectName}`
            : `${deployments.length} recent deploy${deployments.length === 1 ? "" : "s"}`
        : "Vercel lookup failed",
      subtitle: ok ? undefined : res.error,
      items: deployments.map((d) => ({
        id: d.uid,
        projectName: d.name,
        state: d.state,
        target: d.target ?? "preview",
        url: deploymentDashboardUrl(d),
        commitMessage: d.meta?.githubCommitMessage?.split("\n")[0]?.slice(0, 120) ?? null,
        branch: d.meta?.githubCommitRef ?? null,
        commitSha: d.meta?.githubCommitSha?.slice(0, 7) ?? null,
        createdAt: new Date(d.createdAt).toISOString(),
        readyAt: d.readyAt ? new Date(d.readyAt).toISOString() : null,
        creator: d.creator?.username ?? null,
      })),
    };

    const answer = ok
      ? deployments.length === 0
        ? params.projectName
          ? `No Vercel deployments found for "${params.projectName}".`
          : "No recent Vercel deployments."
        : `Showing the ${deployments.length} most recent deploy${deployments.length === 1 ? "" : "s"}${params.projectName ? ` for ${params.projectName}` : ""}.`
      : `Couldn't reach Vercel: ${res.error}`;

    return {
      ok: true,
      data: {
        kind: "vercel_deployments",
        projectName: params.projectName ?? null,
        itemCount: deployments.length,
        durationMs,
      },
      answer,
      widget: spec,
    };
  },
};

registerTool(vercelDeploymentsWidgetTool);
