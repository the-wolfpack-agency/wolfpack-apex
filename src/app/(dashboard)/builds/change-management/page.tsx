"use client";

/**
 * /builds/change-management - replacing the Change Management Plan.
 *
 * WHAT THIS PAGE IS. The concept, the evidence under it, and the argument for
 * why the current tool is the wrong shape rather than a bad version of the
 * right one. Written to be read by somebody who has to decide, so it opens
 * with what is working and keeps what we do not know at the bottom rather than
 * out of sight.
 *
 * EVERYTHING RENDERED HERE COMES FROM lib/builds/change-management.ts, where a
 * test pins the figures. A page whose whole argument is that we measured their
 * process should not be able to drift from what was measured.
 */

import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import {
  CANDOUR_CONSTRAINT,
  COMMITMENT_STATES,
  CONFIGURATION,
  EVIDENCE,
  FINDINGS,
  FLOW,
  HEADLINE,
  IMPROVEMENTS,
  OPEN_QUESTIONS,
  PLANS_PER_CYCLE,
  REUSED,
  SIBLING_MODULE,
  THEIR_DESCRIPTION,
} from "@/lib/builds/change-management";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/change-management")!;

export default function ChangeManagementPage() {
  return (
    <div className="wp-pilot">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Porsche Academy US</p>
        <h1>Change Management Plan</h1>
        <p className="wp-pilot-sub">{HEADLINE}</p>
      </header>

      {/* THEIR WORDS FIRST. The whole design answers this sentence, and
          paraphrasing it would let the design answer something easier. */}
      <section className="wp-pilot-section" data-testid="cm-their-words">
        <h2>How they describe it</h2>
        <blockquote className="wp-build-quote">{THEIR_DESCRIPTION}</blockquote>
        <p className="wp-pilot-aside">
          Four moments, and only the first is a form. BA102 runs {EVIDENCE.ba102Classes} classes
          of {EVIDENCE.participantsPerClass}, so roughly {PLANS_PER_CYCLE} plans a cycle, each
          with a manager attached and a coaching conversation after it.
        </p>
        <ul className="wp-build-flow" data-testid="cm-flow">
          {FLOW.map((f, i) => (
            <li key={f.step} className={f.heldByAForm ? "wp-build-flow--held" : "wp-build-flow--loose"}>
              {/* Numbered because this genuinely is a sequence: the order is
                  the finding. Three of four fall outside what a form holds. */}
              <span className="wp-build-flow-n">{i + 1}</span>
              <span className="wp-build-flow-step">{f.step}</span>
              <span className="wp-build-flow-today">{f.today}</span>
              <span className="wp-build-flow-tag">
                {f.heldByAForm ? "a form holds this" : "nowhere to live"}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="wp-pilot-section" data-testid="cm-findings">
        <h2>What the walk found</h2>
        <p className="wp-pilot-aside">
          A read-only walk of {EVIDENCE.surfacesWalked} screens on their tenant. Nothing was
          created, changed or submitted.
        </p>
        <ul className="wp-build-findings">
          {FINDINGS.map((f) => (
            <li key={f.title}>
              <h3>{f.title}</h3>
              <p>{f.detail}</p>
              <p className="wp-build-evidence">{f.evidence}</p>
            </li>
          ))}
        </ul>
      </section>

      {/* THE STATE MACHINE IS THE DESIGN, so it comes before the feature list
          rather than after it as an implementation note. */}
      <section className="wp-pilot-section" data-testid="cm-states">
        <h2>What a commitment does</h2>
        <p className="wp-pilot-aside">
          The states are chosen so that doing nothing is visible. Every post-training
          commitment fails the same way, silently, so <strong>active</strong> is a state a
          commitment leaves on a clock rather than one it can rest in.
        </p>
        <ol className="wp-build-states">
          {COMMITMENT_STATES.map((s) => (
            <li key={s.name}>
              <span className="wp-build-state-name">{s.name}</span>
              <span className="wp-build-state-meaning">{s.meaning}</span>
              <span className="wp-build-state-leaves">{s.leaves}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="wp-pilot-section" data-testid="cm-improvements">
        <h2>What changes, and what it makes answerable</h2>
        <div className="wp-build-table-wrap">
          <table className="wp-build-table">
            <thead>
              <tr>
                <th scope="col">Today</th>
                <th scope="col">Proposed</th>
                <th scope="col">What it makes answerable</th>
              </tr>
            </thead>
            <tbody>
              {IMPROVEMENTS.map((im) => (
                <tr key={im.title}>
                  <td>
                    <strong>{im.title}</strong>
                    <span>{im.now}</span>
                  </td>
                  <td>{im.proposed}</td>
                  <td>{im.unlocks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="wp-pilot-aside" data-testid="cm-candour">
          <strong>A constraint, not a feature.</strong> {CANDOUR_CONSTRAINT}
        </p>
      </section>

      <section className="wp-pilot-section" data-testid="cm-configuration">
        <h2>What a program owner sets up</h2>
        <p className="wp-pilot-aside">
          BA101 and BA102 are different courses. Anything hard-coded here becomes a second
          form the next time one changes, which is the failure being replaced.
        </p>
        <ul className="wp-pilot-list">
          {CONFIGURATION.map((c) => (
            <li key={c.setting}>
              <strong>{c.setting}</strong> {c.why}
            </li>
          ))}
        </ul>
      </section>

      <section className="wp-pilot-section" data-testid="cm-reuse">
        <h2>What this reuses</h2>
        <p className="wp-pilot-aside">Built and tested already. None of it is new work.</p>
        <ul className="wp-pilot-list">
          {REUSED.map((r) => (
            <li key={r.have}>
              <strong>{r.have}</strong> {r.serves}
            </li>
          ))}
        </ul>
        <p className="wp-pilot-aside" data-testid="cm-sibling">
          <strong>The near miss worth naming.</strong> {SIBLING_MODULE}
        </p>
      </section>

      {/* LAST, AND ON THE PAGE. A concept that hides what it does not know
          gets found out in the room where it is presented. */}
      <section className="wp-pilot-section" data-testid="cm-open">
        <h2>What we do not know yet</h2>
        <ul className="wp-build-findings">
          {OPEN_QUESTIONS.map((q) => (
            <li key={q.question}>
              <h3>{q.question}</h3>
              <p>{q.why}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
