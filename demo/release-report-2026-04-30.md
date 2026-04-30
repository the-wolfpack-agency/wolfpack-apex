# Wolfpack Instinct — Release Report
**Date:** 2026-04-30
**Production:** https://wolfpack-instinct.vercel.app
**HEAD:** `9ca47e6`
**Session size:** 25 PRs merged

---

## TL;DR

Three new top-level features landed and are live on production:

1. **QR generator with deep per-scan analytics** at `/qr` — create, share, track. Generates SVG / PNG / JPG / PDF in any pixel size.
2. **Bulletin sticky-note boards** at `/bulletin` — multi-user collaborative whiteboard, save state as a PNG snapshot tied to any meeting / task / goal / discussion / calendar event.
3. **Email surface upgrade** — signatures (per-user), resizable inbox split-pane, unread badge in the left nav, inbound email entries in the top-right notification bell, full-width composer, fixed delete-403 bug (was missing `Mail.ReadWrite` OAuth scope).

Plus: assistant org-wide cache + meetings_on_date intent + Outlook signature detection plumbing.

---

## What's new for the team

### 📱 QR generator (`/qr`)
- Mint short-link QR codes that point at any URL.
- Edit the destination later — the printed QR keeps working (slug is stable).
- Scan analytics: country / region / city / device / OS / browser / referrer / hashed visitor (never raw IP).
- Download in 4 formats: **SVG** (vector), **PNG** (transparent), **JPG** (white bg), **PDF** (printable Letter page with QR centered at 4×4 in).
- Pick the size you actually need: 256 / 512 / 1024 / 2048 px for raster formats.
- Mobile-friendly: form stacks on narrow screens, Show QR panel scales to viewport.

### 📌 Bulletin board (`/bulletin`)
- Create boards. Drag + resize sticky notes. Pick a color (6 swatches). Inline-edit text (auto-saves on blur).
- Org-shared by default — every wolfpack member sees every board.
- **Link a note** to any task / goal / meeting / discussion / calendar event via a portal-rendered modal sheet (works on mobile).
- **Save as image** captures the board as a PNG and ties it to a meeting (or task / goal etc.) as a permanent artifact. Snapshots sidebar lists every save with view + download links.
- For your recurring 1:1 with Hoxsie: create "Innovation 1:1" once, both add notes throughout the week, snapshot before each meeting and link to that calendar event.

### 📧 Email upgrade (`/emails`)
- **Signatures** — manage in Settings → Email signatures. Default signature pre-fills new emails. Reply/forward inserts above the quoted-original block.
- **Resizable inbox** — drag the divider to your preferred width. Auto-collapses when composing for full-width compose. Width persists across sessions.
- **Unread badge** in the left sidebar (numeric pill, polls every 5s when visible).
- **New-email notifications** in the top-right bell with deep-link to the message.
- **Inbox-row delete** — hover any row in the inbox list to see ×; two-tap confirms.
- **Delete bug fix**: was returning 403 for everyone because the OAuth scope set requested only `Mail.Read`. Now requests `Mail.ReadWrite`. **One-time action: re-connect Microsoft 365 in Settings to pick up the new scope.**

### 🤖 Assistant
- Org-wide Q/A cache: any question answered for one wolfpack member is reusable for everyone (within TTL — 7 days for date-bound, 1 hour otherwise). Fuzzy match on token-set Jaccard ≥ 0.8 catches paraphrases.
- New `meetings_on_date` intent: questions like "which meetings did wolfpack have on April 21, 2026?" route to a deterministic tool that queries Plaud transcripts + MS Teams + your Outlook calendar — zero LLM tokens.
- Learning loop: when you correct the assistant ("no, it is Porsche") the correction is captured as an org fact and injected into all future prompts about the same subject.
- Token usage card in Settings.

---

## Migrations applied

| # | Name | Tables added |
|---|---|---|
| 109 | org_facts | `instinct_org_facts` |
| 110 | qr_codes | `instinct_qr_codes`, `instinct_qr_scans` |
| 111 | email_signatures | `instinct_email_signatures` |
| 113 | bulletin_boards | `instinct_bulletin_boards`, `instinct_bulletin_notes`, `instinct_bulletin_snapshots` |

Migration 112 (per-scan QR attribution columns) is staged but pending — the agent that built it stalled mid-task. Resume notes in the handoff doc.

---

## Analytics events added to InstinctEventType

```
assistant.qr_code_created / qr_scan_recorded / qr_analytics_viewed
assistant.org_qa_cache_hit / org_fact_captured
microsoft.email_unread_polled / email_arrived_notified
microsoft.signature_created / signature_inserted
bulletin.board_created / board_archived
bulletin.note_created / note_updated / note_deleted
bulletin.snapshot_saved / snapshot_viewed
```

---

## Test coverage at release

| Area | Tests |
|---|---|
| QR (lib + API + UI) | 108 |
| Bulletin (lib + API + UI) | 119 |
| Email signatures + delete + nav | 96 |
| Assistant cache + learning | 99 |
| **Net-new this session** | **~250** |

CI Verify + CodeQL + AgenticQA Security Self-Scan + AgenticQA Full Pipeline all green for `main`. `npx tsc --noEmit` clean.

---

## Known caveats

- **Existing M365 users must re-OAuth once** for the new `Mail.ReadWrite` scope to take effect. Settings → Microsoft 365 → Disconnect → Reconnect. The 403 error in the email reader now shows a clear "Reconnect Microsoft 365" CTA when this is the cause.
- **QR per-scan detail view (`View all scans`)** is hidden until migration 112 + `/api/qr/[id]/scans` ship in the next session. Aggregated analytics (KPIs, line chart, top-10 country/device/browser, hour heatmap, recent table) all work.
- **Bulletin snapshots use foreignObject + canvas fallback.** First-pass output is "good enough for what the meeting decided" screenshots; not pixel-perfect with the canvas grid background.
- **Old QR codes created before 2026-04-30 ~20:00Z** encoded the wrong (relative or per-deployment) URL. Re-create them — the slug is gone but the destinations were preserved in the DB.

---

## What's next

See `demo/handoff-2026-04-30.md` for the full punch list. Top three:
1. Finish QR per-scan attribution view (migration 112 + scans route).
2. Outlook signature import button (lib `email-signatures-detect.ts` already plumbed; needs endpoint + Settings button).
3. Wire `findNotesByAssociation` into meeting / task / goal detail pages so bulletin attachments surface on the linked entity's page.

---

🤖 Generated with the help of Claude Code agents working in parallel on disjoint files.
