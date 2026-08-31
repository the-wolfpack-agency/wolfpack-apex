"use client";

/**
 * /builds - the register of work that belongs to a client, not to Instinct.
 *
 * WHY A SECTION RATHER THAN A FOLDER CONVENTION. Two things need to agree: the
 * page itself has to declare what it is, and somebody who has never seen it has
 * to be able to find it. A naming convention does the second and not the first,
 * which is how Phase One ended up indistinguishable from a shipped feature.
 *
 * WHAT IT IS ALSO FOR. Wireframes and mocks can live here and be looked at on a
 * real URL, in the real shell, before anybody stands up a repo. The cost of
 * being wrong about a shape drops to an afternoon, and the banner on each page
 * keeps a drawing from being mistaken for a build.
 */

import Link from "next/link";
import { CLIENT_BUILDS, type ClientBuild } from "@/lib/builds/registry";

const STAGE_LABEL: Record<ClientBuild["stage"], string> = {
  concept: "Concept",
  "in flight": "In flight",
  live: "Live",
};

export default function BuildsPage() {
  return (
    <div className="wp-pilot">
      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Client builds</p>
        <h1>Work in flight</h1>
        <p className="wp-pilot-sub">
          Pages built for a client engagement. They live in this shell so they can be
          looked at on a real URL, in the real product, before anybody stands up a repo.
          None of them is part of Instinct, and each one says what its numbers are.
        </p>
      </header>

      <ul className="wp-build-list" data-testid="builds-list">
        {CLIENT_BUILDS.map((b) => (
          <li key={b.href} className="wp-build-card">
            <p className="wp-build-card-top">
              <span className={`wp-build-banner-stage wp-build-stage--${b.stage.replace(" ", "-")}`}>
                {STAGE_LABEL[b.stage]}
              </span>
              <span className="wp-build-banner-client">{b.client}</span>
            </p>
            <h2>
              <Link href={b.href}>{b.title}</Link>
            </h2>
            <p className="wp-build-card-what">{b.what}</p>
            {/* Repeated from the page's own banner on purpose. Somebody
                deciding what to open should already know whether they are
                about to look at a measurement or a drawing. */}
            <p className="wp-build-card-data">{b.data}</p>
          </li>
        ))}
      </ul>
    </div>
  );
}
