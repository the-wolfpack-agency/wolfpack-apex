# OGIAM Pricing and Packaging (DRAFT, internal, confidential)

Status: DRAFT for analysis. Numbers are ranges to validate against real
cost/margin and 2 to 3 live sales conversations before anything is committed.
Do NOT publish to the website. Pricing on ogiam.com is intentionally withheld
until this is finalized.

## 1. What we sell

One governed agent runs the whole arc against a client system: map, scan,
penetration test, recommend, remediate, report, and keep it current, with every
action gate-governed and recorded in a tamper-evident audit trail.

Product lines:
- Penetration testing (active, authorized, scoped, read-only, killable)
- Security and quality scanning (continuous)
- Automation mapping (system profile + recommendations)
- Remediation (review-gated pull requests; never auto-merged)
- Maintenance and code changes (ongoing)
- The governed agentic workforce (OGIAM IAM) is a separate product line, priced
  on its own; this doc covers the QA / security / automation offering.

## 2. Competitive anchors

Where the market sits today (for positioning, not matching):

| Category | Typical price | Notes |
|---|---|---|
| Point-in-time pen test (consultancy) | $5k to $30k+ per engagement | Weeks of lead time, snapshot only |
| Pen-test-as-a-service (Cobalt, HackerOne, Synack, Bugcrowd) | $30k to $120k/yr or credits | Human-led, subscription or credit |
| SAST/DAST/scanning (Snyk, Semgrep, GitHub Advanced Security, Detectify, Intruder) | $30 to $100/dev/mo, or $2k to $15k/yr per app | Tooling, not a service |
| Attack-surface / continuous monitoring | $1k to $10k/mo | Surface watch |
| Automated QA (Mabl, Testim) | $1k to $5k/mo | UI test automation |

## 3. Our wedge

We are a managed, continuous offering that blends PTaaS + attack-surface
monitoring + automated remediation + UI-driven QA into one governed agent, in
days not weeks, with an auditable record. That positions us ABOVE point-in-time
scanning and AT or BELOW boutique pen test, with far better margin because the
labor is automated. The rare differentiator is "fixes, not just findings": we
open the remediation as a review-gated pull request.

## 4. Recommended model: land with an engagement, expand into a subscription, add services

Price per system/target (matches the onboarding unit and the cost driver).

| Offering | What | Suggested range (validate) |
|---|---|---|
| Baseline Engagement (land) | Full assessment + Security Engagement Report, per system | $6k to $12k one-time |
| Essentials (subscription) | Continuous security scans + system map + report refresh | $1.5k to $3k / system / mo |
| Pro | Essentials + automation mapping and recommendations + review-gated remediation PRs | $4k to $7k / system / mo |
| Enterprise | Pro + active authorized pen testing (scoped, recurring) + SLAs + multi-system | $8k to $15k / system / mo (or annual) |
| Add-ons (services) | Code-change implementation, custom automation builds, maintenance retainer | Retainer ($X/mo for N changes) or time-and-materials |

## 5. Packaging principles

- Per-system pricing matches both the onboarding unit and the compute/labor cost
  driver, so margin scales cleanly.
- Active pen testing sits in the top tier AND requires a signed authorization
  (rules of engagement). It is the premium, highest-trust capability; the harness
  enforces it technically (scope token + kill switch + gate).
- Remediation PRs are the Pro-tier hook. "We open the fix as a reviewable PR" is
  the differentiator buyers do not get from a scanner.
- The Baseline Engagement is the wedge: a fixed-price, fast, tangible report that
  undercuts a boutique pen test and lands the relationship.

## 6. Open decisions (need owner sign-off)

1. Final numbers per tier, after a cost/margin model and a few sales calls.
2. Annual vs monthly default and the annual discount.
3. Whether remediation is bundled into Pro or metered per PR.
4. Discount policy for design-partner / existing clients (see the deployment plan).
5. Whether the OGIAM IAM workforce product is bundled or sold separately.

## 7. Related

See [ogiam-client-deployment-plan.md](./ogiam-client-deployment-plan.md) for the
go-to-market sequence that lands these with existing and adjacent clients.
