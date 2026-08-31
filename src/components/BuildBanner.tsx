"use client";

/**
 * The marker that says a page is engagement work, not Instinct.
 *
 * WHAT IT IS FOR. Phase One sat in the same nav as Assistant and Search,
 * styled like everything else, and nothing on it said it was built for one
 * client rather than shipped in the product. A page that cannot be told apart
 * from the product will eventually be shown as the product.
 *
 * THE LINE THAT MATTERS MOST IS THE LAST ONE. Which client is useful. What the
 * numbers ARE is the thing that changes the conversation, because a drawn page
 * and a measured one produce identical screenshots. So the banner always
 * carries that sentence, from the register, rather than leaving it to whoever
 * is presenting to remember.
 */

import Link from "next/link";
import type { ClientBuild } from "@/lib/builds/registry";

const STAGE_LABEL: Record<ClientBuild["stage"], string> = {
  concept: "Concept",
  "in flight": "In flight",
  live: "Live",
};

export default function BuildBanner({ build }: { build: ClientBuild }) {
  return (
    <aside
      className={`wp-build-banner wp-build-banner--${build.stage.replace(" ", "-")}`}
      data-testid="build-banner"
      aria-label="Client build"
    >
      <p className="wp-build-banner-top">
        <span className="wp-build-banner-stage" data-testid="build-banner-stage">
          {STAGE_LABEL[build.stage]}
        </span>
        <span className="wp-build-banner-client">{build.client}</span>
        <Link className="wp-build-banner-link" href="/builds">
          All client builds
        </Link>
      </p>
      {/* The sentence that stops a concept being demoed as a product. */}
      <p className="wp-build-banner-data" data-testid="build-banner-data">
        {build.data}
      </p>
    </aside>
  );
}
