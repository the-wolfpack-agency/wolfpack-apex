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

## Layer 3: novel scenarios (AI in the factory, not the product)

New tradecraft is added to the corpus as cases. This is where our own AI agents
earn their keep WITHOUT entering the product: offline, in the factory, an agent can
generate novel attack profiles, which a human reviews and adds to the corpus; the
engine stays deterministic. The corpus only grows, so coverage only improves, and
every new profile is gated by layers 1 and 2 forever after.
