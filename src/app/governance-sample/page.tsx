/**
 * /governance-sample. Public page (no auth, no data fetch, no client fetch).
 *
 * A sanitized, illustrative example of the governance + compliance summary a
 * prospect receives from a real shadow-AI scan. Safe to send as a URL: every
 * value below is fictional, hard-coded static content. There is zero data flow
 * and zero security surface here by design (no user input, no fetch, no auth).
 *
 * Public the same way /security-posture is: it lives outside the (dashboard)
 * route group, so no auth guard applies. Matches that page's container styling
 * (light surface, max-w-4xl). See docs/pitch/messaging-and-category.md for the
 * Gate / Ledger / Evidence language and the honesty guardrails this page obeys.
 *
 * "Acme" is a fictional example; no real client name appears (client-context
 * guardrail: generic examples only). Decision-support evidence, NOT a
 * certification and NOT legal advice.
 */

type Decision = "allow" | "redact" | "escalate" | "deny";

const SURFACES_DISCOVERED = 14;
const SURFACES_UNGOVERNED = 9;

const GATE_DECISIONS: ReadonlyArray<{
  action: string;
  decision: Decision;
  rule: string;
}> = [
  {
    action: "Summarize the customer support inbox for the weekly report",
    decision: "allow",
    rule: "read.support_inbox within owner scope",
  },
  {
    action: "Draft a reply that quotes a customer's full payment details",
    decision: "redact",
    rule: "pii.payment_data must be masked before egress",
  },
  {
    action: "Issue a refund of $4,200 to a flagged account",
    decision: "escalate",
    rule: "finance.refund over threshold routes to a human approver",
  },
  {
    action: "Delete the production analytics table to free up space",
    decision: "deny",
    rule: "data.destructive_action is never permitted to an agent",
  },
];

const DECISION_STYLES: Record<Decision, { label: string; className: string }> = {
  allow: { label: "Allow", className: "bg-green-100 text-green-800" },
  redact: { label: "Redact", className: "bg-amber-100 text-amber-800" },
  escalate: { label: "Escalate", className: "bg-blue-100 text-blue-800" },
  deny: { label: "Deny", className: "bg-red-100 text-red-800" },
};

const RED_TEAM = {
  passRate: 97,
  scenariosRun: 312,
  scenariosPassed: 303,
  lastRun: "ran continuously; most recent pass 3 hours ago",
};

const COMPLIANCE_COVERAGE: ReadonlyArray<{
  framework: string;
  beat: string;
  coverage: string;
}> = [
  {
    framework: "SOC 2 (logging and monitoring)",
    beat: "Ledger",
    coverage: "Evidence available from live decisions",
  },
  {
    framework: "ISO 42001 (AI management system)",
    beat: "Gate plus Ledger",
    coverage: "Partial; enforce mode pending on 3 surfaces",
  },
  {
    framework: "NIST AI RMF (measure and manage)",
    beat: "Assure (continuous red-team)",
    coverage: "Evidence available from dated test runs",
  },
  {
    framework: "EU AI Act (record-keeping and human oversight)",
    beat: "Ledger plus Gate (escalate)",
    coverage: "Partial; human-oversight routing in monitor mode",
  },
];

