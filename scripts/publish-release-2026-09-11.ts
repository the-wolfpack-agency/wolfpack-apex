/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * The 2026.09.11 release. FDOS completes its agent-workflow set: the two
 * remaining whole-job flows, prep-a-visit and recall-campaign, on the same
 * gate-behind-one-confirm pattern as the claims workflows. Written from what
 * merged, for somebody who was not here.
 */
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const ENTRIES: ReleaseEntry[] = [
  {
    title: "Prep a whole visit in one command",
    description:
      "\"Prep my visit to <dealer>\" assembles the entire pre-visit packet at once: the ranked coaching actions (what to talk about), a recommended order (what to order), and the follow-ups that are due (who to chase). The reads chain together; the one thing it can create is the order, and it does that through the same confirm the ordering page uses, so nothing is created until you approve it.",
    how_to_use: "Ask the assistant \"prep my visit to <dealer>\", then tap the order-draft confirm if you want it.",
    area: "Ford", category: "feature",
  },
  {
    title: "Run a recall campaign without sending anything by accident",
    description:
      "\"Run a recall campaign for <dealer>\" gathers every owner with an open safety recall from the dealer's own records, drafts a personalized outreach message for each, and offers one confirm to record the campaign. Creating it never sends: it saves a draft outreach list (a dealer-scoped, audited record) that a person sends through the real channel when ready. The whole flow states plainly that nothing goes out until a human sends it.",
    how_to_use: "Ask \"run a recall campaign for <dealer>\", review the owners and the drafted message, then confirm to save the draft. Sending is a separate, human step.",
    area: "Ford", category: "feature",
  },
  {
    title: "The assistant tells you how the workflows work",
    description:
      "The capability tour now leads with the agent workflows and says, in plain language, how each behaves: it runs several steps in order, stops when it needs you, and nothing is sent, filed or created without your confirm. Each workflow is one tap from where it belongs.",
    how_to_use: "Ask \"what can FDOS do?\" and start from the Agent workflows group.",
    area: "Ford", category: "improvement",
  },
  {
    title: "The dashboard leads with the agent workflows",
    description:
      "The home screen now opens with an Agent workflows section that explains, in one line, what a workflow does (it chains several steps, drafts the result, and stops for your confirm before anything is written or sent) and offers each one as a single tap: prep and file a claim, clear the safe claims, prep a whole visit, run a recall campaign. The automations are the headline of the tool, not buried.",
    how_to_use: "Open the dashboard; tap a workflow card to run it in the assistant.",
    area: "Ford", category: "improvement",
  },
  {
    title: "Reliability and security hardening",
    description:
      "A round of production hardening so the tool holds up with a client on it: database connections now self-heal through a transient wake instead of erroring, a health check and an always-on heartbeat detect a dependency issue early, sign-in and password-reset are rate-limited against abuse, and if a dependency ever hiccups the app shows a calm 'temporarily unavailable' state rather than a broken screen. Verified under concurrent load with no errors.",
    how_to_use: "Nothing to do; every request benefits.",
    area: "Ford", category: "improvement",
  },
];

async function main() {
  const rel = await createRelease({
    version: "2026.09.11",
    title: "FDOS completes its agent workflows: prep-a-visit and recall-campaign",
    summary:
      "The two remaining whole-job flows land on the same one-confirm pattern. Prep-a-visit assembles the coaching, ordering and follow-up packet for a dealer in one command; recall-campaign gathers every owner with an open recall, drafts their outreach, and records a draft campaign that a human sends, never the tool. The tour now explains, in plain words, that a workflow never creates or sends anything without your confirm.",
    released_on: "2026-09-11",
    entries: ENTRIES,
    published: true,
    created_by: "release-notes",
  });
  console.log("published", rel.version, "with", ENTRIES.length, "entries");
}
main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
