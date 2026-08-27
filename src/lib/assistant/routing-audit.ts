/**
 * How often does an ordinary sentence reach a tool?
 *
 * MOVED HERE FROM scripts/ on 2026-08-26 so the number has ONE definition.
 * The script prints it, the ratchet test asserts it, and /admin/insights shows
 * it, and all three now read this file. A score computed twice is a score that
 * eventually disagrees with itself, and the first person to notice will be a
 * client reading the page while the test is green.
 *
 * COSTS NOTHING. Intent matching is pure functions over strings: no database,
 * no model, no network, which is why it is safe to compute inside a request.
 */
/** Prompts a person types, grouped so a gap shows up as a cluster. */
export const AUDIT_PROMPTS: Record<string, string[]> = {
  calendar: [
    "what's on my calendar today",
    "am I free thursday afternoon",
    "when is my next meeting",
    "what does my week look like",
  ],
  mail: [
    "show me my unread emails",
    "find the email from Jorge about pricing",
    "who emailed me today",
    "search my email for the contract",
  ],
  tasks: ["what are my tasks", "anything overdue", "what tasks do I have", "my tasks"],
  people: [
    "who is Ashley",
    "who works on the Porsche account",
    "what does Jorge do",
    "how many people are on the team",
  ],
  documents: [
    "upload a document to the brain",
    "what does the SOW say",
    "find the contract",
    "add this file to the knowledge base",
  ],
  engineering: ["what happened in CI", "is the build green", "show recent deploys"],
  day: ["plan my day", "run my day", "what should I work on", "brief me"],
  status: ["what's blocking the pilot", "how is the pilot going", "what's left to do"],
  feedback: ["this button is broken", "the page won't load", "report a bug"],
  ambient: ["what's the weather", "top news", "euro to dollar"],
};

export interface RoutingResult {
  total: number;
  reachedOne: number;
  reachedNone: number;
  reachedMany: number;
  none: string[];
  many: Array<{ prompt: string; tools: string[] }>;
  byGroup: Record<string, { total: number; none: number }>;
}

export async function auditRouting(): Promise<RoutingResult> {
  await import("@/lib/assistant/tools/index");
  const { getTools } = await import("@/lib/assistant/tools/registry");
  const tools = getTools() as unknown as Array<{
    name: string;
    matchIntent?: (m: string) => unknown;
  }>;
  const claimants = (m: string) =>
    tools.filter((t) => typeof t.matchIntent === "function" && t.matchIntent(m) != null).map((t) => t.name);

  const out: RoutingResult = {
    total: 0,
    reachedOne: 0,
    reachedNone: 0,
    reachedMany: 0,
    none: [],
    many: [],
    byGroup: {},
  };

  for (const [group, prompts] of Object.entries(AUDIT_PROMPTS)) {
    out.byGroup[group] = { total: prompts.length, none: 0 };
    for (const p of prompts) {
      out.total++;
      const c = claimants(p);
      if (c.length === 0) {
        out.reachedNone++;
        out.none.push(p);
        out.byGroup[group].none++;
      } else if (c.length === 1) {
        out.reachedOne++;
      } else {
        out.reachedMany++;
        out.many.push({ prompt: p, tools: c });
      }
    }
  }
  return out;
}

