/**
 * integrations_list — show every integration the assistant knows about.
 * Auto-discovers from the search-provider registry + widget-bearing
 * tool registry so a new integration appears here the moment it ships,
 * without touching this file.
 *
 * Trigger phrases:
 *   "what integrations do I have"
 *   "list integrations"
 *   "show all integrations"
 *   "what can the assistant do"
 *   "show all widgets"
 */

import { z } from "zod";
import { trackEvent } from "@/lib/analytics";
import { registerTool, getTools } from "./registry";
import type { ToolDef, ToolResult } from "./types";
import type { WidgetSpec } from "@/lib/assistant/widgets/types";
import { SEARCH_PROVIDERS } from "@/lib/search/providers";

const ParamSchema = z.object({});
type Params = z.infer<typeof ParamSchema>;

interface IntegrationsListData {
  kind: "integrations_list";
  integrationCount: number;
}

const INTENT_RE =
  /\b(list|show|see|what)\s+(all\s+)?(my\s+)?(integrations?|widgets?|connectors?|tools?)\b|\bwhat\s+can\s+(the\s+)?assistant\s+do\b/i;

function matchIntent(message: string): Params | null {
  if (!INTENT_RE.test(message.trim())) return null;
  return {};
}

/* Augmentation metadata — friendly label + category for surfaces the
 * registries don't carry that data for. Falls back to the registry
 * name + a default category when missing. Keep keys sorted. */
const INTEGRATION_META: Record<
  string,
  {
    label: string;
    category: "messaging" | "scheduling" | "data" | "ops" | "knowledge" | "finance";
    sampleQuery: string;
  }
> = {
  calendar: {
    label: "Calendar (Microsoft 365)",
    category: "scheduling",
    sampleQuery: "what is on my calendar today",
  },
  chats: {
    label: "Teams Chats",
    category: "messaging",
    sampleQuery: "find chats from Hoxsie",
  },
  channels: {
    label: "Teams Channels",
    category: "messaging",
    sampleQuery: "find channel messages about deploy",
  },
  emails: {
    label: "Outlook Email",
    category: "messaging",
    sampleQuery: "find emails from Alicia",
  },
  knowledge: {
    label: "Knowledge Base",
    category: "knowledge",
    sampleQuery: "search knowledge for onboarding",
  },
  crm: {
    label: "CRM (Salesforce / HubSpot)",
    category: "data",
    sampleQuery: "search Porsche",
  },
  dms: {
    label: "Dealer DMS",
    category: "data",
    sampleQuery: "show me 2024 hondas",
  },
  vercel: {
    label: "Vercel Deployments",
    category: "ops",
    sampleQuery: "show vercel deploys for wolfpack-auto",
  },
};

const TOOL_META: Record<
  string,
  { label: string; category: string; sampleQuery: string }
> = {
  search_github_pull_requests: {
    label: "GitHub Pull Requests",
    category: "ops",
    sampleQuery: "show open PRs in wolfpack-apex",
  },
  search_github_issues: {
    label: "GitHub Issues",
    category: "ops",
    sampleQuery: "show open issues in wolfpack-auto",
  },
  meeting_prep: {
    label: "Meeting Prep",
    category: "scheduling",
    sampleQuery: "prep me for my 3pm meeting",
  },
  cross_tool_insights_widget: {
    label: "Cross-Tool Insights",
    category: "data",
    sampleQuery: "show me cross-tool insights",
  },
};

export const integrationsListWidgetTool: ToolDef<Params, IntegrationsListData> = {
  name: "integrations_list_widget",
  description:
    "List every integration the assistant knows about. Auto-discovered from the search-provider registry plus the widget-bearing tool registry. New integrations appear here automatically.",
  paramSchema: ParamSchema,
  capability: "*",
  matchIntent,
  async handler(_params, ctx): Promise<ToolResult<IntegrationsListData>> {
    const fromSearch = SEARCH_PROVIDERS.map((p) => {
      const meta = INTEGRATION_META[p.type];
      return {
        id: `search:${p.type}`,
        name: meta?.label ?? p.name,
        category: meta?.category ?? "data",
        surface: "search+widget" as const,
        sampleQuery: meta?.sampleQuery ?? p.name.toLowerCase(),
      };
    });
    const fromTools = getTools()
      .filter(
        (t) =>
          TOOL_META[t.name] !== undefined &&
          // dedupe: a tool that also has a search provider lists once
          !fromSearch.some((s) =>
            t.name.toLowerCase().includes(s.id.replace("search:", "")),
          ),
      )
      .map((t) => {
        const meta = TOOL_META[t.name];
        return {
          id: `tool:${t.name}`,
          name: meta.label,
          category: meta.category,
          surface: "widget" as const,
          sampleQuery: meta.sampleQuery,
        };
      });
    const integrations = [...fromSearch, ...fromTools].sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    trackEvent("assistant.widget_offered", ctx.userId, ctx.userRole, {
      widget_kind: "integrations_list",
      integration_count: integrations.length,
      ok: true,
    });

    const spec: WidgetSpec = {
      kind: "integrations_list",
      title: `${integrations.length} integration${integrations.length === 1 ? "" : "s"} available`,
      subtitle: "Click a sample query to try it.",
      items: integrations,
    };

    return {
      ok: true,
      data: {
        kind: "integrations_list",
        integrationCount: integrations.length,
      },
      answer: `Showing ${integrations.length} integration${integrations.length === 1 ? "" : "s"} the assistant can use. Each card lists a sample query you can run.`,
      widget: spec,
    };
  },
};

registerTool(integrationsListWidgetTool);
