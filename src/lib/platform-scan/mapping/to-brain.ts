/**
 * A walked system map, written down so the assistant can answer from it.
 *
 * WHAT THIS MAKES ANSWERABLE. The assistant answers from documents, so it can
 * say what a contract's payment terms are and cannot say which system holds
 * the client list, what forms the team runs, or which outside companies
 * receive data from them. Nobody wrote those down, because they are not facts
 * anybody types into a document: they are facts about the systems themselves.
 * The walker learns them and, until now, printed them to a terminal.
 *
 * SHAPE ONLY, AND ENFORCED RATHER THAN INTENDED. This carries the NAMES of
 * things: business objects, their field names, hosts contacted, counts, and
 * what the scan could not establish. No record content, ever. The walk never
 * opens a record and the map never held one.
 *
 * That is the design, and a design is not a control. So the rendered text goes
 * through the same redaction the model boundary uses before it is stored. If a
 * field label somewhere turns out to be a person's email address, it is
 * removed here rather than discovered later in an answer, and the count comes
 * back so a caller can say something surprising was found rather than store it
 * quietly.
 *
 * IT SAYS WHEN IT WAS TRUE. A map has a date and a system changes. Every
 * document opens with when it was walked and what was NOT covered, so a
 * quotation from it carries its own caveat rather than reading as current
 * fact.
 */

import { redactText } from "@/lib/ai/redaction";
import { capabilityNote } from "../network/observations";
import type { WalkedMapRow } from "./store";

export interface BrainDocument {
  filename: string;
  markdown: string;
  /** How many sensitive values were removed. Non-zero is worth reporting. */
  redactedCount: number;
}

function heading(row: WalkedMapRow): string[] {
  const m = row.map;
  const walkedOn = row.generatedAt.slice(0, 10);
  const out = [
    `# ${m.platform}: what this system is and what it holds`,
    ``,
    /* THE DATE AND THE GAP, FIRST. A retrieved chunk is quoted without its
       surroundings, so the caveat has to be inside the part worth quoting. */
    `This describes ${m.platform} as it was on ${walkedOn}, learned by opening ${row.surfaceCount} of its screens as a signed-in user. It is a snapshot, not a live view, and a system can change after it is walked. Walking it was authorised by ${row.authorisedBy}.`,
    ``,
  ];

  if (row.frontierRemaining > 0) {
    out.push(
      `This map is incomplete: ${row.frontierRemaining} screens were still unopened when the walk stopped (${row.stopReason ?? "reason not recorded"}). Counts below are a floor, not a total.`,
      ``,
    );
  }
  out.push(`Entry point: ${m.entryUrl}`, ``);
  return out;
}

/**
 * Render a stored map as the document a person would have written.
 *
 * Prose rather than a table dump, because retrieval quotes passages and a
 * passage of pipe characters answers nothing.
 */
export function systemMapToMarkdown(row: WalkedMapRow): BrainDocument {
  const m = row.map;
  const out = heading(row);

  if (m.entities.length > 0) {
    out.push(`## What ${m.platform} manages`, ``);
    out.push(
      `${m.entities.length} business objects were found in ${m.platform}. They are:`,
      ``,
    );
    for (const e of m.entities) {
      const fields =
        e.attributes.length > 0
          ? ` Its fields include ${e.attributes.slice(0, 12).join(", ")}.`
          : ` No fields were observed on the screens that were opened, which does not mean it has none.`;
      out.push(`- **${e.name}**, seen on ${e.evidence.length} screen(s).${fields}`);
    }
    out.push(``);
  }

  if (m.integrations.length > 0) {
    out.push(`## Where data goes from ${m.platform}`, ``);
    const named = m.integrations.filter((i) => i.vendor !== null);
    const unnamed = m.integrations.filter((i) => i.vendor === null);
    out.push(
      `${m.platform} contacted ${m.integrations.length} third-party host(s) while it was walked.`,
      ``,
    );
    for (const i of named) {
      /* The question a severity must not answer for you. A vendor that sells
         session recording is worth asking about, and whether the feature is
         switched on is invisible from outside, so it travels as a sentence
         rather than as a score. */
      const note = capabilityNote(i.host);
      out.push(
        `- **${i.vendor}** (${i.host}) was contacted ${i.requestCount} time(s) across ${i.seenOn.length} screen(s).` +
          (note ? ` ${note}` : ""),
      );
    }
    for (const i of unnamed) {
      /* Unrecognised is a prompt to ask, not a benign default, and the wording
         has to survive being quoted on its own. */
      out.push(
        `- **${i.host}** was contacted ${i.requestCount} time(s) across ${i.seenOn.length} screen(s). This host was not recognised, which means it is worth asking about rather than that it is harmless.`,
      );
    }
    out.push(``);
  }

  /* HOW MUCH AND WHETHER IT MOVES, in the document somebody asks questions
     of. "How many records are in the CRM" and "can we get our data out" are
     exactly the questions a rollout turns on. */
  const counted = m.surfaces.filter((s) => typeof s.recordCount === "number");
  const allExports = m.surfaces.flatMap((s) => s.exports ?? []);
  if (counted.length > 0 || allExports.length > 0) {
    out.push(`## How much ${m.platform} holds, and whether it can be moved`, ``);
    for (const s of counted
      .sort((a, b) => (b.recordCount ?? 0) - (a.recordCount ?? 0))
      .slice(0, 12)) {
      out.push(`- ${s.signature} showed ${s.recordCount} record(s), from the phrase "${s.recordCountFrom}".`);
    }
    if (counted.length > 0) {
      /* Unknown, not zero, said in the part that gets quoted. */
      out.push(
        ``,
        `Screens that stated no total are unknown rather than empty; a count here means the system displayed it.`,
      );
    }
    const kinds = [...new Set(allExports.map((e) => e.kind))];
    out.push(
      ``,
      allExports.length > 0
        ? `Ways data appeared to be gettable out: ${kinds.join(", ")}. These were seen, not used: nothing was downloaded.`
        : `No way to export was visible on the screens that were opened, which is not the same as there being none.`,
      ``,
    );
  }

  const patterns = (m.coverage.patterns ?? []).filter((p) => p.visited < p.instances.length);
  if (patterns.length > 0) {
    out.push(
      `## What was sampled rather than opened`,
      ``,
      `Some screens repeat once per object, so a sample was opened instead of every one:`,
      ``,
    );
    for (const p of patterns.slice(0, 10)) {
      out.push(`- ${p.instances.length} screens match \`${p.shape}\`; ${p.visited} were opened.`);
    }
    out.push(``);
  }

  const markdown = out.join("\n");

  /* THE CONTROL, NOT THE INTENTION. Shape-only is the design; this is what
     makes it true. Reuses the redaction that guards the model boundary rather
     than inventing a second, weaker one for this path. */
  const redacted = redactText(markdown);
  return {
    filename: `system-map-${m.platform.replace(/[^a-z0-9.-]+/gi, "-")}.md`,
    markdown: redacted.text,
    redactedCount: redacted.hits.length,
  };
}
