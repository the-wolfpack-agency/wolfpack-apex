/**
 * welcome-prompts-coverage — every chip the assistant shows the user
 * MUST actually route to a registered tool (or be explicitly listed in
 * the free-text allowlist below). The 2026-05-19 incident this pins:
 * a prior session added a "what does our company do" chip that didn't
 * match any tool's `matchIntent`, so the chip silently fell through to
 * the free-text chat handler — invisible failure, no analytics signal,
 * confusing demo.
 *
 * The check is intentionally low-friction: it walks every prompt in
 * every role kit (welcome-prompts.ts) plus every chip in the empty-state
 * starter prompts (AssistantStarterPrompts.tsx) and asserts that at
 * least one tool's `matchIntent(prompt)` returns a non-null result. If
 * a prompt is intentionally free-text (e.g. "tell me about our company"
 * routes to org-facts which itself isn't strictly a "tool" intent in
 * some workspaces) it must be added to FREE_TEXT_ALLOWLIST with a
 * one-line reason so future readers don't think it's a regression.
 *
 * We deliberately do NOT call `tryDispatchTool` here — that path runs
 * the handler (which would hit Graph / Salesforce / etc), and many tools
 * are gated by capability or `requiresConfirmation`. The point of this
 * test is "does the intent regex claim the chip", not "does the handler
 * succeed". Handler-level smoke tests live next to each tool.
 */

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

/* Side-effect import — registers every tool. */
import "@/lib/assistant/tools";

import { getTools } from "@/lib/assistant/tools/registry";
import { welcomePromptsForRole } from "@/lib/assistant/welcome-prompts";
import { buildStarterCategoriesForTest } from "@/components/AssistantStarterPrompts";

/* Roles surfaced in the welcome modal — keep in sync with ROLE_KITS in
 * welcome-prompts.ts. Unknown role exercises the GENERIC_KIT fallback. */
const ROLES = [
  undefined,
  "ceo",
  "cto",
  "vp",
  "pm",
  "designer",
  "dev",
  "sales",
  "ops",
  "hr",
] as const;

/* Allowlist — prompts we WANT to surface but that intentionally fall
 * through to the free-text chat handler (no tool claims them). Each
 * entry must carry a one-line reason. */
const FREE_TEXT_ALLOWLIST: Record<string, string> = {
  /* `create OKR` is matched but `schedule a meeting` is intentionally
   * routed through the calendar-availability tool (free/busy check)
   * by historical design — see form-vs-crm-routing.test.ts. Keep the
   * chip; it still produces a useful answer. */
  "schedule a meeting":
    "free/busy check (calendar-availability) consumes this; widget surface is correct.",
};

/** Try every tool's matchIntent. Returns the tool name on first hit. */
function claimingTool(prompt: string): string | null {
  for (const t of getTools()) {
    try {
      const out = t.matchIntent(prompt);
      if (out !== null && out !== undefined) return t.name;
    } catch {
      /* a thrower can't claim it. */
    }
  }
  return null;
}

describe("welcome-prompts coverage — every chip routes to a tool", () => {
  test.each(ROLES.map((r) => [r ?? "(generic)", r ?? null]))(
    "role %s — every prompt is claimed by a tool or allowlisted",
    (_label, role) => {
      const prompts = welcomePromptsForRole(role as string | null);
      expect(prompts.length).toBeGreaterThanOrEqual(3);
      expect(prompts.length).toBeLessThanOrEqual(6);
      for (const p of prompts) {
        const claim = claimingTool(p.text);
        const allow = FREE_TEXT_ALLOWLIST[p.text];
        if (!claim && !allow) {
          throw new Error(
            `welcome-prompts kit "${role ?? "(generic)"}" has chip ${JSON.stringify(
              p.text,
            )} that no tool claims and is not on FREE_TEXT_ALLOWLIST. ` +
              `Either rewrite the prompt to match an existing tool's matchIntent ` +
              `or add it to FREE_TEXT_ALLOWLIST with a one-line reason.`,
          );
        }
      }
    },
  );
});

