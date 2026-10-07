# Forcefield adversarial verification (prove we block what we profile)

Internal. How we verify, with our OWN agents, that Forcefield actually blocks the
hostile agents it profiles, and never blocks a real visitor. Three layers, one
shared corpus, so the proof cannot drift. No em dashes.

## The shared corpus

`src/lib/forcefield-web/adversarial-corpus.ts` is a growing set of request profiles
that model how real agents behave: honeytoken trips, named attack tools (sqlmap,
Nikto, Nuclei, masscan, ffuf, Acunetix, ...), injection payloads (path traversal,
SQLi, XSS, command injection, XXE), and the benign controls (real browsers, good
bots, valid API clients, a bare recon probe). Every layer below runs THIS corpus,
so what CI proves and what we run live are the same thing.

## Layer 1: engine proof (CI-gating, runs now)

`adversarial-corpus.test.ts` runs the real `decideEnforcement` engine over the
corpus and asserts: 100% of hostile profiles are blocked, ZERO benign/good-bot
false positives, and recon is report-only. This gates every change: a regression
that stops blocking a profiled attacker, or starts blocking a real visitor, fails
the build. (A false positive is treated as the worst outcome.)

## Layer 2: live red-team (the real end-to-end block)

`npm run forcefield:redteam` (scripts/forcefield-redteam.ts) sends the SAME corpus
at a DEPLOYED target with the shim in enforce mode and asserts the real HTTP
outcome (403/blocked for hostile, served for benign). This is the "prove a real
live block on a real site" proof.

FIRST-PARTY ONLY: it sends hostile-looking requests, so it must point only at a
site WE own and stand up for the test. It refuses to run without an explicit
`FORCEFIELD_REDTEAM_TARGET`. Read-only GETs; it never sends a real exploit body,
only the request shape the deterministic engine keys on.

Remaining step to run layer 2: stand up a first-party test site with the Forcefield
shim in enforce mode, point the script at it, and capture the result. That is the
one claim the whole pitch rests on; do not market "we block attacks" until this is
green on a real deployment.

## Layer 3: AI red-team loop (AI in the factory, not the product)

`npm run forcefield:ai-redteam` (scripts/forcefield-ai-redteam.ts) is where our own
AI earns its keep WITHOUT entering the product. Offline, in the factory, it attacks
our own deterministic engine: each round the model invents novel, obfuscated, and
encoding-trick attack variants (plus benign lookalikes), the real `decideEnforcement`
judges them, and the run is scored with the SAME `scoreGap` that CI uses.

- A SLIP (a hostile case the engine did not block) is an open gap: write a rule,
  confirm the engine blocks it, then move the case into `ai-redteam-corpus.ts`,
  where it becomes a permanent regression. A gap, once closed, stays closed.
- A FALSE POSITIVE (a benign lookalike that got blocked) is the opposite gap: a
  rule is too broad. Same loop, opposite fix.
- Loop-until-dry: it keeps generating until two rounds in a row find no new gap.

It scales with the news. Pass a threat brief (a pasted disclosure, a CVE, a file of
recent tradecraft) via `FORCEFIELD_REDTEAM_BRIEF` / `FORCEFIELD_REDTEAM_BRIEF_FILE`
and the generator steers toward it, so a novel attack in the morning's feed becomes
a test case the same day.

Boundary: this script is the ONLY part of Forcefield that calls a model, it runs
offline through the governed model router, and its output is static data a human
reviews and commits. CI and the runtime never call a model (enforced by
`ai-decision-path-boundary.test.ts`). AI finds the edges of the cage; the
deterministic engine is the cage.

## The gap metric (idea into a provable claim)

`src/lib/forcefield-web/gap-metric.ts` computes ONE number, one way: of the
proven-hostile population, what fraction did the deterministic gate prevent, and
what slipped. `scoreGap` is pure arithmetic; `runGapCases` runs the real engine.
Both the offline red-team and (later) a live-traffic reader feed the same scorer,
so the factory number and the production number are the same measurement.

This is what turns "deterministic tooling closes the gap" from a slogan into a
defensible claim: "the gate prevented 94% of hostile actions in this envelope,
auditably, and the slips became rules within N days." The slip rate falling to
zero across red-team rounds is the hardening, measured.

## Multi-step campaigns (the hard, novel class)

Everything above judges ONE request. A capable agent attacks the opposite way:
every single request looks benign and the hostility lives in the SEQUENCE. It
recons the surface, chains a scraped id into an object it should not reach, walks
the id space, then exfiltrates. No single step trips a signature, so the per-request
gate is blind to it. This is the genuinely hard class, and we do not pretend the
per-request engine catches it.

`src/lib/forcefield-web/campaign.ts` is the multi-step layer: `detectCampaign` holds
one operator's recent step history (keyed on the fingerprint observe.ts already
stamps) and matches kill-chain SHAPES deterministically:

- `recon_breadth`: enumerated many distinct sensitive/decoy paths in one window.
- `kill_chain`: a sensitive/decoy access THEN a bulk-export, in that order.
- `id_enumeration`: walked many distinct ids on one endpoint (IDOR / object-id sweep).

It is pure and deterministic (same steps -> same verdict), and conservative: a
signature needs a real shape, never a single ambiguous request, so normal browsing
never trips it (tested as the worst outcome). It runs first over RECORDED events to
find campaigns in the wild, then wires to the live path.

The AI red-team already attacks it: `scripts/forcefield-ai-redteam.ts` has a
campaign phase (on by default; `FORCEFIELD_REDTEAM_CAMPAIGNS=off` to skip) that
generates multi-step campaigns, scores them against the real `detectCampaign` with
the SAME gap scorer, and reports campaign slips, the shapes we do not yet detect.
Each slip becomes a new signature in `campaign.ts`; the committed regression lives
in `campaign-redteam.ts` so a caught shape stays caught and a benign session stays
clear.

## Productization: adversarial agents + compliance

The same loop, pointed at a CUSTOMER's own system (first-party, read-only request
shapes, never a real exploit body), is a continuous adversarial-assurance product:
an AI attacker that runs against their site on a schedule and reports the gap it
could and could not get through. The gap-metric output is built to be
compliance-grade: deterministic, reproducible, timestamped, auditable, which is
evidence for vulnerability-management and pentest controls.

Honest boundary, do not overclaim: this produces continuous evidence and coverage,
not a certificate. A formal pentest attestation still needs a qualified human
assessor to sign. We supply the measured, always-on assurance underneath it.
