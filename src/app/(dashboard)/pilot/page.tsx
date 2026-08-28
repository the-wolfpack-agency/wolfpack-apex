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

export default function PilotPage() {
  const [snap, setSnap] = useState<(PhaseOneSnapshot & { adoption?: AdoptionSnapshot }) | null>(null);
  const [failed, setFailed] = useState(false);

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
        const data = (await res.json()) as PhaseOneSnapshot & { adoption?: AdoptionSnapshot };
        if (live) setSnap(data);
      } catch {
        if (live) setFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const share = snap ? deterministicShare(snap) : null;
  const answers = snap ? answersGiven(snap) : 0;
  const unreadable = failed || (snap !== null && !snap.readable);

  return (
    <main className="wp-pilot" data-testid="phase-one-dashboard">
      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Phase one · last 60 days</p>
        <h1>Their library, read and answerable</h1>
        <p className="wp-pilot-sub">
          Everything below is measured on this deployment. It is what a client sees in
          phase one, running on our own data so the shape is proven before theirs is in
          it.
        </p>
      </header>

      {unreadable ? (
        /* Not zeros. Zeros here would claim an empty corpus and a silent
           assistant, which is more alarming and less true than saying the
           figures could not be read. */
        <p className="wp-pilot-unreadable" data-testid="pilot-unreadable">
          These figures could not be read just now. That is not an empty corpus and not a
          quiet week: it is an unmeasured one, and the difference matters.
        </p>
      ) : !snap ? (
        <p className="wp-pilot-sub" data-testid="pilot-loading">
          Reading the figures…
        </p>
      ) : (
        <>
          <section className="wp-pilot-section">
            <h2>What we can read</h2>
            <div className="wp-pilot-figures">
              <Figure
                value={snap.passages.toLocaleString()}
                label="Passages answerable"
                note="Indexed, scoped by the library each came from"
                testId="pilot-passages"
              />
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
              The line between those last two is the product. Most questions are answered
              by reading their own systems, which is what makes this cheap, auditable and
              predictable, and it is the opposite of how a chatbot works.
            </p>
          </section>

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
              Published rather than hidden, because a system that says it cannot find
              something is the one worth believing when it does answer. A count nobody can
              see turns that into a promise.
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
                <p className="wp-pilot-aside" data-testid="pilot-adoption-unreadable">
                  Adoption could not be read just now. That is not the same as nobody
                  using it, and this panel will not guess which.
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
                      value={(neverStarted(snap.adoption) ?? 0).toLocaleString()}
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
                        Asked more than once and never answered. Each one is somebody who
                        kept trying, and none of them arrived as a complaint.
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
                <h3 className="wp-pilot-subhead">How we move these numbers</h3>
                <ul className="wp-pilot-list">
                  <li>
                    <strong>The ones who never started</strong> get reached where they
                    already work rather than in another tool: the weekly briefing, mail,
                    and Teams all carry the same short prompt, written for the job they
                    actually do. One person&rsquo;s first useful question is worth more
                    than ten broadcasts.
                  </li>
                  <li>
                    <strong>Every repeated failure above is a real request</strong> that
                    nobody filed as one. Each becomes either a connected source or an
                    honest &ldquo;we do not hold that&rdquo;, and the person who asked is
                    told which. That is how the list gets shorter.
                  </li>
                  <li>
                    <strong>A new source earns its own invitation.</strong> When a library
                    or system connects, the people whose work lives in it are the ones who
                    hear about it, with examples drawn from their own material rather than
                    a feature announcement.
                  </li>
                  <li>
                    <strong>Drift is treated as a question, not a churn number.</strong>
                    Somebody who used it and stopped is asked what they went back to. That
                    answer is the cheapest research in the pilot.
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
