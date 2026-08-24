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

/**
 * WHAT AM I CONNECTED TO IS A QUESTION ABOUT REALITY.
 *
 * "what tools are you connected to?" matched and was answered from the
 * live registry. "do you have access to our CRM?" matched nothing, fell
 * through to a model, and the model answered out of the knowledge base:
 *
 *   > do you have access to our CRM?
 *   < Yes, I have access to your CRM system integrated into the
 *     wolfpack-auto platform. This includes client profiles, leads,
 *     communication history, inventory, and analytics.
 *
 * Measured against the deployed assistant on 2026-08-24. Every clause of
 * that is a claim about what this product can reach, made from a document
 * describing a different product, and told to somebody who would plan
 * around it.
 *
 * A missing capability is a gap. A CLAIMED capability that does not exist
 * is a different thing entirely, and it is the one a client discovers by
 * relying on it. So the question is answered from the registry, which
 * knows, and never from retrieval, which is only ever quoting somebody.
 *
 * The phrasings are the ones people use to ask it: connected to, access
 * to, can you see, can you read, are you plugged into, do you integrate
 * with.
 */
const INTENT_RE = new RegExp(
  [
    `\\b(list|show|see|what)\\s+(all\\s+)?(my\\s+)?(integrations?|widgets?|connectors?|tools?)\\b`,
    `\\bwhat\\s+can\\s+(the\\s+)?assistant\\s+do\\b`,
    `\\b(?:do|can)\\s+you\\s+(?:have\\s+)?(?:access\\s+to|see|read|reach|get\\s+(?:to|at))\\b`,
    `\\b(?:are|is)\\s+you\\s*(?:connected|plugged\\s+in(?:to)?|hooked\\s+up)\\b`,
    `\\bare\\s+you\\s+connected\\s+to\\b`,
    `\\bdo\\s+you\\s+integrate\\s+with\\b`,
    `\\bwhat\\s+(?:are\\s+you|do\\s+you)\\s+connect(?:ed)?\\s+to\\b`,
  ].join("|"),
  "i",
);

/**
 * "can you see" is also an idiom.
 *
 * "can you see what I mean" is somebody checking they have been
 * understood, not asking what this is plugged into, and answering it with
 * a list of integrations is its own small absurdity. The tell is what
 * follows the verb: a system has a determiner in front of it, and a
 * rhetorical one is followed by a question word.
 */
const IDIOM_RE = /\b(?:see|read|reach)\s+(?:what|why|how|if|whether|where)\b/i;

function matchIntent(message: string): Params | null {
  const m = message.trim();
  if (IDIOM_RE.test(m)) return null;
  if (!INTENT_RE.test(m)) return null;
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
