"use client";

/**
 * /builds/ai-data-governance - the data-path layer that complements Prisma AIRS.
 *
 * ORDERED AS AN ARGUMENT: where it sits (the doorway, not the room), the controls,
 * then the honest boundary (real capability, not a Palo Alto integration).
 *
 * WHAT IS REAL: the controls run in our inference router today. What is a concept
 * is the Palo Alto framing; they are not a client and nothing here is measured.
 * The banner says so. Everything comes from lib/builds/ai-data-governance.ts.
 */

import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import { CONTROLS, HEADLINE, SEAM, WHATS_REAL } from "@/lib/builds/ai-data-governance";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/ai-data-governance")!;

export default function AIDataGovernancePage() {
  return (
    <div className="wp-pilot">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">AI data governance</p>
        <h1>Govern the doorway, not just the room</h1>
        <p className="wp-pilot-sub">{HEADLINE}</p>
      </header>

      <section className="wp-pilot-section" data-testid="adg-seam">
        <h2>Where it sits</h2>
        <p className="wp-pilot-aside">{SEAM}</p>
      </section>

      <section className="wp-pilot-section" data-testid="adg-controls">
        <h2>The controls</h2>
        <div className="wp-build-table-wrap">
          <table className="wp-build-table">
            <thead>
              <tr>
                <th scope="col">Control / jargon</th>
                <th scope="col">What is actually happening</th>
                <th scope="col">What it stops</th>
                <th scope="col">Without it</th>
              </tr>
            </thead>
            <tbody>
              {CONTROLS.map((c) => (
                <tr key={c.name}>
                  <td>
                    <strong>{c.name}</strong>
                    <span>{c.jargon}</span>
                  </td>
                  <td>{c.plain}</td>
                  <td>{c.stops}</td>
                  <td>{c.without}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="wp-pilot-section" data-testid="adg-real">
        <h2>What is real, and what is not</h2>
        <ul className="wp-pilot-list">
          {WHATS_REAL.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
