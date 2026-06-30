# Deferred security track

These three items were deliberately NOT built in the 2026-06-30 gap-closure batch.
Each is multi-session and high blast radius: rushing it alongside everything else
would create exactly the risk our engineering directive forbids ("never create
risks", "no breaking changes without verification"). They are recorded here with
the reasoning, the safe sequencing, and the acceptance criteria so they can be
picked up as dedicated, well-scoped work.

The batch DID ship the safe, contained subset of the "honest gaps" closeout:
admin MFA (TOTP) as opt-in, non-enforcing enrollment (see `feat/admin-mfa`). The
items below are the parts that are not safe to do in a shared parallel batch.

---

## 1. SSO (SAML / OIDC) for enterprise login

**Why deferred.** SSO changes the authentication entry point for every user. A
mistake locks out a whole tenant or, worse, weakens the auth boundary. It also
needs IdP-side configuration (Okta / Entra / Google) that is per-customer, so it
cannot be validated by unit tests alone.

**Risk if rushed.** Account takeover via mis-scoped assertions, broken refresh
rotation, or a fallback path that bypasses the capability model.

**Safe approach (own PR, own session).**
- Add an OIDC/SAML provider behind a per-workspace flag; keep the existing JWT +
  refresh path as the default and the fallback, never remove it.
- Map IdP claims to the existing role/capability model explicitly; default-deny
  on an unmapped claim.
- Reuse the named-algorithm crypto registry for assertion signature verification;
  do not add a bespoke verifier.
- Honor the existing `returnTo` same-origin SSRF defense in the callback.

**Acceptance criteria.**
- E2E: a full SSO login round-trip against a test IdP, plus the non-SSO login
  still works unchanged.
- Contract tests for assertion validation: expired, wrong-audience, wrong-issuer,
  replayed, and unmapped-claim all rejected.
- Audit: every SSO login + JIT provisioning event hash-chained.
- Zero change to the unauthenticated-redirect behavior of existing pages.

---

## 2. Full multi-tenant RLS retrofit (DB-enforced isolation everywhere)

**Why deferred.** Today isolation is enforced app-side by a workspace predicate
on every scoped query, gated by the repo-wide tenant-isolation scan (unclassified
must be 0). Session-variable RLS via `withWorkspaceScope` is being retrofitted
table by table. Flipping every table to FORCE RLS at once risks silent empty
result sets in any query that does not yet set the session GUC, which surfaces as
blank pages, the exact regression class we already lived.

**Risk if rushed.** A query that misses the session-scope setup returns zero rows
under FORCE RLS, so the failure is data-disappearing, not an error: hard to catch
without exhaustive coverage.

**Safe approach (incremental, per-table, over several PRs).**
- Keep the app-side predicate as the belt; add RLS as the suspenders, one table
  group per PR, behind the existing `withWorkspaceScope` AsyncLocalStorage.
- For each table: ship the policy in PERMISSIVE/log mode first, verify every read
  path sets the scope (the tenant-isolation scan + a new "scope-set" assertion in
  integration tests), then graduate to FORCE.
- Never graduate a table to FORCE in the same PR that introduces its policy.

**Acceptance criteria.**
- The tenant-isolation scan stays at unclassified 0 throughout.
- DB tests: a query without the session scope returns an error or is provably
  unreachable, not a silent empty set.
- A cross-tenant read attempt is denied at the DB layer (not just app layer) for
  every graduated table.
- No page regresses to a blank/empty state (E2E against the deployed URL).

---

## 3. SOC 2 (Type II) certification

**Why deferred.** This is a process and evidence program over a monitoring
window, not a code change. We can and do generate the evidence with our own
Comply beat, but the certification itself requires an auditor, a control period,
and operational artifacts (access reviews, change management, incident response
runbooks) that accrue over time.

**Risk if rushed / faked.** Claiming "SOC 2 compliant" without certification is a
procurement-killing misrepresentation. Our entire positioning is honesty; this
must never be overstated.

**Safe approach.**
- Use the Comply beat + the new signed evidence export to assemble the control
  evidence continuously (we eat our own dog food here).
- Stand up the operational controls that are currently checklist items: admin MFA
  enforcement (after the opt-in adoption proves out), access reviews, documented
  change management (we already have CI gates + the audit ledger as evidence).
- Engage an auditor for a readiness assessment, then a Type II window.

**Acceptance criteria.**
- A readiness gap list produced from the Comply evidence, with each gap tracked.
- No external claim of certification until the report is in hand; until then the
  honest line stays: "building the evidence with the same engine we sell, here is
  the roadmap and the target date."

---

## Sequencing recommendation

1. Graduate admin MFA from opt-in to enforced (small, flagged) once adoption is
   real. This unblocks the first SOC 2 access-control evidence and is lower risk
   than SSO.
2. Continue the per-table RLS retrofit incrementally (no big-bang).
3. SSO as a dedicated session with a test IdP.
4. SOC 2 readiness assessment in parallel, since it is process not code.
