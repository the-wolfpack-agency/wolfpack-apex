"use client";

/**
 * /builds/ogiam-explained - a plain-language explanation of OGIAM's governance
 * features for a non-technical reader, staged in the real shell as a pre-build
 * ahead of OGIAM getting its own repo.
 *
 * WHAT IS REAL HERE. Every capability described is built and running in Instinct
 * today, EXCEPT the "Forcefield for the Web" section, which the page marks as
 * coming next. No metrics are shown. The banner carries that sentence, and all
 * content comes from lib/builds/ogiam-explained.ts, where a test pins the shape.
 */

import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import {
  OGIAM_HEADLINE,
  OGIAM_ANALOGY,
  OGIAM_SECTIONS,
  OGIAM_CLOSER,
} from "@/lib/builds/ogiam-explained";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/ogiam-explained")!;

export default function OgiamExplainedPage() {
  return (
    <div className="wp-pilot">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">OGIAM, in plain language</p>
        <h1>Safe AI you can actually put to work</h1>
        <p className="wp-pilot-sub">{OGIAM_HEADLINE}</p>
        <p className="wp-pilot-aside">{OGIAM_ANALOGY}</p>
      </header>

      {OGIAM_SECTIONS.map((s) => (
        <section
          key={s.id}
          className="wp-pilot-section"
          data-testid={`ogiam-${s.id}`}
          aria-label={s.title}
        >
          <p className="wp-pilot-eyebrow">
            {s.eyebrow}
            {s.roadmap ? (
              <span className="wp-build-banner-stage wp-build-stage--concept" style={{ marginLeft: 8 }} data-testid={`ogiam-${s.id}-roadmap`}>
                Coming next
              </span>
            ) : null}
          </p>
          <h2>{s.title}</h2>
          {s.body.map((p, i) => (
            <p key={i} className="wp-pilot-aside">{p}</p>
          ))}
          {s.how ? (
            <ol className="wp-build-ladder">
              {s.how.map((step, i) => (
                <li key={i}>
                  <span className="wp-build-flow-n">{i + 1}</span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {s.meaning ? (
            <p className="wp-pilot-aside">
              <strong>What this means for you.</strong> {s.meaning}
            </p>
          ) : null}
        </section>
      ))}

      <section className="wp-pilot-section" data-testid="ogiam-closer">
        <h2>The bigger picture</h2>
        <p className="wp-pilot-aside">{OGIAM_CLOSER}</p>
      </section>
    </div>
  );
}
