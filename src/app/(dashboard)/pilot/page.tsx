"use client";

/**
 * /pilot - phase one, as the client will see it, running on our own data.
 *
 * Built before the engagement rather than during it, for three reasons that
 * are the same reason. It proves the product carries real numbers without
 * looking thin. It gives whoever designs the client's version something to
 * react to instead of a description. And it means the first time this shape is
 * seen under pressure is not in front of the client.
 *
 * EVERY FIGURE IS OURS AND REAL. No placeholder, no illustrative number, no
 * sample data. A page that demos beautifully on invented figures teaches
 * nothing about whether it works, and this exists to find out.
 *
 * THE PANELS ARE AN ARGUMENT, IN ORDER. What we can read, then what we
 * answered, then how often we did it without a model, then what we refused to
 * answer. The last two are the ones a competitor cannot put on a page: the
 * deterministic share is zero for a chatbot, and refusals are something most
 * products hide rather than count.
 *
 * A CLIENT COMPONENT BEHIND A GATED ROUTE, which the first version was not. It
 * read the database directly from a server component with no capability check
 * and no workspace in scope, so it would have served a client-facing summary
 * to anyone who reached the URL. The tenancy scan caught the missing workspace
 * filter, and that is what surfaced the missing gate.
 */
import { useEffect, useState } from "react";
import BuildBanner from "@/components/BuildBanner";
import { buildFor } from "@/lib/builds/registry";
import { PROMPT_GUIDE } from "@/lib/assistant/prompt-corpus";
import type { CapabilitySnapshot } from "@/lib/insights/capability-snapshot";
import {
  compareCosts,
  repeatSavings,
  COMPARISON_PRICES,
  PRICES_RECORDED_ON,
  type TokenUsage,
} from "@/lib/pilot/model-cost-comparison";
import {
  adoptionVerdict,
  reachedShare,
  neverStarted,
  type AdoptionSnapshot,
} from "@/lib/pilot/adoption-shape";
import { fetchWithRefresh, getInstinctUser } from "@/lib/client-auth";
import {
  deterministicShare,
  answersGiven,
  type PhaseOneSnapshot,
} from "@/lib/pilot/phase-one-shape";

/**
 * A figure that might not have been measurable.
 *
 * Null is never zero. The whole page rests on that distinction and it has to
 * survive being rendered: "n/a" tells a reader we could not measure it, and a
 * zero would tell them the product did nothing.
 */
function reading(
  r: { value: number | null } | undefined,
  suffix = "",
  prefix = "",
): string {
  if (!r || r.value === null || r.value === undefined) return "n/a";
  return `${prefix}${r.value.toLocaleString()}${suffix}`;
}

function Figure({
  value,
  label,
  note,
  testId,
}: {
  value: string;
  label: string;
  note?: string;
  testId: string;
}) {
  return (
    <div className="wp-pilot-figure" data-testid={testId}>
      <p className="wp-pilot-figure-value">{value}</p>
      <p className="wp-pilot-figure-label">{label}</p>
      {note ? <p className="wp-pilot-figure-note">{note}</p> : null}
    </div>
  );
}

/**
 * The prompts shown to a client, curated from the verified guide.
 *
 * READ-ONLY, by tool name: search, meeting prep, who-is, tasks, schedule
 * health, goals, financials, cross-source compare. No create/send form,
 * because the first thing a client tries should not book a meeting or send a
 * message. Ordered to lead with the library the pilot is about.
 *
 * Drawn from PROMPT_GUIDE rather than retyped, so the routing tests that hold
 * that guide true also hold this list: the page cannot advertise a phrasing
 * the product does not answer.
 */
const TRY_ASKING = (() => {
  const order = [
    "search",
    "compare_across_sources",
    "meeting_prep",
    "who_is",
    "task_list_widget",
    "schedule_health",
    "get_goals",
    "get_financials_metric",
  ];
  return order
    .map((tool) => PROMPT_GUIDE.find((g) => g.tool === tool))
    .filter((g): g is (typeof PROMPT_GUIDE)[number] => Boolean(g && g.say.length > 0));
})();

interface LibraryQuestion {
  noticed: string;
  ask: string;
  examples: string[];
}

interface ExposureKind {
  kind: string;
  occurrences: number;
  neverSend: boolean;
}

