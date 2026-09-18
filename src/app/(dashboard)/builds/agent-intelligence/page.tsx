"use client";

/**
 * /builds/agent-intelligence - a plain-language explanation of the agent
 * behavioral-intelligence capability, staged in the real shell as a pre-build
 * ahead of it getting its own repo, so the design + copy port cleanly.
 *
 * WHAT IS REAL HERE. Every capability described is built and running today,
 * EXCEPT the "operators board over time" section, which the page marks coming
 * next. No metrics are shown; secret-safe copy. All content comes from
 * lib/builds/agent-intelligence-explained.ts, where a test pins the shape.
 */

import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import {
  AGENT_INTEL_HEADLINE,
  AGENT_INTEL_ANALOGY,
  AGENT_INTEL_SECTIONS,
  AGENT_INTEL_CLOSER,
} from "@/lib/builds/agent-intelligence-explained";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/agent-intelligence")!;

export default function AgentIntelligencePage() {
  return (
    <div className="wp-pilot">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Agent Intelligence, in plain language</p>
        <h1>See the agents on your site, and what they are really doing</h1>
        <p className="wp-pilot-sub">{AGENT_INTEL_HEADLINE}</p>
        <p className="wp-pilot-aside">{AGENT_INTEL_ANALOGY}</p>
      </header>

      {AGENT_INTEL_SECTIONS.map((s) => (
        <section key={s.id} className="wp-pilot-section" data-testid={`ai-${s.id}`} aria-label={s.title}>
          <p className="wp-pilot-eyebrow">
            {s.eyebrow}
            {s.roadmap ? (
              <span className="wp-build-banner-stage wp-build-stage--concept" style={{ marginLeft: 8 }} data-testid={`ai-${s.id}-roadmap`}>
                Coming next
              </span>
            ) : null}
          </p>
          <h2>{s.title}</h2>
          {s.body.map((p, i) => (
            <p key={i} className="wp-pilot-aside">{p}</p>
          ))}
          {s.meaning ? (
            <p className="wp-pilot-aside">
              <strong>What this means for you.</strong> {s.meaning}
            </p>
          ) : null}
        </section>
      ))}

      <section className="wp-pilot-section" data-testid="ai-closer">
        <h2>The bigger picture</h2>
        <p className="wp-pilot-aside">{AGENT_INTEL_CLOSER}</p>
      </section>
    </div>
  );
}
