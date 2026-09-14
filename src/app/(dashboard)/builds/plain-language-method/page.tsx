"use client";

/**
 * /builds/plain-language-method - the reusable change-management engine, client-neutral.
 *
 * ORDERED AS AN ARGUMENT: the insight (gatekeeping), the method, the ladder, the
 * field track, what it reuses, then the recipe for pointing it at any client and
 * where it has been pointed.
 *
 * WHAT IS REAL: the method is proven (the Brand Ambassador program). This page is
 * the client-neutral generalization; nothing is measured, and the Palo Alto build
 * is one worked example. Everything comes from lib/builds/plain-language-method.ts.
 */

import Link from "next/link";
import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import {
  APPLY,
  FIELD_TRACK,
  GATEKEEPING,
  LADDER,
  METHOD,
  REUSES,
  WORKED_EXAMPLES,
} from "@/lib/builds/plain-language-method";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/plain-language-method")!;

export default function PlainLanguageMethodPage() {
  return (
    <div className="wp-pilot">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">The reusable engine</p>
        <h1>The plain-language method, for any client</h1>
        <p className="wp-pilot-sub">
          The change-management engine underneath the Palo Alto build, lifted out of the Palo Alto
          specifics. The content changes per client; the method does not.
        </p>
      </header>

      <section className="wp-pilot-section" data-testid="plm-gatekeeping">
        <h2>Why it works: jargon is gatekeeping</h2>
        <p className="wp-pilot-aside">{GATEKEEPING}</p>
      </section>

      <section className="wp-pilot-section" data-testid="plm-method">
        <h2>The method</h2>
        <ol className="wp-build-ladder">
          {METHOD.map((m, i) => (
            <li key={m.beat}>
              <span className="wp-build-flow-n">{i + 1}</span>
              <span><strong>{m.beat}.</strong> {m.does}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="wp-pilot-section" data-testid="plm-ladder">
        <h2>The certification ladder</h2>
        <div className="wp-build-table-wrap">
          <table className="wp-build-table">
            <thead>
              <tr><th scope="col">Tier</th><th scope="col">Who (varies per client)</th><th scope="col">What it proves</th></tr>
            </thead>
            <tbody>
              {LADDER.map((t) => (
                <tr key={t.tier}><td><strong>{t.tier}</strong></td><td>{t.who}</td><td>{t.proves}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="wp-pilot-section" data-testid="plm-field">
        <h2>The field / deployment track</h2>
        <p className="wp-pilot-aside">{FIELD_TRACK.why}</p>
        <ul className="wp-pilot-list">
          {FIELD_TRACK.covers.map((c) => <li key={c}>{c}</li>)}
        </ul>
      </section>

      <section className="wp-pilot-section" data-testid="plm-reuse">
        <h2>What it reuses</h2>
        <ul className="wp-pilot-list">
          {REUSES.map((r) => <li key={r.have}><strong>{r.have}</strong> {r.serves}</li>)}
        </ul>
      </section>

      <section className="wp-pilot-section" data-testid="plm-apply">
        <h2>Pointing it at any client</h2>
        <ol className="wp-build-ladder">
          {APPLY.map((a, i) => (
            <li key={a.step}>
              <span className="wp-build-flow-n">{i + 1}</span>
              <span><strong>{a.step}</strong> {a.why}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="wp-pilot-section" data-testid="plm-examples">
        <h2>Where it has been pointed</h2>
        <ul className="wp-pilot-list">
          {WORKED_EXAMPLES.map((e) => (
            <li key={e.client}>
              <strong>{e.client}.</strong>{" "}
              {e.where ? <Link href={e.where}>{e.where}</Link> : "Not yet built."} {e.note}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
