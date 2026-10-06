# Forcefield Pricing and Packaging (DRAFT, internal, confidential)

Status: DRAFT. Numbers are placeholders marked `[DECISION]` to validate against
real cost/margin before anything is committed or published. Do NOT put prices on
ogiam.com until this is finalized. No em dashes.

## 1. What we sell

A per-site subscription to the Forcefield agent-defense service: the client wires
one thin edge shim (Cloudflare Worker or Next.js middleware) and every request is
classified, recorded, and optionally enforced by the central engine, with a live
dashboard scoped to their site.

## 2. Model: flat per-site tiers (not usage/overage)

We price per protected site, as fixed monthly tiers. We deliberately do NOT bill
on request volume. Rationale (engineering + security + client):

- **Security alignment.** Forcefield defends against bot floods and fails open. A
  usage/overage bill would spike precisely when a site is under attack, i.e. bill
  the client for the attacker's volume, which they do not control. A defense
  product must never do that.
- **No billing-meter liability.** Usage billing needs idempotent, reconcilable,
  dispute-defensible counts and forces the unfair question of whether to bill for
  blocked hostile traffic. We keep analytics counts, not a billing meter. Flat
  tiers need one tier flag per tenant.
- **Predictability for the buyer.** A security line item that cannot spike is easy
  to budget and clears procurement faster.
- **Launch velocity + reversibility.** Flat is a fixed-price subscription plus an
  enum. We can add a usage-priced enterprise tier later; walking back overage
  billing after launch is the painful direction.

Allowances are a **fair-use soft cap**: at the cap we notify and start an upgrade
conversation; we do not drop the client's legitimate traffic and we do not
auto-bill overage. Abuse of the soft cap (not organic growth) is handled under the
Acceptable Use Policy, not the invoice.

## 3. Tiers (good / better / best)

Lead with Growth; let Scale anchor up and Starter catch the budget-constrained.
All tiers include: the edge shim (both adapters), classification + recording, the
client dashboard, watch mode, and enforce mode (client-controlled).

| Tier | Price `[DECISION]` | Sites | Fair-use requests/mo `[DECISION]` | Added capability |
|---|---|---|---|---|
| Starter | `$[DECISION]/site/mo` | 1 | e.g. 1M | Dashboard, watch + enforce, email alerts |
| Growth | `$[DECISION]/site/mo` | up to N | e.g. 10M | Multi-site, API access, priority alerts, 90-day history |
| Scale | `$[DECISION]/site/mo` or annual | many | e.g. 100M+ | SSO, SLA (see sla.md), named support, longer retention |
| Enterprise | custom | portfolio | custom | Custom retention, dedicated review, optional usage pricing |

Annual commitment: `[DECISION]` (e.g. two months free vs monthly). Nonprofit /
early-design-partner discount: `[DECISION]`.

## 4. What is explicitly NOT metered or billed

- Hostile traffic the engine blocks or traps (you are never billed for an attack).
- Requests during an active incident you have reported.
- The free public aggregate panel on ogiam.com (marketing, not a customer meter).

## 5. Add-ons (optional, priced separately)

- **Operator AI triage summary** (the model-router feature): include in Scale+,
  or a small add-on, since it carries real model cost. Gate behind the per-
  workspace AI budget already in the router. `[DECISION]` on inclusion vs add-on.
- **Managed onboarding / white-glove edge wiring**: a one-time services fee for
  clients who want us to deploy the shim. Aligns with the house services motion.

## 6. Competitive anchors (positioning, not matching)

| Category | Typical price | Note |
|---|---|---|
| WAF / bot management (enterprise) | $thousands/mo + usage | Heavy, usage-metered, infra-coupled |
| CDN bot add-ons | per-request / per-1M | The usage model we deliberately avoid |
| Niche bot-defense SaaS | $50 to $500+/site/mo | Where flat-per-site sits |

Position: predictable per-site defense that never bills you for being attacked,
live visibility of exactly which agents hit you, and fail-open so it never breaks
your site. That triplet is the wedge.

## 7. Open decisions before publish

- All `[DECISION]` numbers, validated against Vercel/Neon/Azure cost per site.
- Whether the AI summary is bundled (Scale+) or a line-item add-on.
- Annual vs monthly framing and the discount.
- The fair-use cap numbers per tier (set generous; they are a conversation
  trigger, not a billing lever).
