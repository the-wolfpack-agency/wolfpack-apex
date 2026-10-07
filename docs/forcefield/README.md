# Forcefield go-to-market document set (DRAFT, internal, confidential)

Status: DRAFT for review. Do NOT publish any of these to the website or send to a
prospect until the owner confirms the commercial terms and legal counsel reviews
the legal docs. Numbers are ranges/placeholders to validate, marked `[DECISION]`.
No em dashes anywhere in this set. Pairs with the house framework in
`docs/pitch/pricing-framework.md` (value-based anchoring) and
`docs/ogiam-pricing-and-packaging.md` (the sibling QA/security offering).

Forcefield is the self-serve, runtime bot/agent-defense product: one portable
edge shim forwards request signals to the central engine, which classifies,
records, and returns an enforcement decision. It is sold per protected site.

## Launch posture (read this first)

Forcefield's detection + enforcement core is **deterministic, not probabilistic**,
so the AI-governance checkpoints (ISO 42001 / NIST AI RMF / EU AI Act) do NOT gate
the core product; only the two optional AI touchpoints do, and they are gateable.
The deterministic product can ship to first-party sites and design-partner betas
now, on the general SaaS controls we already prove in CI. See `launch-readiness.md`
for the full scope and the self-run test evidence (`npm run forcefield:selftest`).

## The document set and its status

| Doc | Purpose | Status | Needs |
|---|---|---|---|
| `pricing-and-packaging.md` | Tiers, allowances, what is and is not billed | DRAFT | Your `[DECISION]` on the numbers |
| `licensing.md` | The subscription license grant, term, restrictions | DRAFT | Your confirm; counsel review of the grant |
| `sla.md` | Uptime, fail-open guarantee, support response targets | DRAFT | Your `[COMMIT]` on the targets |
| `security-and-data-handling.md` | Exactly what Forcefield collects, where, how long | DRAFT (fact-checked vs code) | Your review |
| `subprocessors.md` | Third parties that process data, for the DPA | DRAFT (fact-checked vs stack) | Your review |
| `legal/terms-of-service.md` | Customer contract | DRAFT TEMPLATE | Legal counsel before any use |
| `legal/privacy-policy.md` | Public privacy notice | DRAFT TEMPLATE | Legal counsel before any use |
| `legal/dpa.md` | Data Processing Addendum (processor terms) | DRAFT TEMPLATE | Legal counsel before any use |
| `legal/acceptable-use-policy.md` | What a customer may not do with it | DRAFT TEMPLATE | Legal counsel before any use |

## Required-docs checklist for a self-serve security SaaS launch

What a launch genuinely needs, and where each stands:

- [x] Pricing and packaging (this set, DRAFT)
- [x] Licensing / subscription terms (this set, DRAFT)
- [x] SLA (this set, DRAFT targets)
- [x] Security and data-handling statement (this set, fact-checked)
- [x] Subprocessors list (this set, fact-checked)
- [x] Terms of Service (DRAFT template, needs counsel)
- [x] Privacy Policy (DRAFT template, needs counsel)
- [x] Data Processing Addendum (DRAFT template, needs counsel)
- [x] Acceptable Use Policy (DRAFT template, needs counsel)
- [ ] Onboarding / quickstart: SHIPPED in-product (the provision + signup flows
      return a ready-to-paste quickstart); no separate doc needed.
- [ ] Support policy: covered inside `sla.md`; promote to its own page if support
      becomes a paid tier differentiator.
- [ ] Refund / cancellation policy: DECISION needed once billing (Stripe) lands;
      stub is in `licensing.md`.
- [ ] Status page / incident comms: operational, not a doc. Needs a public status
      endpoint before the SLA is credible (tracked, not built).

## Decisions owned by you (business), not draftable by me

- The actual price numbers in every tier (`[DECISION]` markers in pricing).
- The committed SLA targets (`[COMMIT]` markers in the SLA).
- Contract term and auto-renewal posture.
- Refund / cancellation terms.

## Decisions owned by counsel (legal), not draftable by me

- Final ToS, Privacy Policy, DPA, AUP language and enforceability.
- Governing law / jurisdiction, liability caps, indemnities, warranty disclaimers.
- Whether the DPA satisfies the specific regimes your customers fall under
  (GDPR/UK GDPR/CCPA). The templates flag where these choices go.
