# Forcefield Pricing and Packaging (DRAFT, internal, confidential)

Status: DRAFT. Section 3 now carries RECOMMENDED numbers (anchored to the Oct 2026
competitive research in section 6); validate them against real cost/margin and 2 to
3 live conversations before committing. The remaining `[DECISION]` markers are
genuine open choices. Numbers are proposals to validate against
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

## 3. Tiers (recommended numbers, validate in discovery)

Numbers below are a RECOMMENDED starting rate card, anchored to the competitive
landscape in section 6, not a committed price list. Lead with Growth; let Scale
anchor up and Free/Starter catch the top of the funnel. All paid tiers include: the
edge shim (both adapters), classification + recording, the client dashboard, watch
mode, and enforce mode (client-controlled).

| Tier | Recommended price | Sites | Fair-use requests/mo | Added capability |
|---|---|---|---|---|
| Free (watch-only) | $0 | 1 | ~250k | See what is hitting your site: dashboard + watch mode, 7-day history. The funnel wedge; no enforce. |
| Starter | $49/site/mo | 1 | ~1M | Watch + enforce, 30-day history, email alerts |
| Growth | $199/site/mo | up to 5 | ~10M | Multi-site, API access, priority alerts, 90-day history |
| Scale | $749/site/mo (or annual) | many | ~100M | SSO, SLA (see sla.md), named support, longer retention |
| Enterprise | custom | portfolio | custom | Custom retention, dedicated review, BYO/on-prem, optional usage pricing |

Recommended annual commitment: two months free (about 17 percent) on an annual
term. Early design partners: free or 50 percent for the first 5 to 10, in exchange
for a logo/case study and to grow the shared-threat-intel corpus.

Why these numbers (the logic, so they are easy to adjust):
- Priced to sit ABOVE the toy tier (real behavioral defense + AI-agent awareness,
  not a $20 checkbox) and FAR BELOW enterprise bot management (5x to 50x cheaper
  than DataDome / Cloudflare Bot Management; see section 6), with PREDICTABLE
  per-site pricing as the wedge.
- The Free watch-only tier is the acquisition engine (the "free scan" of this
  product): it costs us little, creates the alarm + the number, and every site it
  protects strengthens the shared threat intelligence.
- Starter $49 lands a single site at the price of a developer tool but with managed
  defense. Growth $199 is the volume tier (multi-site, the expected median deal).
  Scale $749 captures larger sites while still a fraction of a DataDome contract.

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

## 6. Competitive anchors (researched Oct 2026; positioning, not matching)

| Competitor | Published price | Model | Where we sit |
|---|---|---|---|
| DataDome | $3,830/mo (Essentials) up to $13,270/mo (Enterprise Plus) | Usage-based, quote on top | We are 5x to 50x cheaper and predictable |
| Cloudflare Bot Management | ~$250 to $500/mo as a Business add-on; Enterprise contracts ~$5,000/mo, bundled | Bundled into a Cloudflare contract, quote-only at Enterprise | We are standalone, self-serve, not infra-locked |
| HUMAN, Kasada, Imperva, Akamai | Quote-only | Premium enterprise, traffic + endpoint driven | We serve the segment they price out |
| AWS WAF Bot Control | ~$10/mo + ~$1 per 1M requests | Pure usage | Cheap but basic + usage-metered (bills more under attack) |
| Arcjet and developer tools | Free tier then ~$49+/mo | Usage-based, developer-centric | Similar entry price, but we are managed + AI-agent-aware |

The gap we fill: between the cheap-but-basic usage-metered developer tools and the
$4k-to-$13k/mo enterprise suites, there is no predictable, self-serve, AI-agent-aware
defense. Our wedge is the triplet: predictable per-site pricing that NEVER bills you
for being attacked, live visibility of exactly which agents hit you (good and bad),
and fail-open so it never breaks your site. Watch-first makes it safe to turn on day
one, which the enterprise suites cannot claim.

Sources: DataDome pricing (Capterra/G2, 2026), Cloudflare Bot Management pricing
(Prosopo comparison + Cloudflare plan tiers, 2026), AWS WAF Bot Control (AWS
pricing), Arcjet (vendor site). Enterprise vendors are largely quote-only; the
figures above are published list prices and are negotiated in practice.

## 7. Open decisions before publish

- All `[DECISION]` numbers, validated against Vercel/Neon/Azure cost per site.
- Whether the AI summary is bundled (Scale+) or a line-item add-on.
- Annual vs monthly framing and the discount.
- The fair-use cap numbers per tier (set generous; they are a conversation
  trigger, not a billing lever).