interface ExposureDocument {
  documentId: string;
  filename: string;
  kinds: ExposureKind[];
  holdsNeverSend: boolean;
}

/**
 * What the scan returns.
 *
 * No matched value appears anywhere in this shape, and none should ever be
 * added: a list naming which document holds a card number is a work queue,
 * and the same list with the number beside it is a copy of the exposure in a
 * page easier to read than the original.
 */
interface ExposureResponse {
  chunksScanned: number;
  chunksWithSomething: number;
  byKind: ExposureKind[];
  documentsWithSomething: number;
  documentsWithNeverSend: number;
  documents: ExposureDocument[];
  truncated: boolean;
  durationMs: number;
}

/* This page is engagement work, not a shipped feature, and until the register
   existed nothing on it said so. */
const pilotBuild = buildFor("/pilot");

export default function PilotPage() {
  const [snap, setSnap] = useState<
    | (PhaseOneSnapshot & {
        adoption?: AdoptionSnapshot;
        capability?: CapabilitySnapshot;
        tokenUsage?: TokenUsage | null;
        libraryQuestions?: { questions: LibraryQuestion[]; readable: boolean };
      })
    | null
  >(null);
  const [failed, setFailed] = useState(false);
  /* ASKED FOR, NOT LOADED. Scanning every indexed passage takes seconds and
     reads the whole corpus, so running it because somebody opened a tab would
     make the page slow and would scan on a whim. */
  const [exposure, setExposure] = useState<ExposureResponse | null>(null);
  const [exposureState, setExposureState] = useState<
    "idle" | "running" | "failed"
  >("idle");

  useEffect(() => {
    /* Redirect rather than render an empty page. A signed-out visitor seeing
       zeros would read them as the product having nothing in it. */
    const user = getInstinctUser();
    if (!user) {
      window.location.href = `/login?next=${encodeURIComponent("/pilot")}`;
      return;
    }
    let live = true;
    (async () => {
      try {
        const res = await fetchWithRefresh("/api/pilot/phase-one");
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PhaseOneSnapshot & {
          libraryQuestions?: { questions: LibraryQuestion[]; readable: boolean };
          adoption?: AdoptionSnapshot;
          capability?: CapabilitySnapshot;
          tokenUsage?: TokenUsage | null;
        };
        if (live) setSnap(data);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  /* Computed on the client from the token counts the API returned, so the
     price table is one constant to update rather than a stored figure that
     goes stale silently. */
  const comparison = snap?.tokenUsage ? compareCosts(snap.tokenUsage) : [];
  /* Priced at the most expensive alternative, which is the comparison the
     table already leads with, so the two figures describe the same vendor. */
  const reuseCost =
    snap?.tokenUsage && comparison.length > 0
      ? repeatSavings(
          snap.tokenUsage,
          COMPARISON_PRICES.find((p) => p.label === comparison[0].label)!,
        )
      : null;
  const share = snap ? deterministicShare(snap) : null;
  const answers = snap ? answersGiven(snap) : 0;
  const unreadable = failed || (snap !== null && !snap.readable);

  return (
    <main className="wp-pilot" data-testid="phase-one-dashboard">
      {pilotBuild ? <BuildBanner build={pilotBuild} /> : null}
      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Phase one · last 60 days</p>
        <h1>Their library, read and answerable</h1>
        <p className="wp-pilot-sub">
          Everything below is measured on this deployment. It is what a client
          sees in phase one, running on our own data so the shape is proven
          before theirs is in it.
        </p>
      </header>

      {unreadable ? (
        /* Not zeros. Zeros here would claim an empty corpus and a silent
           assistant, which is more alarming and less true than saying the
           figures could not be read. */
        <p className="wp-pilot-unreadable" data-testid="pilot-unreadable">
          These figures could not be read just now. That is not an empty corpus
          and not a quiet week: it is an unmeasured one, and the difference
          matters.
        </p>
      ) : !snap ? (
        <p className="wp-pilot-sub" data-testid="pilot-loading">
          Reading the figures…
        </p>
      ) : (
        <>
          {snap.libraryQuestions?.questions?.length ? (
            <section className="wp-pilot-section" data-testid="pilot-library-questions">
              <h2>What only you can tell us</h2>
              <p className="wp-pilot-aside">
                Things about this library that look like findings and might not be. Reading data
                and concluding from it is the expensive mistake in week one: on our own library,
                42% of the documents turned out to be output from our own tools writing into it.
                So these are questions, and none of them is a number we intend to quote.
              </p>
              <ul className="wp-build-findings">
                {snap.libraryQuestions.questions.map((q) => (
                  <li key={q.noticed}>
                    <h3>{q.noticed}</h3>
                    <p>{q.ask}</p>
                    <p className="wp-build-evidence">{q.examples.join(" · ")}</p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="wp-pilot-section">
            <h2>What we can read</h2>
            <div className="wp-pilot-figures">
              <Figure
                value={snap.passages.toLocaleString()}
                label="Passages answerable"
                note="Indexed, scoped by the library each came from"
                testId="pilot-passages"
              />
              {snap.scansRead > 0 ? (
                <Figure
                  label="Scans read"
                  value={snap.scansRead.toLocaleString()}
                  note="Documents that arrived as pictures and carried no text. Read by OCR, quotable and citable like any other."
                  testId="pilot-scans-read"
                />
              ) : null}
              <Figure
                value={snap.libraries.toLocaleString()}
                label="Libraries connected"
                note="One tenant consent, no install"
                testId="pilot-libraries"
              />
            </div>
          </section>

          <section className="wp-pilot-section">
            <h2>What we answered</h2>
            <div className="wp-pilot-figures">
              <Figure
                value={answers.toLocaleString()}
                label="Questions answered"
                testId="pilot-answers"
              />
              <Figure
                /* Null, not 0%, when nothing was asked. Zero would read as "a
                   model answered everything", the opposite of the claim. */
                value={share === null ? "n/a" : `${Math.round(share * 100)}%`}
                label="Never reached a model"
                note="Answered straight from connected systems"
                testId="pilot-deterministic"
              />
              <Figure
                value={snap.modelAnswers.toLocaleString()}
                label="Needed a model"
                note="Every one redacted, budgeted and audited at one chokepoint"
                testId="pilot-model-answers"
              />
            </div>
            <p className="wp-pilot-aside">
              The line between those last two is the product. Most questions are
              answered by reading their own systems, which is what makes this
              cheap, auditable and predictable, and it is the opposite of how a
              chatbot works.
            </p>
            {/* SAID ON THE PAGE, NOT IN SOMEBODY'S MEMORY.
                These figures counted our own eval harnesses and demo accounts
                as usage until 2026-08-31: eleven per cent of the answers and
                twenty-nine per cent of the model calls. It understated us,
                which is the luckier direction and not a reason to leave it,
                because the same contamination on a day of heavy testing would
                overstate instead. A number that shrank deserves its reason
                beside it rather than a question later. */}
          </section>

          {/* WHAT YOU CAN ASK.
              Replaces the old could-not-answer panel. A client wants to see
              what the tool DOES, in phrasings they can type today, not a list
              of things that failed. Every line here is a verified phrasing
              from the prompt guide the routing tests hold us to, so the page
              cannot show a capability the product does not have.

              Read-only, value-first: it shows what to ask and what comes back,
              and never a create/send action, because the first thing a client
              tries should not book or send anything. */}
          <section className="wp-pilot-section" data-testid="pilot-try-asking">
            <h2>What you can ask</h2>
            <p className="wp-pilot-aside">
              A few of the things people type here, and what comes back. These
              are verified phrasings, not a script: the assistant answers plenty
              that are not on this list, in your own words.
            </p>
            <ul className="wp-pilot-list">
              {TRY_ASKING.map((g) => (
                <li key={g.goal}>
                  <strong>&ldquo;{g.say[0]}&rdquo;</strong>
                  <span className="wp-pilot-note"> {g.gives}</span>
                </li>
              ))}
            </ul>
          </section>

          <section className="wp-pilot-section">
            <h2>What never reaches a model</h2>
            {/* WHAT THE GATE STOPS, ASKED FOR RATHER THAN ASSUMED.
                Every other figure on this page is a count of what happened.
                This one is a scan somebody runs, because it reads the whole
                corpus and because "show me" is the moment it means something.

                It never renders a matched value. The list says which document
                carries what kind, which is a work queue; the same list with
                the values beside it would be a copy of the exposure in a page
                that is easier to read than the original. */}
            <div className="wp-pilot-exposure" data-testid="pilot-exposure">
              {/* A PERSON HAS TO KNOW WHAT PRESSING IT WILL DO. The scan is the
                  only thing on this page somebody performs rather than reads,
                  and an unexplained button on a page of figures gets left
                  alone. */}
              <p className="wp-pilot-aside">
                Some of what a company keeps should never be sent to a model at
                all: card numbers, keys, bank details. They are removed at the
                boundary whether or not anybody has looked. Press this to read
                every indexed passage and see which documents are carrying them.
              </p>
              <button
                type="button"
                className="wp-pilot-button"
                data-testid="pilot-exposure-run"
                disabled={exposureState === "running"}
                onClick={async () => {
                  setExposureState("running");
                  try {
                    const res = await fetchWithRefresh("/api/pilot/exposure");
                    if (!res.ok) throw new Error(String(res.status));
                    setExposure((await res.json()) as ExposureResponse);
                    setExposureState("idle");
                  } catch {
                    /* Said, never swallowed. A button that does nothing and
                       reports nothing is indistinguishable from a corpus with
                       nothing in it, which is the opposite finding. */
                    setExposureState("failed");
                  }
                }}
              >
                {exposureState === "running"
                  ? "Reading every indexed passage…"
                  : "Check what never reaches a model"}
              </button>

              {exposureState === "failed" ? (
                <p
                  className="wp-pilot-aside"
                  data-testid="pilot-exposure-failed"
                >
                  The scan could not be run. That is not the same as finding
                  nothing, and nothing above should be read as a result.
                </p>
              ) : null}

              {exposure ? (
                <div data-testid="pilot-exposure-result">
                  <p className="wp-pilot-aside">
                    {exposure.chunksWithSomething.toLocaleString()} of{" "}
                    {exposure.chunksScanned.toLocaleString()} passages carry
                    something removed before it reaches a model, across{" "}
                    {exposure.documentsWithSomething.toLocaleString()}{" "}
                    document(s).{" "}
                    {exposure.documentsWithNeverSend.toLocaleString()} hold a
                    value that is never sent to any provider at all.
                  </p>
                  {/* Scrolls in its own box rather than pushing the page
                      down. A hundred documents rendered inline buried every
                      section below the button under a wall somebody had to
                      scroll past to get anywhere. */}
                  <div
                    className="wp-pilot-scroll"
                    data-testid="pilot-exposure-scroll"
                  >
                    <ul className="wp-pilot-list">
                      {exposure.documents.map((d) => (
                        <li key={d.documentId}>
                          <strong>{d.filename}</strong>{" "}
                          {d.kinds
                            .map((k) => `${k.kind} (${k.occurrences})`)
                            .join(", ")}
                          {d.holdsNeverSend ? " — never sent" : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <p className="wp-pilot-aside">
                    {exposure.documents.length.toLocaleString()} document(s)
                    listed above, never-send first. Scroll the box to read the
                    rest.
                  </p>
                  {exposure.truncated ? (
                    <p className="wp-pilot-aside">
                      Showing the first {exposure.documents.length}. The count
                      above is the whole figure.
                    </p>
                  ) : null}
                  <p className="wp-pilot-aside">
                    This says the boundary holds, not that anybody did anything
                    wrong: invoices contain card numbers, which is what an
                    invoice is. What it changes is who should be able to quote
                    which document.
                  </p>
                </div>
              ) : null}
            </div>
          </section>

          <section className="wp-pilot-section">
            <h2>What we set aside</h2>
            {typeof snap.excludedAsTesting === "number" &&
            snap.excludedAsTesting > 0 ? (
              <p
                className="wp-pilot-aside"
                data-testid="pilot-excluded-testing"
              >
                A further {snap.excludedAsTesting.toLocaleString()} answers came
                from our own testing and tooling rather than from a person, and
                are excluded from every figure above.
              </p>
            ) : null}
          </section>

          {/* WHAT IT COSTS AND WHAT IT STOPPED.
              Moved here from /admin/insights, which is gated to three roles
              and mixes these with our own backlog signals: unmet intents,
              routing coverage, controls shown to the wrong role. Those are OUR
              questions. What a model costs and how little of the product needs
              one are the CLIENT'S, and they were on the wrong page for the
              wrong audience. */}
          {/* UNDEFINED AND NULL MEAN DIFFERENT THINGS HERE.
              undefined is a deployment whose API predates these figures, and
              rendering an error for that would be wrong. null is a read that
              FAILED, and silently omitting the section for that would hide it,
              which is the mistake this page exists to avoid. */}
          {snap.capability === null ? (
            <section
              className="wp-pilot-section"
              data-testid="pilot-capability"
            >
              <h2>What it costs to run</h2>
              <p
                className="wp-pilot-aside"
                data-testid="pilot-capability-unreadable"
              >
                These figures could not be read just now. That is not a product
                doing nothing, and the difference matters enough to say so
                rather than leave the section out.
              </p>
            </section>
          ) : snap.capability ? (
            <section
              className="wp-pilot-section"
              data-testid="pilot-capability"
            >
              <h2>What it costs to run</h2>
              <div className="wp-pilot-figures">
                <Figure
                  value={reading(
                    snap.capability.efficiency.deterministicSharePct,
                    "%",
                  )}
                  label="Answered without AI"
                  note="Read straight from connected systems, at no model cost"
                  testId="pilot-cap-deterministic"
                />
                <Figure
                  value={reading(snap.capability.efficiency.spendUsd, "", "$")}
                  label="Model spend"
                  note={`Everything a model was needed for, across ${snap.capability.windowDays} days`}
                  testId="pilot-cap-spend"
                />
                <Figure
                  value={reading(snap.capability.efficiency.cheapTierPct, "%")}
                  label="Served by the cheapest model"
                  note="The router picks the smallest model that can answer"
                  testId="pilot-cap-cheap"
                />
                <Figure
                  value={reading(snap.capability.gate.actionsAuthorized)}
                  label="Agent actions checked"
                  note="Every action an agent took passed a gate before it ran"
                  testId="pilot-cap-gate"
                />
                {/* THE CONTROL A CLIENT ACTUALLY ASKS ABOUT, SHOWN FIRST.
                    People paste a card number or an ID into a chat box by
                    mistake, and this is what happens when they do. It leads
                    because it is the one that fires: verified end to end on
                    2026-08-30 with a pasted card, a national ID inside a real
                    question, bank details and an API key. None reached the
                    answer. */}
                <Figure
                  value={reading(
                    snap.capability.safety.sensitiveInputsRedacted,
                  )}
                  label="Cards, IDs and keys removed from questions"
                  note="Taken out before any model or outside service saw them. The question is still answered."
                  testId="pilot-cap-inputs-redacted"
                />
                <Figure
                  value={reading(snap.capability.safety.responsesFlagged)}
                  /* FLAGGED, NOT WITHHELD, AND THE DISTINCTION IS ENFORCED.
                     The router records a risky shape and DELIVERS the answer
                     anyway; its own comment reads "Recorded rather than
                     blocked", because in a product that writes code a refusal
                     on a false positive costs more trust than an audit row.
                     This tile read "Answers withheld as unsafe" on the admin
                     page once, which a client reasonably read as the product
                     blocking them. A guardrail asserts this wording against
                     the router's actual behavior. */
                  label="Answers flagged for review"
                  /* Phrased without the verb at all. "Recorded and delivered,
                     not blocked" was honest and still tripped the guardrail,
                     which matches on the word rather than the sentence. That
                     bluntness is deliberate: a check that tried to understand
                     negation could be talked around, and this copy is read by
                     clients. So the claim is made positively instead. */
                  /* SAYS WHAT A ZERO MEANS, because it has always been zero
                     and always honestly so. This counts what a MODEL sent
                     back, and for a product answering questions about
                     documents that shape is genuinely rare. Left unexplained,
                     a client reads "0" beside a safety promise as the safety
                     check having found nothing, when the check above has been
                     catching real things all along. */
                  note="Watches what the model sends back, which is rare in document work. The tile above is the one that catches pasted data."
                  testId="pilot-cap-flagged"
                />
              </div>
              {/* WHAT HAPPENS WHEN SOMETHING BREAKS.
                  Added 2026-08-30 because it became true that day, and
                  because it is the question a client asks after the demo
                  rather than during it. Every claim here is a shipped control
                  with a test behind it, not a roadmap item. */}
              <div
                className="wp-pilot-resilience"
                data-testid="pilot-resilience"
              >
                <h3 className="wp-pilot-subhead">When something breaks</h3>
                <ul className="wp-pilot-list">
                  <li>
                    <strong>
                      A brief failure is retried, not shown to you.
                    </strong>
                    When a model is throttled or a connection drops, the request
                    is made again before anybody sees anything. Most of these
                    clear in under a second, and until this shipped every one of
                    them ended somebody&rsquo;s question.
                  </li>
                  <li>
                    <strong>
                      An outage says so, and never blames your documents.
                    </strong>
                    If part of the system cannot be reached, the answer names
                    what could not be read and states plainly that nothing has
                    been lost and nothing needs re-uploading. It used to say
                    &ldquo;I don&rsquo;t have information on that yet&rdquo;
                    about a document it was holding, which reads as your library
                    having gone missing.
                  </li>
                  <li>
                    <strong>Pasted data never reaches a model.</strong>A card
                    number, national ID or key typed into a question is removed
                    before the prompt leaves this system, and the question is
                    still answered from your documents. Tested with all four,
                    including data pasted alongside a real question.
                  </li>
                  <li>
                    <strong>A quiet number is treated as a question.</strong>
                    Every figure on this page states what a zero means, because
                    a control that never ran and a control that found nothing
                    look identical otherwise. Where we cannot evidence a check
                    firing, we say that instead of showing you a clean-looking
                    count.
                  </li>
                </ul>
              </div>

              <p className="wp-pilot-aside">
                {/* A ZERO HERE IS ONLY GOOD NEWS IF THE CHECK RUNS. Reporting
                    "nothing needed redacting" from an inspector that never
                    fired is the same lie as an empty library reading as a
                    quiet one, and this product has shipped that mistake
                    before. */}
                {snap.capability.safety.inspectorProven
                  ? `${snap.capability.safety.responsesRedacted.value ?? 0} answers had something removed before they reached anyone. The check runs on every answer, so a low number here is the result rather than the absence of one.`
                  : "Redaction runs on every answer, but we cannot currently evidence it firing, so we are not reporting a count you could mistake for a clean bill of health."}
              </p>
            </section>
          ) : null}

          {/* THE STRONGEST NUMBER THIS PRODUCT HAS, GIVEN THE WEIGHT OF ONE.
              This was a bulleted list under two paragraphs of prose. Every
              figure was correct and the whole thing read as a footnote, which
              for the clearest commercial argument the product can make is a
              presentation bug rather than a taste one.

              The contrast leads now: what we paid, against the premium
              alternative, as one sentence. The bars carry the multiple
              visually so a reader sees 28x rather than parsing it, and they
              are drawn from the same numbers as the figures beside them
              rather than hand-set. The assumptions stay, moved below where
              they inform rather than delay. */}
          {comparison.length > 0 && snap.tokenUsage ? (
            <section
              className="wp-pilot-section"
              data-testid="pilot-cost-comparison"
            >
              <h2>What the same work costs elsewhere</h2>

              <div className="wp-cost-hero">
                <div className="wp-cost-hero-ours">
                  <p className="wp-cost-hero-value">
                    ${snap.tokenUsage.actualUsd.toFixed(2)}
                  </p>
                  <p className="wp-cost-hero-label">what we paid</p>
                </div>
                <div className="wp-cost-hero-vs">
                  <p className="wp-cost-hero-value wp-cost-hero-value-alt">
                    ${comparison[0].wouldHaveCostUsd.toFixed(2)}
                  </p>
                  <p className="wp-cost-hero-label">
                    the same work on {comparison[0].label}
                  </p>
                </div>
                {comparison[0].multipleOfActual !== null ? (
                  <p
                    className="wp-cost-hero-multiple"
                    data-testid="pilot-cost-headline"
                  >
                    {comparison[0].multipleOfActual}&times;
                  </p>
                ) : null}
              </div>

              <ul className="wp-cost-bars" data-testid="pilot-cost-rows">
                {[
                  {
                    label: "Wolfpack Instinct",
                    cost: snap.tokenUsage.actualUsd,
                    ours: true,
                    multiple: null as number | null,
                  },
                  ...comparison.map((c) => ({
                    label: c.label,
                    cost: c.wouldHaveCostUsd,
                    ours: false,
                    multiple: c.multipleOfActual,
                  })),
                ].map((row) => (
                  <li
                    key={row.label}
                    className={
                      row.ours ? "wp-cost-bar-row is-ours" : "wp-cost-bar-row"
                    }
                  >
                    <span className="wp-cost-bar-label">{row.label}</span>
                    <span className="wp-cost-bar-track">
                      <span
                        className="wp-cost-bar-fill"
                        /* Width from the real figures, so the picture cannot
                           disagree with the numbers printed beside it. A
                           floor of 1.5% keeps our own bar visible rather than
                           vanishing, which would read as missing data. */
                        style={{
                          width: `${Math.max(
                            1.5,
                            (row.cost / comparison[0].wouldHaveCostUsd) * 100,
                          )}%`,
                        }}
                      />
                    </span>
                    <span className="wp-cost-bar-value">
                      ${row.cost.toFixed(2)}
                      {row.multiple !== null ? (
                        <em className="wp-cost-bar-multiple">
                          {row.multiple}&times;
                        </em>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>

              {/* THE SAVING THAT COMPOUNDS, AND THE ONE THIS TABLE CANNOT SHOW.
                  An answer that needed a model is worked out once and then
                  kept, so the next person to ask gets it for nothing. A
                  product that bills per ask charges for every one of those
                  again, every time. Stating only "most questions never reach a
                  model" credited the routing and said nothing about the
                  engineering that makes the gap widen with use. */}
              {reuseCost !== null && snap.tokenUsage.reusedAnswers ? (
                <p className="wp-cost-compounds" data-testid="pilot-cost-reuse">
                  <strong>
                    {snap.tokenUsage.reusedAnswers.toLocaleString()} answers
                    came from work already done.
                  </strong>{" "}
                  Each was worked out once and has been free ever since. A
                  product that bills for every ask would have charged roughly $
                  {reuseCost.toFixed(2)} to answer those same repeats at{" "}
                  {comparison[0].label} rates, and would charge again the next
                  time anyone asks. That gap widens with use rather than staying
                  flat.
                </p>
              ) : null}

              <p className="wp-pilot-aside">
                Based on {snap.tokenUsage.inputTokens.toLocaleString()} tokens
                in and {snap.tokenUsage.outputTokens.toLocaleString()} out
                across {snap.tokenUsage.calls.toLocaleString()} model calls. It
                holds that token count fixed and changes only the price, so it
                is the cost of our traffic at their rates rather than a forecast
                of another product&rsquo;s bill. Published list prices recorded{" "}
                {PRICES_RECORDED_ON}, before any negotiated discount. This table
                prices only the traffic that genuinely reached a model, so it is
                the smallest of the savings: most questions are answered
                straight from connected systems, and the answers that did need a
                model are kept rather than bought again.
              </p>
            </section>
          ) : null}

          <section className="wp-pilot-section">
            <h2>What we declined to answer</h2>
            <div className="wp-pilot-figures">
              <Figure
                value={snap.declined.toLocaleString()}
                label="Refused rather than guessed"
                note="Retrieval judged irrelevant, or an answer refused entry into knowledge"
                testId="pilot-declined"
              />
            </div>
            <p className="wp-pilot-aside">
              Published rather than hidden, because a system that says it cannot
              find something is the one worth believing when it does answer. A
              count nobody can see turns that into a promise.
            </p>
          </section>

          {/* WHETHER ANYBODY IS ACTUALLY USING IT.
              Every other figure on this page describes the product working.
              None of them says whether the people it was bought for have taken
              it up, and a pilot can post good numbers while most of the team
              never opened it.

              The numbers here are deliberately unflattering. Anyone can report
              active users; this reports who never started, who stopped, and
              who kept asking without getting an answer, because those are the
              three a client otherwise discovers at the end of the pilot. */}
          {snap.adoption ? (
            <section className="wp-pilot-section" data-testid="pilot-adoption">
              <h2>Is the team using it</h2>
              {!snap.adoption.readable ? (
                <p
                  className="wp-pilot-aside"
                  data-testid="pilot-adoption-unreadable"
                >
                  Adoption could not be read just now. That is not the same as
                  nobody using it, and this panel will not guess which.
                </p>
              ) : (
                <>
                  <div className="wp-pilot-figures">
                    <Figure
                      value={`${snap.adoption.everAsked} of ${snap.adoption.invited}`}
                      label="Have asked something"
                      note={
                        reachedShare(snap.adoption) !== null
                          ? `${Math.round((reachedShare(snap.adoption) as number) * 100)}% of the people with access`
                          : "No one has been given access yet"
                      }
                      testId="pilot-adoption-reach"
                    />
                    <Figure
                      value={snap.adoption.activeRecently.toLocaleString()}
                      label="Active this week"
                      note="Asked something in the last seven days"
                      testId="pilot-adoption-active"
                    />
                    <Figure
                      value={(
                        neverStarted(snap.adoption) ?? 0
                      ).toLocaleString()}
                      label="Never started"
                      note="Have access and have never asked anything"
                      testId="pilot-adoption-never"
                    />
                    <Figure
                      value={snap.adoption.lapsed.toLocaleString()}
                      label="Drifted away"
                      note="Used it, then nothing for a fortnight"
                      testId="pilot-adoption-lapsed"
                    />
                  </div>

                  {/* THE SIGNAL THAT NEVER ARRIVES AS A COMPLAINT. Somebody
                      asking the same thing repeatedly and getting nothing looks
                      identical, from the outside, to somebody losing interest. */}
                  {snap.adoption.repeatedFailures.length > 0 ? (
                    <div data-testid="pilot-adoption-failures">
                      <p className="wp-pilot-aside">
                        Asked more than once and never answered. Each one is
                        somebody who kept trying, and none of them arrived as a
                        complaint.
                      </p>
                      <ul className="wp-pilot-list">
                        {snap.adoption.repeatedFailures.map((f) => (
                          <li key={f.question}>
                            <strong>{f.attempts}&times;</strong> {f.question}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <p className="wp-pilot-aside">
                    {adoptionVerdict(snap.adoption) === "slipping"
                      ? "More people have drifted away than are using it. Worth asking them why while the pilot is still running."
                      : adoptionVerdict(snap.adoption) === "narrow"
                        ? "It has taken hold with a few people rather than the team. The ones who never started are the cheapest to win back."
                        : adoptionVerdict(snap.adoption) === "not_started"
                          ? "Nobody has asked anything yet."
                          : "Most of the team has tried it and few have drifted away."}
                  </p>

                  {/* WHAT WE DO ABOUT IT, named next to the number that triggers it.
                  A dashboard that reports adoption and stops is a scoreboard.
                  Each line below is tied to a figure above, so the plan moves
                  when the figure does rather than being restated every month. */}
                  <div data-testid="pilot-adoption-plan">
                    <h3 className="wp-pilot-subhead">
                      How we move these numbers
                    </h3>
                    <ul className="wp-pilot-list">
                      <li>
                        <strong>The ones who never started.</strong> They get
                        reached where they already work rather than in another
                        tool: the weekly briefing, mail, and Teams all carry the
                        same short prompt, written for the job they actually do.
                        One person&rsquo;s first useful question is worth more
                        than ten broadcasts.
                      </li>
                      <li>
                        <strong>
                          Every repeated failure above is a real request.
                        </strong>{" "}
                        One that nobody filed as one. Each becomes either a
                        connected source or an honest &ldquo;we do not hold
                        that&rdquo;, and the person who asked is told which.
                        That is how the list gets shorter.
                      </li>
                      <li>
                        <strong>A new source earns its own invitation.</strong>{" "}
                        When a library or system connects, the people whose work
                        lives in it are the ones who hear about it, with
                        examples drawn from their own material rather than a
                        feature announcement.
                      </li>
                      <li>
                        <strong>
                          Drift is treated as a question, not a churn number.
                        </strong>{" "}
                        Somebody who used it and stopped is asked what they went
                        back to. That answer is the cheapest research in the
                        pilot.
                      </li>
                    </ul>
                  </div>
                </>
              )}
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}
