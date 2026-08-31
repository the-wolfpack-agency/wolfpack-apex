"use client";

/**
 * /builds/course-program - a new course for a new client.
 *
 * ORDERED SO THE CONSTRAINT ARRIVES BEFORE THE IDEAS. The copyright line on
 * their material is the first thing on the page, because every design decision
 * below is downstream of it and because somebody skimming needs to hit it
 * before they start imagining slides.
 *
 * Everything rendered comes from lib/builds/course-program.ts, where a test
 * pins it. A document claiming we understand their program should not be able
 * to drift from what their program actually says.
 */

import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import {
  CANDOR_CONSTRAINT,
  COMMITMENT_LADDER,
  COMPONENTS,
  CONFIGURATION,
  COPYRIGHT_LINE,
  CORPUS,
  DELIVERABLES,
  HEADLINE,
  IMPROVEMENTS,
  IP_POSITION,
  OPEN_QUESTIONS,
  REUSED,
} from "@/lib/builds/course-program";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/course-program")!;

const TRANSFER_LABEL: Record<string, string> = {
  structure: "structure only",
  "structure and wording": "as written",
  "not at all": "rebuild",
};

export default function CourseProgramPage() {
  return (
    <div className="wp-pilot">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">New course, new client</p>
        <h1>Taking the method, not the material</h1>
        <p className="wp-pilot-sub">{HEADLINE}</p>
      </header>

      {/* FIRST, BEFORE ANY IDEAS. */}
      <section className="wp-pilot-section" data-testid="cp-ip">
        <h2>What we can and cannot take</h2>
        <blockquote className="wp-build-quote">{COPYRIGHT_LINE}</blockquote>
        <p className="wp-pilot-aside">
          That line sits at the foot of every page of both facilitator guides. {IP_POSITION}
        </p>
      </section>

      {/* THE ACTUAL FINDING. Not a list of features: an order. */}
      <section className="wp-pilot-section" data-testid="cp-ladder">
        <h2>Why it works</h2>
        <p className="wp-pilot-aside">
          Every artifact feeds the next one. A course that ships these as separate worksheets has
          copied the components and missed the design, which is the most common way this gets
          rebuilt badly.
        </p>
        <ol className="wp-build-ladder">
          {COMMITMENT_LADDER.map((step, i) => (
            <li key={step}>
              <span className="wp-build-flow-n">{i + 1}</span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="wp-pilot-section" data-testid="cp-components">
        <h2>The week, and what travels</h2>
        <p className="wp-pilot-aside">
          Read from {CORPUS.facilitatorGuides} facilitator guides across {CORPUS.courseDays} days and{" "}
          {CORPUS.levels} levels. Structure travels; anything written for one brand does not.
        </p>
        <div className="wp-build-table-wrap">
          <table className="wp-build-table">
            <thead>
              <tr>
                <th scope="col">Component</th>
                <th scope="col">What it does</th>
                <th scope="col">Travels</th>
                <th scope="col">Becomes</th>
              </tr>
            </thead>
            <tbody>
              {COMPONENTS.map((c) => (
                <tr key={c.name}>
                  <td>
                    <strong>{c.name}</strong>
                  </td>
                  <td>
                    <span>{c.purpose}</span>
                  </td>
                  <td>
                    <span className={`wp-build-travel wp-build-travel--${c.transfers.replace(/\s/g, "-")}`}>
                      {TRANSFER_LABEL[c.transfers]}
                    </span>
                  </td>
                  <td>
                    <span>{c.becomes}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="wp-pilot-section" data-testid="cp-improvements">
        <h2>Where we make it better</h2>
        <p className="wp-pilot-aside">
          Each of these is a measurement failure rather than a design one, which is why the fixes are
          cheap. The follow-through already exists: {CORPUS.mobileCoachRules} rows of SMS coaching
          script that check in weekly for a year. It just does not know what anybody committed to.
        </p>
        <div className="wp-build-table-wrap">
          <table className="wp-build-table">
            <thead>
              <tr>
                <th scope="col">Today</th>
                <th scope="col">Proposed</th>
                <th scope="col">Why it matters</th>
              </tr>
            </thead>
            <tbody>
              {IMPROVEMENTS.map((im) => (
                <tr key={im.title}>
                  <td>
                    <strong>{im.title}</strong>
                    <span>{im.today}</span>
                  </td>
                  <td>{im.proposed}</td>
                  <td>{im.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="wp-pilot-aside" data-testid="cp-candor">
          <strong>A constraint, not a feature.</strong> {CANDOR_CONSTRAINT}
        </p>
      </section>

      <section className="wp-pilot-section" data-testid="cp-deliverables">
        <h2>What we deliver</h2>
        <p className="wp-pilot-aside">
          Separated so a client can buy part of it. Most of the cost is the content modules, and
          most of the differentiation is the last three lines.
        </p>
        <ul className="wp-pilot-list">
          {DELIVERABLES.map((d) => (
            <li key={d.what}>
              <strong>{d.what}</strong> {d.detail}
            </li>
          ))}
        </ul>
      </section>

      <section className="wp-pilot-section" data-testid="cp-configuration">
        <h2>What changes per client</h2>
        <ul className="wp-pilot-list">
          {CONFIGURATION.map((c) => (
            <li key={c.setting}>
              <strong>{c.setting}</strong> {c.why}
            </li>
          ))}
        </ul>
      </section>

      <section className="wp-pilot-section" data-testid="cp-reuse">
        <h2>What this reuses</h2>
        <p className="wp-pilot-aside">Built and tested already. None of it is new work.</p>
        <ul className="wp-pilot-list">
          {REUSED.map((r) => (
            <li key={r.have}>
              <strong>{r.have}</strong> {r.serves}
            </li>
          ))}
        </ul>
      </section>

      {/* LAST, AND ON THE PAGE. */}
      <section className="wp-pilot-section" data-testid="cp-open">
        <h2>What we need to know before quoting</h2>
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