describe("AssistantStarterPrompts coverage — every chip routes to a tool", () => {
  test("every chip in every category is claimed by a tool or allowlisted", () => {
    const cats = buildStarterCategoriesForTest();
    expect(cats.length).toBeGreaterThan(0);
    const broken: Array<{ category: string; prompt: string }> = [];
    for (const cat of cats) {
      for (const p of cat.prompts) {
        if (claimingTool(p.text)) continue;
        if (FREE_TEXT_ALLOWLIST[p.text]) continue;
        broken.push({ category: cat.title, prompt: p.text });
      }
    }
    if (broken.length > 0) {
      const lines = broken
        .map((b) => `  [${b.category}] ${JSON.stringify(b.prompt)}`)
        .join("\n");
      throw new Error(
        `The following starter-prompt chips don't route to any tool and aren't ` +
          `on FREE_TEXT_ALLOWLIST:\n${lines}\n` +
          `Either rewrite the prompt to match an existing tool's matchIntent ` +
          `or add it to FREE_TEXT_ALLOWLIST.`,
      );
    }
  });
});

/* New 2026-05-19 tools (universal search, weather, headlines, fx,
 * upload-to-brain, CRM form) MUST each be exercised by at least one
 * prompt across the welcome modal OR the empty-state starter prompts.
 * This is the "no orphan tool" guard — the symmetric version of the
 * per-prompt routing check above. If you intentionally retire a chip
 * for one of these tools, replace it with another that still claims
 * the same tool name before removing the entry from REQUIRED_TOOLS. */
describe("required-tools coverage — every shipped tool is advertised somewhere", () => {
  /* Tools advertised by at least one chip across welcome-prompts.ts OR
   *  AssistantStarterPrompts.tsx. Note: `search_external_records` is
   *  deliberately absent (see inline comment below). */
  const REQUIRED_TOOLS: string[] = [
    "search",
    "weather",
    "headlines",
    "fx",
    "upload_to_brain",
    "create_crm_record_form",
    "save_team_fact",
    "who_is",
    "get_org_facts",
    "get_financials_metric",
    "get_goals",
    "good_morning_widget", // briefing
    "calendar_widget",
    "email_thread_widget",
    "task_list_widget",
    "get_calendar_availability",
    "search_mail",
    /* `search_external_records` is intentionally NOT advertised by a
     *  starter chip anymore. The 2026-05-19 chip rename stripped all
     *  name-bound CRM-lookup chips ("find the contact for Grimace") at
     *  the user's request. CRM lookups now route through the universal
     *  `search` tool's CRM provider for bare-search phrasings; the
     *  search-external-records tool still serves typed phrasings
     *  ("find the contact for <name>") when a user types them directly
     *  but is no longer discoverable via a chip. */
    "get_related_records",
    "filter_external_records",
    "aggregate_external_records",
    "update_external_record",
    "search_github_pull_requests",
    "search_github_issues",
    "recent_workflow_runs",
    "create_task_form",
    "create_email_form",
    "create_message_form",
    "create_calendar_event_form",
    "create_feature_form",
    "create_okr_form",
    "dms_inventory_widget",
  ];

  test("each required tool is claimed by at least one advertised chip", () => {
    const advertised = new Set<string>();
    for (const role of ROLES) {
      for (const p of welcomePromptsForRole(role as string | null)) {
        const c = claimingTool(p.text);
        if (c) advertised.add(c);
      }
    }
    for (const cat of buildStarterCategoriesForTest()) {
      for (const p of cat.prompts) {
        const c = claimingTool(p.text);
        if (c) advertised.add(c);
      }
    }
    const missing = REQUIRED_TOOLS.filter((t) => !advertised.has(t));
    if (missing.length > 0) {
      throw new Error(
        `The following tools are registered but no welcome/starter chip ` +
          `exercises them: ${missing.join(", ")}. Add at least one chip ` +
          `whose text routes to each missing tool, or remove the tool from ` +
          `REQUIRED_TOOLS if intentionally hidden.`,
      );
    }
  });
});
