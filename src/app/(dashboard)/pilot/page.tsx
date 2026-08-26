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
  const [snap, setSnap] = useState<PhaseOneSnapshot | null>(null);
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
        const data = (await res.json()) as PhaseOneSnapshot;
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
        </>
      )}
    </main>
  );
}
