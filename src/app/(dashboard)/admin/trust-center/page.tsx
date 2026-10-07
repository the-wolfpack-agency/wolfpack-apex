"use client";

/**
 * Trust Center - the reviewer-facing security / data / AI-governance surface for
 * OGIAM + Forcefield. It does NOT restate the whole compliance pack; each area is
 * a short, HONEST summary that links to the live evidence it is backed by: the
 * compliance report (/admin/compliance, framework coverage from measured
 * evidence), the public security posture (/security-posture), and the Forcefield
 * docs. One model, so the page never disagrees with the code.
 *
 * Honest by construction: it separates the controls (which we build and prove
 * continuously in CI) from the external audit stamp (the one thing we cannot
 * self-issue). It never presents alignment as certification.
 *
 * Admin-gated: this is what an operator hands a reviewer. Unauthenticated users
 * are redirected, never shown an empty shell.
 */
import { useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getInstinctUser, fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { GlassPanel, SectionHeader, StatusPill } from "@/components/console";

interface TrustSection {
  id: string;
  heading: string;
  summary: string;
  evidence?: { label: string; href: string };
}

const SECTIONS: TrustSection[] = [
  {
    id: "security-posture",
    heading: "Security posture",
    summary:
      "Enterprise-grade security is the floor: a strict Content-Security-Policy and security headers on every route, tenant isolation, a tamper-evident hash-chained audit trail, durable rate limiting, and a crypto registry with a reserved post-quantum slot. Every change is gated in CI by CodeQL dataflow analysis plus a precision security self-scan, so injection, secret leakage, and log-injection classes fail the build.",
    evidence: { label: "Public security posture", href: "/security-posture" },
  },
  {
    id: "data-governance",
    heading: "Data governance and isolation",
    summary:
      "Forcefield records request METADATA and classifications only: path, method, user-agent, header names, coarse country, and a derived agent fingerprint. It does not collect page content, header values, cookies, form data, or visitor identity. Each client is a tenant; the per-tenant ingest token is stored only as a SHA-256 hash, and every client-facing read is scoped to the tenant the token resolves to, backed by a build-failing tenant-scoping guardrail.",
    evidence: { label: "Data-handling doc", href: "/admin/forcefield/docs" },
  },
  {
    id: "ai-governance",
    heading: "AI governance",
    summary:
      "Models advise, policy decides. Forcefield's detection and enforcement core is deterministic (behavioral classification, traps, rules), not a model. The few AI touchpoints run through one governed router that attributes every call to a model version, enforces a per-workspace budget, and records it, so a model never authorizes itself and a change is measured before it ships.",
    evidence: { label: "Compliance report (AI frameworks)", href: "/admin/compliance" },
  },
  {
    id: "subprocessors",
    heading: "Model providers and subprocessors",
    summary:
      "The engine, ingest, and dashboard run on Vercel backed by Neon Postgres. The optional operator AI summary is the only path that reaches a model provider (Azure OpenAI), and only when configured. No advertising or analytics third parties receive customer data, and no MCP servers are used.",
    evidence: { label: "Subprocessors list", href: "/admin/forcefield/docs" },
  },
  {
    id: "self-testing",
    heading: "What we test ourselves, before any paid audit",
    summary:
      "The controls are proven continuously, not asserted. On every change, CI runs CodeQL, a precision security self-scan, security-governance and hygiene gates, a browser platform scan, an accessibility and UX sweep, and the end-to-end reality checks. A production-readiness board grades each surface from real repository facts. The compliance report derives each control's covered / partial / gap status from measured evidence (the audit chain, gate decisions, red-team runs, enforcement posture). The one test we cannot run on ourselves is the independent penetration test and the external certification, by design.",
    evidence: { label: "Live compliance evidence", href: "/admin/compliance" },
  },
  {
    id: "philosophy",
    heading: "Our compliance philosophy",
    summary:
      "We separate the controls from the stamp. The controls (access control, encryption, tenant isolation, a tamper-evident audit trail, incident detection, continuity) we build and verify on every commit, and this page, the evidence pack, and the readiness board all read that one model, so they never disagree with the code. The external audit is an independent third party vouching, with liability, that those controls are real. That independence is the point, which is why it is the one thing we do not self-issue. The aim is to make the substance so complete that the audit is a last-mile stamp on machine-generated evidence, engaged when a client requires it.",
  },
  {
    id: "certifications",
    heading: "Certification status",
    summary:
      "Stated plainly: not currently certified to SOC 2, ISO/IEC 27001, or ISO/IEC 42001. What is real and verifiable today is the engineering and the documented, CI-verified control mappings. The path is align (done), internal audit and management review, then external certification by an accredited body. We never present alignment as certification.",
    evidence: { label: "Framework coverage", href: "/admin/compliance" },
  },
];

export default function TrustCenterPage() {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getInstinctUser<{ role: string }>()) { router.push("/login?next=/admin/trust-center"); return; }
    setReady(true);
    // Reviewer-interest signal (best-effort; never blocks the page).
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "forcefield.trust_center_viewed", metadata: {} }),
    }).catch(() => {});
  }, [router]);

  if (!ready) return null;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto", padding: "1.5rem 1rem 3rem" }} data-testid="trust-center">
      <SectionHeader
        title="Trust Center"
        subtitle="Security, data, and AI governance for OGIAM and Forcefield. Honest summaries, each linked to the live evidence it is backed by."
      />
      <div style={{ marginTop: ".6rem" }}>
        <StatusPill status="aligned" tone="info" label="Aligned, not yet certified" />
      </div>

      <div style={{ marginTop: "1.25rem", display: "flex", flexDirection: "column", gap: "1rem" }}>
        {SECTIONS.map((s) => (
          <GlassPanel key={s.id} testId={`trust-${s.id}`} padded>
            <h2 id={s.id} style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-text)" }}>{s.heading}</h2>
            <p style={{ marginTop: ".5rem", fontSize: ".9rem", lineHeight: 1.6, color: "var(--wp-text-dim)" }}>{s.summary}</p>
            {s.evidence ? (
              <p style={{ marginTop: ".6rem", fontSize: ".82rem" }}>
                <a href={s.evidence.href} data-testid={`trust-${s.id}-evidence`} style={{ color: "var(--wp-gold)" }}>
                  {s.evidence.label} &rarr;
                </a>
              </p>
            ) : null}
          </GlassPanel>
        ))}
      </div>

      <TrustFooter />
    </div>
  );
}

function TrustFooter(): ReactNode {
  return (
    <p style={{ marginTop: "1.5rem", fontSize: ".78rem", color: "var(--wp-text-dim)" }}>
      This is the operator-facing Trust Center. Share its substance with a reviewer; the backing
      evidence (the compliance report and the readiness board) updates from the live system, so it
      is current by construction.
    </p>
  );
}
