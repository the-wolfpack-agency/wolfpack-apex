"use client";

/**
 * /builds/security-plain-language - a plain-language product certification for
 * everyone Palo Alto's engineer-only training leaves out.
 *
 * ORDERED AS AN ARGUMENT. The gap (who gets left out), then the method (the four
 * beats), then the method applied to their real product line, then the
 * certification the method becomes, then what it reuses from the proven program,
 * then what turns this drawing into an engagement. A reader who stops after the
 * first two sections still has the finding.
 *
 * WHAT IS REAL HERE. Nothing is measured, Palo Alto is not a client, and every
 * product description is written from public knowledge, not their material. The
 * banner says so. Everything rendered comes from lib/builds/security-plain-language.ts,
 * where a test pins the shape.
 */

import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import {
  CERT_PREMISE,
  CERT_TIERS,
  HEADLINE,
  METHOD,
  PRECISION_NOTE,
  PRODUCTS,
  REUSES,
  TO_BUILD_OUT,
  WHY_IT_WORKS,
} from "@/lib/builds/security-plain-language";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/security-plain-language")!;

export default function SecurityPlainLanguagePage() {
  return (
    <div className="wp-pilot">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Plain-language product certification</p>
        <h1>Take the gates down</h1>
        <p className="wp-pilot-sub">{HEADLINE}</p>
      </header>

      {/* THE GAP. */}
      <section className="wp-pilot-section" data-testid="spl-premise">
        <h2>Who gets left out</h2>
        <p className="wp-pilot-aside">{CERT_PREMISE}</p>
      </section>

      {/* THE METHOD. */}
      <section className="wp-pilot-section" data-testid="spl-method">
        <h2>The method</h2>
        <p className="wp-pilot-aside">
          Four beats, applied to anything. Naming the method matters: it is a thing a client&apos;s own
          people can run on the next feature, not a set of paragraphs we hand over once.
        </p>
        <ol className="wp-build-ladder">
          {METHOD.map((m, i) => (
            <li key={m.beat}>
              <span className="wp-build-flow-n">{i + 1}</span>
              <span>
                <strong>{m.beat}.</strong> {m.does}
              </span>
            </li>
          ))}
        </ol>
        <p className="wp-pilot-aside" data-testid="spl-precision">
          <strong>Simple and exact, at the same time.</strong> {PRECISION_NOTE}
        </p>
      </section>

      {/* THE METHOD APPLIED TO THEIR REAL LINE. */}
      <section className="wp-pilot-section" data-testid="spl-products">
        <h2>The four beats, on their product line</h2>
        <p className="wp-pilot-aside">
          Written from public knowledge of what these products do, as a sample of the language.
          In an engagement, these come from their own decks and calls so the words match how their
          teams already talk.
        </p>
        <div className="wp-build-table-wrap">
          <table className="wp-build-table">
            <thead>
              <tr>
                <th scope="col">Product / jargon</th>
                <th scope="col">What is actually happening</th>
                <th scope="col">What it stops</th>
                <th scope="col">Without it</th>
              </tr>
            </thead>
            <tbody>
              {PRODUCTS.map((p) => (
                <tr key={p.name}>
                  <td>
                    <strong>{p.name}</strong>
                    <span>{p.jargon}</span>
                  </td>
                  <td>{p.plain}</td>
                  <td>{p.stops}</td>
                  <td>{p.without}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* THE CERTIFICATION THE METHOD BECOMES. */}
      <section className="wp-pilot-section" data-testid="spl-tiers">
        <h2>The certification</h2>
        <p className="wp-pilot-aside">
          A ladder, not a course. Each tier is a capability a person is certified against, so it
          means something to the customer and to the team lead, not just a slide someone clicked
          through.
        </p>
        <div className="wp-build-table-wrap">
          <table className="wp-build-table">
            <thead>
              <tr>
                <th scope="col">Tier</th>
                <th scope="col">Who</th>
                <th scope="col">What it proves they can do</th>
              </tr>
            </thead>
            <tbody>
              {CERT_TIERS.map((t) => (
                <tr key={t.tier}>
                  <td>
                    <strong>{t.tier}</strong>
                  </td>
                  <td>{t.who}</td>
                  <td>{t.proves}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* WHAT IT REUSES, SO IT IS BUILDABLE NOT A GUESS. */}
      <section className="wp-pilot-section" data-testid="spl-reuse">
        <h2>What this reuses</h2>
        <p className="wp-pilot-aside">
          The method behind the Brand Ambassador change-management program (see the &quot;New course,
          new client&quot; build) transfers. The security content is new; the structure is proven.
        </p>
        <ul className="wp-pilot-list">
          {REUSES.map((r) => (
            <li key={r.have}>
              <strong>{r.have}</strong> {r.serves}
            </li>
          ))}
        </ul>
      </section>

      <section className="wp-pilot-section" data-testid="spl-why">
        <h2>Why the team feels it</h2>
        <ul className="wp-pilot-list">
          {WHY_IT_WORKS.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>

      {/* LAST, AND ON THE PAGE. */}
      <section className="wp-pilot-section" data-testid="spl-tobuild">
        <h2>What turns this into an engagement</h2>
        <ul className="wp-build-findings">
          {TO_BUILD_OUT.map((q) => (
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
