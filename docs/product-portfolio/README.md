# Wolfpack / OGIAM product portfolio (DRAFT, internal, strategy)

Status: DRAFT, internal brainstorm. One honest map of the pieces we have ALREADY
built that look ready or near-ready to market, each with its real code pointers,
the product surface to add, and the honest gap to market. Not a commitment, a
starting point to react to. No em dashes.

## The shared thesis (why these hang together)

Every one of these rides the same honest story we proved with Forcefield:
**we build and continuously self-verify the substance; the external stamp is the
one thing we do not self-issue.** The controls, scans, readiness, and evidence are
derived from the live system on every change, so what we show a buyer cannot
disagree with the code. That is the differentiator against questionnaire-driven
competitors.

## The map (newest honesty-graded view)

| Product | What it is | Core already built | Readiness to market |
|---|---|---|---|
| Compliance & Assurance | Continuous, evidence-derived audit readiness + trust center | compliance engine + readiness board + trust center + evidence export | ~70%, strongest net-new line |
| AgenticQA (security assurance) | Continuous security scanning + a self-run pen test | platform-scan + pentest engine + static scanners + CodeQL gate | ~75%, already a named product |
| Model Router + Model Fitness | One chokepoint for any model + "where does this model break on YOUR work" | ai/router + models/router + fitness surface | ~60%, novel, telemetry needs finishing |
| Secure Agent / AgentGate | Deterministic governance of AI-generated code (PR gate) | ai-code gate/judge/repair + webhook PR gating | ~65%, needs the GitHub App live |
| Trust-Center kit | A reviewer-facing trust center + evidence pack, white-labelable | trust-center + evidence pages (ford + apex) | ~65%, reusable component |

Forcefield (the runtime agent-defense product) is tracked in `docs/forcefield/`
and is the furthest along; it is the template the rest follow.

## How to read each one-pager

What it is / who buys it / the pieces we ALREADY have (with pointers) / the product
surface to add / the honest gap to market / a positioning + pricing hook. Where a
claim needs confirming against the live system, it says so.

## Decisions for you

- Which one or two to pursue next (I would lead with Compliance & Assurance: biggest
  market, ~70% built, same honest story as Forcefield).
- Whether any of these fold together (Compliance & Assurance naturally absorbs the
  Readiness board and the Trust-Center kit).
- Naming + which get a public product page (several are already in
  `src/lib/products.ts`: Model Router, AgenticQA, Secure Agent, Forcefield, OGIAM IAM).
