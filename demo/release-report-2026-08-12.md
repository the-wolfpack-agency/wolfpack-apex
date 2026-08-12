# Wolfpack Instinct — Release Report 2026-08-12

## TL;DR

Launch week for **A Weekend with Porsche**. Eleven Porsche Centers are invited Thursday, and this window was spent making the workspace safe to hand to them and the invitation email safe to send.

Three things are the headline, and each was a case of the product telling a Center something that was not true:

1. **One checklist, not two.** The item-level checklist lived in a drawer on the guest list row, so the profile — the screen for working one guest — had stage tiles and no items, and the grid view could not reach it at all. It now sits on the profile. The six stage pages, which carried a second tickable copy writing to the same row, became a static reference. Two tickable copies of the same eight items could silently overwrite each other with nothing on screen saying which had won.

2. **Invitations could not be authenticated.** The sending domain published SPF ending in `-all` without listing Microsoft's outbound, and no DKIM selectors at all. Every invitation to the eleven Centers would have gone out unauthenticated. No test looked at DNS, and the in-product self-test could not see it: it mails an address inside our own tenant, where Exchange evaluates neither SPF nor DKIM, so a green self-test and a broken domain were indistinguishable. Both are fixed, verified against the authoritative nameservers, and `launch:check` now reads them on every run.

3. **A support channel for the Center leads.** `/admin/support`, behind the sign-in they already use, so it knows who is submitting and for which Center and does not ask. Submissions land in the existing feedback queue and are emailed to the team. Confirmed working end to end by a real send.

**Also landed:** the PPN export imports as downloaded and keeps the booking it already knows; Terms and Privacy published against a data map read off the migrations; the analytics funnel counts the weekend rather than the console; a launch readiness check and a live-UI verifier; and a build-failure guardrail that type-checking cannot see.

**Size:** 89 commits, 126 files changed, 11,751 lines added and 1,187 removed, across `wolfpack-porsche-weekend` (87 commits) and `wolfpack-apex` (2). Lock files and generated CSS excluded, because a dependency bump otherwise reports tens of thousands of lines and buries the real number.

---

## The three that mattered most

### The checklist moved, and took a data-corruption bug with it

Moving the checklist onto the profile surfaced a race that recorded a guest as handed a car they were never given.

Opening a guest fires a request for their saved progress. Pressing **Check All** before it landed let the stale response overwrite the write, and the damage was worse than a lost tick: the stage that was pressed got wiped, while the cascade that followed filled the two stages *before* it. The record then said a guest had returned from an experience that had been cleared.

A guard for exactly this already existed for the stage tiles, added when "complete the whole journey" hit the same race. The new write path had stepped outside it. The fix moved the guard into the single writer so all three paths are covered.

**Found by driving the real UI.** Every unit test passed while the feature silently corrupted data. The first two hypotheses about the cause were both wrong; a failure screenshot settled it.

### Mail DNS, measured rather than assumed

| | before | after |
|---|---|---|
| SPF | `-all`, no Microsoft | Microsoft at lookup 1, 6 of 10 budget |
| DKIM | no selectors | selector1 + selector2, 2048-bit keys |
| DMARC | `p=none` | unchanged |

`launch:check` now resolves the sending domain on every run and reports SPF, its lookup budget against the RFC 7208 limit, both DKIM selectors and DMARC. It catches more than one SPF record (a permerror that fails *all* mail), a selector resolving with an empty `p=` (a revoked key that looks configured and signs nothing), and the sending provider being absent, which is the fault that was actually there.

It also states plainly what it cannot prove: that an invitation is *delivered*. Only a send to an address outside the tenant answers that.

### /admin/support

Four required fields, each earning it:

- **Type** has no default. A pre-selected radio is the value most submissions arrive with whether or not it is true, and the queue is sorted by it.
- **Summary** becomes the email subject. Five inboxes showing the same generic line tells nobody which to open first.
- **Urgency** because whether a guest is stuck right now cannot be inferred from prose written by somebody being polite about it.
- **Details**, the report itself.

Who reported it is optional, because the lead is often relaying for someone else and a required field nobody can answer gets filled with a full stop. The form never asks who they are or which Center: the session knows, and a field somebody retypes is a field they get wrong.

It reuses `program_feedback` rather than opening a second store, so there is one queue rather than two places to look for the same issue. Feedback from inside the product reaches two role addresses; the support form reaches the whole team.

---

## What the tooling caught, and what it missed

Worth recording honestly, because the pattern repeated.

| Fault | Caught by | Would tests have found it? |
|---|---|---|
| Check All wiping the pressed stage | new e2e driving the UI | No. Every unit test passed. |
| `/admin/team` logging a 403 for dealers | console assertion in the seeded e2e | Yes, and it did — after it shipped. |
| Client bundle pulling in the Postgres driver | `next build` | No. Type-check is clean. |
| Support Send button beside the last field | screenshotting the live page | No. Every assertion was about which controls exist. |
| Duplicate header and footer on `/admin/support` | reported from the live page | No. The render test asserted the footer was *present*. |

Two of those are the same lesson: assertions about *which controls exist* pass while the page looks wrong. `verify:live-ui` exists for that gap, and earned its place on its first run by producing two false greens in itself, both fixed before it was committed.

---

## Guardrails added

- **`launch:check`** — read-only against production: the four pages an invited dealer must reach, the demo door, five security headers, the legal pages, and the sending domain's DNS.
- **`verify:live-ui`** — drives production in Chromium and screenshots it. Read-only; it never submits the support form, because that would email five real people.
- **Client-bundle guardrail** — fails when a `use client` file value-imports anything reaching `pg`. Type-only imports stay allowed, since they are erased before bundling. It found a pre-existing case that survived only because the bundler tree-shook it away.
- **Legal copy tests** — `content/legal.ts` had no test at all. Now: the operating entity is always named in full, no address on a domain with no MX, no section left as an author's prompt, and no retention *period* stated while no purge job exists.

---

## Known and carried into launch

None of these blocks the invitation. They are written down so nobody discovers them as a surprise.

| Gap | Consequence |
|---|---|
| `DEMO_MODE` still on in production | The sign-in page offers a demo door into a **shared** Center. A Center pressing it before accepting their invite can enter real guests into an account every other dealer can open. **The one item to close before Thursday.** |
| Terms and Privacy not through counsel | Three clauses a commercial agreement normally carries are deliberately absent: entity form, governing law, liability cap. Inventing them would be worse than their absence. |
| No acceptance capture | Nothing records that a Center agreed, or to which version. |
| No retention or purge job | Guest data is kept until deleted. The notice says exactly this rather than promising a schedule that does not exist. |
| No data-subject export | An access request is answered by hand. |
| One intermittent e2e | `removing a success story` failed once and has passed every run since. **Cause not found.** Next step is a network log around the click. |

---

## Repos in this window

| Repo | Commits | Files | Added | Removed |
|---|---|---|---|---|
| `wolfpack-porsche-weekend` | 87 | 122 | 11,537 | 1,163 |
| `wolfpack-apex` | 2 | 4 | 214 | 24 |
| **Total** | **89** | **126** | **11,751** | **1,187** |

Published to `/releases` as `2026.08.12` via `scripts/publish-release-2026-08-12.ts`, which goes through the same `createRelease()` the generator uses.
