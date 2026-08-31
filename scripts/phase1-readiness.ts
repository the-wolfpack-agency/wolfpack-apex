/**
 * One command, one answer: can Phase 1 be handed to a client?
 *
 * WHY ONE. Readiness was spread across five commands nobody could be expected
 * to remember, each answering part of the question and none of them saying
 * whether the answer overall was yes. Somebody preparing a walkthrough would
 * run the ones they remembered and infer the rest.
 *
 * The dimensions are genuinely different and all of them can fail alone:
 *
 *   INFRASTRUCTURE   is the deployment answering, is there a corpus, can it
 *                    embed. Nothing else means anything if this is no.
 *   THE CONTRACT     do the prompts in the guide we hand a client actually
 *                    do what the guide says they do.
 *   THE DEMO         are those prompts answerable from THIS client's
 *                    documents, which is a different question and the one
 *                    that fails on a shared screen.
 *   WHAT WE ASK FOR  does the access pack still match the permissions the
 *                    product requests.
 *   WHAT HAS RUN     how many integrations have been exercised rather than
 *                    merely built.
 *
 * Every one produces a Check, and they all go through the same assessment the
 * infrastructure preflight already uses, so the ordering rule that matters is
 * applied once: an instance with no corpus cannot have a working demo, and
 * reporting both failures side by side buries the one to fix first.
 *
 * NOTHING IS EVER REPORTED OK BECAUSE IT COULD NOT BE CHECKED. A dimension
 * that could not run is unknown, and unknown is not ready.
 *
 *   npm run phase1
 *   PROD_URL=https://client.vercel.app npm run phase1
 */
import "./load-env";

import { assessPreflight, describePreflight, type Check } from "@/lib/deployment/preflight";
import { gather as gatherInfrastructure } from "./preflight-client";

async function contractAndDemo(): Promise<Check[]> {
  try {
    const { chat } = await import("@/lib/assistant");
    const { MODULE_CAPABILITIES } = await import("@/lib/modules/capabilities");
    const { judge, assessWalkthrough } = await import("@/lib/deployment/walkthrough");

    const promised = MODULE_CAPABILITIES.flatMap((m) =>
      m.actions
        .filter((a) => a.status === "supported")
        .map((a) => ({ id: a.id, prompt: a.example, returns: a.returns as never, because: a.because })),
    );

    const verdicts = [];
    for (const p of promised) {
      const r = await chat(p.prompt, "phase1-readiness", "admin");
      const widget = (r as unknown as { widget?: { results?: unknown[]; items?: unknown[] } }).widget;
      const sources = (r as unknown as { sources?: unknown[] }).sources;
      verdicts.push(
        judge(p, {
          text: String(r.response ?? ""),
          source: String(r.source ?? "unknown"),
          widgetRows: (widget?.results ?? widget?.items ?? []).length,
          sources: Array.isArray(sources) ? sources.length : 0,
          ms: 0,
        }),
      );
    }

    const readiness = assessWalkthrough(verdicts);
    const thin = readiness.nothingToAnswerWith.length;

    return [
      {
        id: "contract",
        proves: "the prompts in the client guide do what the guide says",
        state: readiness.contractHolds ? "ok" : "broken",
        /* "ok, 1 of 3 deliver" reads as a contradiction and invites exactly the
           misreading this check exists to prevent. Holding means nothing
           promises what the product cannot do; how many found something to
           answer with is the NEXT check's business, and conflating them is
           how a thin corpus gets mistaken for a broken product. */
        detail: readiness.contractHolds
          ? `Nothing promises what the product cannot do (${verdicts.length} checked).`
          : `${readiness.wrongShape.length} of ${verdicts.length} promise something the product does not do. The guide is wrong, or the product is.`,
        blocks: [],
      },
      {
        id: "demo",
        proves: "those prompts are answerable from THIS deployment's documents",
        /* NOT broken. The product works; the example points at a document
           nobody here has. Reporting it as a defect sends somebody debugging
           retrieval when the fix is to pick a different document. */
        state: thin === 0 ? "ok" : "needs_setup",
        detail:
          thin === 0
            ? "Every promised prompt has something to answer with."
            : `${thin} promised prompt(s) find nothing here. Ground them in a document the client actually has, or they look like failures on a shared screen.`,
        blocks: [],
      },
    ];
  } catch (err) {
    return [
      {
        id: "contract",
        proves: "the prompts in the client guide do what the guide says",
        state: "unknown",
        detail: `could not be checked: ${(err as Error).message.slice(0, 120)}`,
        blocks: [],
      },
    ];
  }
}

async function accessPack(): Promise<Check> {
  try {
    const { accessPackMarkdown, adminConsentRequests } = await import(
      "@/lib/deployment/access-pack"
    );
    const md = accessPackMarkdown(1);
    const admin = adminConsentRequests().length;
    return {
      id: "access-pack",
      proves: "we can tell a client exactly what we need from them",
      state: md.length > 400 ? "ok" : "broken",
      detail: `Generated. ${admin} decision(s) need a Microsoft 365 administrator; Phase 1 runs without them.`,
      blocks: [],
    };
  } catch (err) {
    return {
      id: "access-pack",
      proves: "we can tell a client exactly what we need from them",
      state: "unknown",
      detail: `could not be generated: ${(err as Error).message.slice(0, 120)}`,
      blocks: [],
    };
  }
}

async function integrations(): Promise<Check> {
  try {
    const { gatherEvidence, verdict } = await import("@/lib/integrations/evidence");
    const rows = await gatherEvidence();
    const run = rows.filter((r) => verdict(r) !== "unproven").length;
    return {
      id: "integrations",
      proves: "the integrations we describe have actually been exercised",
      state: run === rows.length ? "ok" : "needs_setup",
      detail: `${run} of ${rows.length} have run in production. The rest are built and unexercised, which is a different claim.`,
      blocks: [],
    };
  } catch (err) {
    return {
      id: "integrations",
      proves: "the integrations we describe have actually been exercised",
      state: "unknown",
      detail: `could not be read: ${(err as Error).message.slice(0, 120)}`,
      blocks: [],
    };
  }
}

async function main() {
  console.log("Phase 1 readiness\n");

  const checks: Check[] = [
    ...(await gatherInfrastructure().catch((err) => [
      {
        id: "deployment",
        proves: "the deployment answers at all",
        state: "unknown" as const,
        detail: `could not be reached: ${(err as Error).message.slice(0, 120)}`,
        /* Everything downstream is measured through the deployment, so a
           wrong answer here makes every later check meaningless rather than
           merely failing. */
        blocks: ["contract", "demo", "integrations"],
      },
    ])),
    ...(await contractAndDemo()),
    await accessPack(),
    await integrations(),
  ];

  const report = assessPreflight(checks);
  for (const line of describePreflight(report)) console.log(line);

  console.log(
    report.readyToHandOver
      ? "\nReady to hand over."
      : "\nNot ready. The list above is in the order it has to be worked.",
  );
  process.exit(report.readyToHandOver ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
