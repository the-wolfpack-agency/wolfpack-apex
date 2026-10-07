# Model Router + Model Fitness (DRAFT, internal, strategy)

## What it is
One chokepoint every model call goes through (cost attribution, budget, region
policy, version pinning, failover), plus Model Fitness: plug in any model and we
tell you where it breaks on YOUR workflows, from real labeled outcomes, not a
generic benchmark. Model Router is already a named product in `src/lib/products.ts`.

## Who buys it
Teams running LLM features who need cost control + provider portability + evidence
that a model change is safe; and buyers evaluating models who want a fitness read
on their own tasks ("R&D as a service").

## What we ALREADY have
- `src/lib/ai/router.ts` + `src/lib/ai/models/router.ts` - the router: provider
  registry, tiering, cost estimate, budget refusal (402), residency, escalation,
  degrade reporting, `getAIClient().complete()` as the one seam every feature uses
  (Forcefield's signup summary already dogfoods it).
- `src/app/api/admin/ai-code/fitness` + `/admin/ai-code/fitness` - a fitness surface.
- The gate labels / verdict data that a limitation profile is derived from
  (confirm current coverage in `src/lib/ai-redteam` + gate decision stores).

## Product surface to add
- A customer-facing fitness report: run a model against the customer's own task
  set + gate, produce a per-model limitation profile (where it fails, by class).
- BYO-model onboarding (plug a customer's Foundry/Azure/Anthropic key into the same
  router + gate, governance identical).
- Spend/limitation dashboards per workspace.

## Honest gap to market
The router is solid and dogfooded. Model Fitness needs the limitation-profile
telemetry finished into a customer-facing report, and the BYO-model onboarding
flow. Confirm how complete the limitation-profile capture is before pitching it as
turnkey. ~60%.

## Positioning + pricing hook
"Swap any model without swapping your governance, and know where each one breaks on
your work before it ships." Priced per workspace + usage, with a paid fitness
assessment as the wedge.