export default function GovernanceSamplePage() {
  return (
    <main className="max-w-4xl mx-auto px-4 py-10 text-gray-900" data-testid="governance-sample">
      <p
        className="rounded border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        data-testid="sample-disclaimer"
        role="note"
      >
        <strong>Illustrative sample.</strong> Every figure below is fictional and
        hard-coded for a made-up company, &ldquo;Acme.&rdquo; This is an example of
        the governance and compliance summary a real shadow-AI scan produces. It is
        decision-support evidence, not a certification and not legal advice. Request
        a real free scan to see your own AI surface.
      </p>

      <header className="mt-8">
        <h1 className="text-3xl font-bold">Governance summary, sample</h1>
        <p className="mt-2 text-gray-600">
          Example output for Acme. The authorization gate and system of record for
          AI actions: the AI proposes, a deterministic policy decides, and every
          decision is written to a tamper-evident record.
        </p>
      </header>

      <section className="mt-8" data-testid="surfaces-section">
        <h2 className="text-xl font-bold border-b pb-1">AI surfaces discovered</h2>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded border border-gray-200 p-4">
            <div className="text-3xl font-bold" data-testid="surfaces-discovered">
              {SURFACES_DISCOVERED}
            </div>
            <div className="text-sm text-gray-600">AI surfaces discovered</div>
          </div>
          <div className="rounded border border-gray-200 p-4">
            <div className="text-3xl font-bold text-red-700" data-testid="surfaces-ungoverned">
              {SURFACES_UNGOVERNED}
            </div>
            <div className="text-sm text-gray-600">ungoverned (no gate in front of them)</div>
          </div>
        </div>
        <p className="mt-3 text-sm text-gray-600">
          A read-only scan inventories where AI is already running, including the
          surfaces nobody is governing yet. The scan looks; it never changes
          anything.
        </p>
      </section>

      <section className="mt-10" data-testid="decisions-section">
        <h2 className="text-xl font-bold border-b pb-1">Example gate decisions</h2>
        <p className="mt-2 text-sm text-gray-600">
          A deterministic policy, not another model, decides. The rule that fired is
          always named.
        </p>
        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left">
              <th className="border-b border-gray-300 py-2 pr-3">Proposed AI action</th>
              <th className="border-b border-gray-300 py-2 pr-3">Decision</th>
              <th className="border-b border-gray-300 py-2">Rule that fired</th>
            </tr>
          </thead>
          <tbody>
            {GATE_DECISIONS.map((d) => {
              const style = DECISION_STYLES[d.decision];
              return (
                <tr key={d.action} data-testid={`decision-${d.decision}`}>
                  <td className="border-b border-gray-100 py-2 pr-3 align-top">{d.action}</td>
                  <td className="border-b border-gray-100 py-2 pr-3 align-top">
                    <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${style.className}`}>
                      {style.label}
                    </span>
                  </td>
                  <td className="border-b border-gray-100 py-2 align-top text-gray-700">
                    <code className="text-xs">{d.rule}</code>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="mt-10" data-testid="redteam-section">
        <h2 className="text-xl font-bold border-b pb-1">Red-team assurance</h2>
        <div className="mt-4 flex flex-wrap items-baseline gap-x-3">
          <span className="text-3xl font-bold" data-testid="redteam-pass-rate">
            {RED_TEAM.passRate}%
          </span>
          <span className="text-sm text-gray-600">
            pass rate ({RED_TEAM.scenariosPassed} of {RED_TEAM.scenariosRun} adversarial scenarios)
          </span>
        </div>
        <p className="mt-2 text-sm text-gray-600">
          We attack the gate on a schedule against a known adversarial corpus and
          record dated results. This is assurance the gate holds, not a guarantee.
          Last run: {RED_TEAM.lastRun}.
        </p>
      </section>

      <section className="mt-10" data-testid="compliance-section">
        <h2 className="text-xl font-bold border-b pb-1">Compliance coverage</h2>
        <p className="mt-2 text-sm text-gray-600">
          Coverage is derived from live controls, not assembled in a binder. This is
          decision-support evidence that accelerates an audit; it is not a
          certification.
        </p>
        <table className="mt-4 w-full border-collapse text-sm">
          <thead>
            <tr className="text-left">
              <th className="border-b border-gray-300 py-2 pr-3">Framework</th>
              <th className="border-b border-gray-300 py-2 pr-3">Product beat</th>
              <th className="border-b border-gray-300 py-2">Coverage status</th>
            </tr>
          </thead>
          <tbody>
            {COMPLIANCE_COVERAGE.map((row) => (
              <tr key={row.framework} data-testid="compliance-row">
                <td className="border-b border-gray-100 py-2 pr-3 align-top">{row.framework}</td>
                <td className="border-b border-gray-100 py-2 pr-3 align-top text-gray-700">{row.beat}</td>
                <td className="border-b border-gray-100 py-2 align-top text-gray-700">{row.coverage}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="mt-10 rounded border border-gray-200 bg-gray-50 p-6" data-testid="cta-section">
        <h2 className="text-xl font-bold">See your own AI surface</h2>
        <p className="mt-2 text-gray-700">
          This is a sample for a fictional company. A real scan is free, read-only,
          and shows your actual AI surfaces, your ungoverned count, and any leaked
          keys, usually in a few minutes.
        </p>
        <p className="mt-4">
          <a
            href="mailto:hello@wolfpack.agency?subject=Request%20a%20free%20shadow-AI%20scan"
            className="inline-block rounded bg-gray-900 px-5 py-2.5 font-semibold text-white"
            data-testid="cta-request-scan"
          >
            Request a free scan
          </a>
        </p>
      </section>

      <footer className="mt-12 border-t pt-4 text-xs text-gray-500">
        Illustrative sample for a fictional company. Decision-support evidence, not
        a certification and not legal advice.
      </footer>
    </main>
  );
}
