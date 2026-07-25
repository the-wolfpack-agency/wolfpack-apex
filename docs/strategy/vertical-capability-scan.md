# Vertical capability scan and client-facing packaging

Status: working doc. Maps every live platform capability to five high-priority verticals. Source of truth for what we can offer, what we can demo today, and what defers to post-pilot. Companion one-pagers for each vertical live in `docs/strategy/vertical-one-pagers/`.

Owner: sales and product. Updated: 2026-07-08.

---

## Platform capabilities (live today)

Grouped by surface. Each is demoable with sample or real data.

### Governance and control
- Deterministic policy gate: every AI action is allowed, blocked, escalated, or denied by rule, not by model
- Tamper-evident hash-chained ledger: append-only, every decision signed and replayable
- Fail-closed enforcement: if a decision cannot be recorded, the action does not run
- Policy simulator: replay a candidate rule over real historical decisions before enforcing it
- Escalate to human: any action can route to a named approver
- Monitor by default: gate runs in shadow mode first, graduates to enforcement on operator schedule

### Discovery and inventory
- AI surface inventory scan: finds every LLM SDK call, model-provider endpoint, and AI key in a codebase
- Ungoverned AI flagging: surfaces which connections have no policy coverage
- Workspace-scoped time series: tracks ungoverned surface over time, not just a snapshot

### Continuous assurance
- Continuous red-team: adversarial corpus runs against the live gate every few hours
- OWASP LLM Top 10 coverage: attacks mapped to the known AI attack classes
- Regression alerting: if a policy degrades between runs, the sweep catches it
- Posture grade over time: visible trend, not a single-point-in-time report

### Audit and compliance evidence
- Signed evidence pack: every gate decision is explainable and traceable to the rule that fired
- Framework mapping: SOC2, ISO 42001, NIST AI RMF, EU AI Act coverage views
- Decision-support output: accelerates audit review, does not issue the certificate

### Assistant and knowledge (from Instinct layer)
- Multi-system chat: answers questions across CRM, MS 365, GitHub, internal docs in one surface
- Brain RAG: team-wide knowledge ingestion, vector search, cited answers
- Learning loop: corrections propagate across the workspace; the system gets smarter
- Role-based access: every capability gated by role, per-user overrides available
- Audit log: hash-chained record of security-relevant actions
- Finance module: AP invoice queue, QuickBooks integration, approval workflows
- HR module: employee records, onboarding, payroll view, benefits
- Meeting insights: pre-brief, transcript ingest, action item extraction
- Goals and OKRs: KR tracking, contribution grading, Friday sync commitment loop
- Automations: exception queue, override, resolve, run triggers

### Connectors live today
- Microsoft 365 (mail, calendar, Teams, SharePoint, To-Do)
- Salesforce (OAuth, records, pipeline)
- HubSpot
- GitHub
- QuickBooks
- Plaud (meeting transcripts)

---

## Capability-to-vertical mapping

| Capability | Med spa / aesthetics | Dental DSO | Vet group | Fitness franchise | Auto service |
|---|---|---|---|---|---|
| Policy gate + ledger | high | high | medium | medium | high |
| AI surface inventory | medium | medium | low | low | medium |
| Policy simulator | high | high | medium | low | high |
| Continuous red-team | medium | high | low | low | medium |
| Evidence pack | medium | high | low | low | medium |
| MS 365 connector | high | high | medium | medium | medium |
| CRM connector | high | medium | low | medium | high |
| Finance / AP invoice | high | high | medium | medium | high |
| Meeting insights | medium | medium | low | low | medium |
| Brain RAG | high | high | medium | medium | medium |
| Automations / exceptions | high | high | medium | high | high |
| HR / onboarding | medium | medium | medium | high | medium |

Rating: high = immediate clear value, medium = applicable with light config, low = deferred to post-pilot.

---

## Demo readiness per vertical

| Vertical | Can demo with sample data today | Custom build needed before demo | Notes |
|---|---|---|---|
| Med spa | yes | no | use finance + CRM + gate beats |
| Dental DSO | yes | no | compliance beat is strong here |
| Vet group | yes | no | lighter demo, lead with gate + invoice |
| Fitness franchise | yes | no | lead with automations + exception queue |
| Auto service | yes | no | wolfpack-auto experience is a warm proof point |

---

## What defers to post-pilot

- Custom connector for vertical-specific tools (practice management, shop management, booking platforms)
- Vertical-specific red-team corpus (e.g. HIPAA-flavored attack classes for dental / vet)
- Compliance framework mapping for vertical-specific regulations (HIPAA, state dental board, etc.)
- Custom policy templates per vertical

None of these block the pilot sale. All are scoped into the post-pilot engagement.

---

## Related

- `docs/strategy/vertical-one-pagers/` - client-facing one-pagers per vertical
- `docs/pitch/demo-script.md` - canonical five-beat demo
- `docs/pitch/messaging-and-category.md` - canonical positioning language
- `docs/ogiam-pricing-and-packaging.md` - pricing tiers
- `docs/ogiam-onboarding-runbook.md` - how to onboard a client
