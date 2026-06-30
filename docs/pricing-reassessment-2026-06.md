# Pricing reassessment (2026-06)

A re-anchor of the pricing framework now that the product is materially more
complete than when the original $60k Year-1 reference was set. This updates the
anchors and the expansion motion; it does not replace
[pricing-framework.md](pitch/pricing-framework.md), it sharpens it. Numbers are
anchors for a discovery-led conversation, not a rate card. No em dashes, no
competitor names.

---

## What changed since the last pricing pass

Five capabilities moved from "roadmap" to "live and walkable," and each one
changes what we can credibly charge for:

1. **Signed, forwardable compliance evidence export.** The Comply beat now emits a
   cryptographically signed artifact an auditor can verify independently. This is
   the single biggest pricing lever: it turns the Best tier's "audit-support
   evidence pack" from a promise into a deliverable, and it is exactly what a
   buyer forwards inside their org to justify the spend.
2. **Continuous red-team with a measured pass rate.** Assurance is now a number
   that trends, not a claim. That is a recurring-value story, which supports an
   annual program price rather than a one-time fee.
3. **Drift trends and regression alerting.** Governance is now operational between
   reviews. This is the renewal story made concrete: the line goes down and stays
   down, and an alert fires when it does not.
4. **Live repo scan.** The free wedge is now frictionless and demo-able in the
   room, which raises top-of-funnel conversion and shortens time-to-first-value.
5. **Admin MFA (opt-in) and the deterministic gate plus tamper-evident ledger**
   maturing together strengthen the security-review answer that unblocks larger
   deals.

The net: the value we anchor against is higher and more provable, so we hold the
anchor firm and raise the ceiling.

---

## Re-anchored tiers

Same three-tier shape (Establish / Govern / Assure). Lead with Govern, let Assure
pull the anchor up. Illustrative Year-1 program ranges for a first deployment:

| Tier | Prior posture | Re-anchored Year-1 (illustrative) | What justifies the move |
|---|---|---|---|
| **Good (Establish)** | entry footprint | low five figures (~15k to 25k) | Scan, AI surface inventory, gate in monitor, ledger. Unchanged in scope; price holds. |
| **Better (Govern)** | ~$60k reference | hold ~$50k to $75k | Now includes enforce-on-your-schedule, policy simulator, continuous red-team, multi-framework coverage view, drift trends. More provable value at the same anchor. |
| **Best (Assure)** | aspirational | ~$90k to $150k+ | The signed audit evidence pack is real, plus expanded red-team corpus, multi-team enforce, and alerting. This is the regulated / high-exposure tier and it now has the artifact to back the price. |

Rationale for holding Better rather than cutting: the original anchor was set
against a thinner product. The same number now buys a demonstrably more complete
program, so the price-to-value ratio improved in the buyer's favor without
dropping the number. Discounting now would leave money on the table and signal the
anchor was soft.

---

## The expansion motion (new)

The product now has natural, honest expansion levers beyond the base program, so
the account grows after Year 1 instead of just renewing flat:

- **Per additional target or codebase.** Each new system onboarded for scanning
  and governance is a clean unit of expansion.
- **Per additional framework.** A buyer who starts with SOC 2 and later needs EU
  AI Act coverage is an upsell the Comply engine already supports.
- **Graduating capabilities from monitor to enforce** across more teams is a
  services-led expansion (the simulator de-risks it, which is the reason to do it
  with us).
- **The signed evidence export at audit time** is a recurring, time-boxed value
  moment to attach a renewal or an uplift to.

Renewal framing: the drift trend chart is the renewal conversation. If the
ungoverned gap closed and the red-team pass rate held, the program did its job and
the renewal defends itself.

---

## What still gates moving upmarket (price honestly)

Do not price or promise a tier we cannot yet deliver. Three deferred items cap how
high we can sell today, and each one unlocks a higher ceiling when it ships (see
[deferred-track.md](security/deferred-track.md)):

- **SSO (SAML / OIDC).** Required to sell into larger security-reviewed accounts.
  Until it ships, the top of the Best range is the realistic ceiling.
- **Full database-layer tenant isolation.** Needed before a multi-tenant
  enterprise claim. Today we run a single primary tenant; price and message
  accordingly.
- **SOC 2 certification.** We generate the evidence but are not certified. Never
  let the price imply a certification we do not hold; the honest line is "building
  the evidence with the same engine we sell, here is the roadmap."

When these land, the Best tier ceiling rises and a true enterprise tier becomes
sellable. Until then, holding Better firm and selling Assure on the strength of the
signed evidence export is the right posture.

---

## One-line summary for the team

The product got more provable, not just bigger: hold the Govern anchor, raise the
Assure ceiling on the back of the signed audit evidence, and grow the account with
per-target and per-framework expansion. Price what is live, name what is not.
