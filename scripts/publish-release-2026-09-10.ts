/* FIRST. Imports hoist, so anything below already read process.env. */
import "./load-env";

/**
 * The 2026.09.10 release. FDOS gains the service-and-warranty side of the field
 * job and its first agent workflows.
 *
 * Where the prior release made the assistant operate the tools, this one gives
 * it the fixed-operations work to operate: file and clear warranty / goodwill /
 * incentive claims, know a vehicle from its VIN before the repair, cite a real
 * guidance library, and show a leader what the tool is catching. Then two agent
 * workflows chain those tools end to end behind a single human confirm, so the
 * model assembles the work and a person still decides. Entries are written from
 * what merged, for somebody who was not here.
 */
import { createRelease, type ReleaseEntry } from "@/lib/releases";

const ENTRIES: ReleaseEntry[] = [
  {
    title: "File and clear warranty, goodwill and incentive claims",
    description:
      "A rep files a claim from the claims page or from chat; the VIN is checked against NHTSA as it is entered, so a bad VIN is caught before submission. Admins get a review queue that approves or returns each claim through a real state machine, and first-pass approval rate and incentive chargeback rate are tracked. Every file and decision is org-scoped, gated and written to the tamper-evident audit log.",
    how_to_use: "Claims in the menu, or ask the assistant 'file a warranty claim for VIN <vin>'. Admins: 'claims to review'.",
    area: "Ford", category: "feature",
  },
  {
    title: "The assistant knows a vehicle before you touch it",
    description:
      "Decode any VIN and pull its open safety recalls straight from NHTSA, get a pre-repair brief and the parts to stage, and see the dealer's own service history for that VIN joined from the connected systems. It is public data with no extra setup, and the lookups fail soft, so a slow external service never breaks the answer.",
    how_to_use: "Ask 'open recalls for VIN <vin>', 'pre-repair brief for <vehicle>', or 'service history for VIN <vin>'.",
    area: "Ford", category: "feature",
  },
  {
    title: "Two agent workflows that chain the tools behind one gate",
    description:
      "'Prep and file a claim for VIN <vin>' runs a multi-step flow: decode the VIN, pull open recalls, join the dealer's own records, assemble a draft warranty claim, and stop at a single confirm before filing. 'Clear the safe claims from the queue' splits every pending claim into VIN-validated (NHTSA-clean) and needs-a-look, and approves the whole validated set on one confirm. The model assembles; nothing is written until a person confirms; each individual write stays gated and audited.",
    how_to_use: "Ask 'prep and file a claim for VIN <vin>' or 'clear the safe claims from the queue', then confirm the one step it proposes.",
    area: "Ford", category: "feature",
  },
  {
    title: "A guidance library the assistant cites",
    description:
      "Admins add curated guidance (a program's coverage, a process, a policy) once; the assistant retrieves it and cites the source when it answers, so a claim about how something works traces back to a real document rather than a guess. Adding to the library is an admin action and is ingested through the same pipeline the rest of the knowledge uses.",
    how_to_use: "Guidance in the menu (admins add entries). Everyone: ask the question in plain words and read the cited source.",
    area: "Ford", category: "feature",
  },
  {
    title: "An outcomes view for leaders",
    description:
      "A leader-facing view of what the tool is catching across the connected systems: the miss rate, resolution and friction, plus a taxonomy of where a change met resistance or was declined and the behavioral signals behind it. It turns the day-to-day activity into a picture a manager can act on.",
    how_to_use: "Outcomes in the menu (managers and admins).",
    area: "Ford", category: "feature",
  },
  {
    title: "A prompt catalog, and inviting a teammate from chat",
    description:
      "Admins can preview the exact prompt chips and the answer each role would see, from one catalog, so what a rep is offered is never a surprise. Inviting a teammate now works from its own page or straight from the assistant, with the assignable roles capped to the inviter's own privilege, a hashed seven-day token, and an audit entry.",
    how_to_use: "Prompt catalog in the menu (admins). Invite: Manage team, or ask the assistant to 'invite a teammate'.",
    area: "Ford", category: "improvement",
  },
  {
    title: "A cleaner, grouped menu",
    description:
      "The navigation is grouped into labeled sections with a consistent icon per page, and every row, whether a link or a button, now aligns on the same column and baseline. The team-messages composer and the capability prompt chips render cleanly, with the stray list bullets removed.",
    how_to_use: "Nothing to do; open the menu.",
    area: "Ford", category: "improvement",
  },
  {
    title: "Parts health as its own view, fed by a real DMS parts connector",
    description:
      "Parts is now a standalone surface: fill rate (whether the parts a customer needs are in stock), obsolescence (capital tied up in stock that has not sold), inventory value, and what to reorder. It reads a dealer's real parts inventory through a DMS parts connector that maps any configurable DMS feed into the same canonical records everything else uses; until a live feed is connected, the page and the assistant say exactly how to turn it on. Book-wide, the same part across dealers rolls up into one line.",
    how_to_use: "Parts health in the menu, or ask the assistant \"parts health for <dealer>\", \"what parts are obsolete\", or \"which parts should I reorder\".",
    area: "Ford", category: "feature",
  },
  {
    title: "The workflows explain themselves in the tour",
    description:
      "Asking what the tool can do now leads with the agent workflows and states plainly how they behave: each runs several steps in order, stops when it needs you, and nothing is sent, filed or told to anybody without your confirm. Parts and the guidance library joined the tour too, each with a one-line what-to-type and what-happens.",
    how_to_use: "Ask \"what can FDOS do?\" and start from the Agent workflows group, or tap a starter chip.",
    area: "Ford", category: "improvement",
  },
];

async function main() {
  const rel = await createRelease({
    version: "2026.09.10",
    title: "FDOS gains claims, VIN-aware service, a cited guidance library, and its first agent workflows",
    summary:
      "FDOS picks up the service-and-warranty side of the field job: file and clear warranty, goodwill and incentive claims with the VIN checked against NHTSA, decode a vehicle and pull its recalls and history before the repair, cite a real guidance library, and show leaders what the tool is catching. Two agent workflows then chain those tools end to end behind a single human confirm, so the model does the assembly and a person still decides. Parts becomes its own view fed by a real DMS connector, and the tour now explains the workflows in plain language so a user immediately knows how to run them.",
    released_on: "2026-09-10",
    entries: ENTRIES,
    published: true,
    created_by: "release-notes",
  });
  console.log("published", rel.version, "with", ENTRIES.length, "entries");
}
main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
