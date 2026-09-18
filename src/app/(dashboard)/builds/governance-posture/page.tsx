"use client";

/**
 * /builds/governance-posture - the client-presentable "how governed is your AI"
 * surface. The control lists are read LIVE from the control-ladder registry via
 * postureControls(), so the page can never claim more than is actually enforced.
 * Staged in the builds shell ahead of OGIAM getting its own repo.
 */

import Link from "next/link";
import { CLIENT_BUILDS } from "@/lib/builds/registry";
import BuildBanner from "@/components/BuildBanner";
import {
  POSTURE_HEADLINE,
  POSTURE_INTRO,
  POSTURE_PROOFS,
  POSTURE_CLOSER,
  postureControls,
} from "@/lib/builds/governance-posture";

const build = CLIENT_BUILDS.find((b) => b.href === "/builds/governance-posture")!;

function ControlList({ testId, title, sub, items }: { testId: string; title: string; sub: string; items: { label: string }[] }) {
  if (items.length === 0) return null;
  return (
    <section className="wp-pilot-section" data-testid={testId}>
      <h2>
        {title} <span style={{ color: "var(--wp-text-dim)", fontWeight: 400 }}>({items.length})</span>
      </h2>
      <p className="wp-pilot-aside">{sub}</p>
      <ul className="wp-pilot-list">
        {items.map((c) => (
          <li key={c.label}>{c.label}</li>
        ))}
      </ul>
    </section>
  );
}

export default function GovernancePosturePage() {
  const g = postureControls();
  return (
    <div className="wp-pilot" data-testid="governance-posture">
      <BuildBanner build={build} />

      <header className="wp-pilot-head">
        <p className="wp-pilot-eyebrow">Governance posture</p>
        <h1>How governed is your AI</h1>
        <p className="wp-pilot-sub">{POSTURE_HEADLINE}</p>
        <p className="wp-pilot-aside">{POSTURE_INTRO}</p>
        <p className="wp-pilot-aside" data-testid="posture-tally">
          <strong>{g.enforcedCount}</strong> of {g.totalCount} controls are enforced by the platform today, read from the live control registry.
        </p>
      </header>

      <ControlList
        testId="posture-auto"
        title="Enforced automatically"
        sub="A fixed rule at the door decides. The AI cannot talk its way past these, whatever model is behind it."
        items={g.autoEnforced}
      />
      <ControlList
        testId="posture-approval"
        title="Held for a person"
        sub="The action cannot execute until a human approves it. The AI proposes; a person decides."
        items={g.humanApproval}
      />
      <ControlList
        testId="posture-reviewed"
        title="Human-reviewed"
        sub="Things a rule genuinely cannot check before the fact, reviewed against the tamper-evident record instead of pretended to be a gate."
        items={g.humanReviewed}
      />
      <ControlList
        testId="posture-hardening"
        title="Actively being hardened"
        sub="Deterministic controls in the process of being wired inline. Shown here in the open, because the tally can only improve and the build tracks it."
        items={g.hardening}
      />

      <section className="wp-pilot-section" data-testid="posture-proofs">
        <h2>Why you can trust the list above</h2>
        {POSTURE_PROOFS.map((p) => (
          <div key={p.title} style={{ marginBottom: 12 }} data-testid="posture-proof">
            <p className="wp-pilot-aside"><strong>{p.title}.</strong> {p.body}</p>
          </div>
        ))}
      </section>

      <section className="wp-pilot-section" data-testid="posture-effectiveness">
        <h2>What it has actually done</h2>
        <p className="wp-pilot-aside">
          The list above is what is enforced. For what it has caught and contained for you in real numbers, read from the platform&rsquo;s own records, see the{" "}
          <Link href="/admin/effectiveness">Effectiveness view</Link>.
        </p>
      </section>

      <section className="wp-pilot-section" data-testid="posture-closer">
        <p className="wp-pilot-aside">{POSTURE_CLOSER}</p>
      </section>
    </div>
  );
}
