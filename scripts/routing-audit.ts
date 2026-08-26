/**
 * How often does an ordinary sentence reach a tool?
 *
 * The assistant has sixty tools and each decides for itself whether a message
 * is for it, using a regex written in isolation and never measured against the
 * others. On 2026-08-26 that produced a hard number: of fifty-one prompts a
 * person would plainly type, twenty-two reached NO tool at all. Not exotic
 * ones. "what are my tasks", "when is my next meeting", "who emailed me
 * today", "how many people are on the team".
 *
 * A number nobody prints is a number nobody improves, so this prints it.
 *
 *   npx tsx scripts/routing-audit.ts
 *   npm run assistant:routing
 *
 * COSTS NOTHING. Intent matching is pure functions over strings: no database,
 * no model, no network. Run it on every change to a matcher.
 *
 * REACHING MULTIPLE TOOLS IS NOT AUTOMATICALLY WRONG. Two claimants can be a
 * genuine ambiguity the dispatcher resolves by priority. It is listed rather
 * than counted as a failure, because deciding which is which needs a person.
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
  await import("../src/lib/assistant/tools/index");
  const { getTools } = await import("../src/lib/assistant/tools/registry");
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

async function main() {
  const r = await auditRouting();
  const pct = ((r.reachedOne / r.total) * 100).toFixed(0);
  console.log(`\nRouting audit: ${r.total} prompts\n`);
  console.log(`  reached exactly one tool   ${String(r.reachedOne).padStart(3)}  (${pct}%)`);
  console.log(`  reached nothing            ${String(r.reachedNone).padStart(3)}`);
  console.log(`  reached more than one      ${String(r.reachedMany).padStart(3)}`);

  console.log(`\n  by group (gaps show up as clusters)`);
  for (const [g, v] of Object.entries(r.byGroup)) {
    const bar = v.none === 0 ? "ok" : `${v.none}/${v.total} unreachable`;
    console.log(`    ${g.padEnd(13)} ${bar}`);
  }

  if (r.none.length) {
    console.log(`\n  --- reached nothing ---`);
    r.none.forEach((p) => console.log(`    ${p}`));
  }
  if (r.many.length) {
    console.log(`\n  --- more than one claimant (may be fine) ---`);
    r.many.forEach((m) => console.log(`    ${m.prompt}  ->  ${m.tools.join(", ")}`));
  }
  console.log("");
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (e) => {
      console.error("[routing-audit]", (e as Error).message);
      process.exit(1);
    },
  );
}
