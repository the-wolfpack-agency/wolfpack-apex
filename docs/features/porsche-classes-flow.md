# Porsche Class-Summary Automation — End-to-End Flow

**Audience:** non-technical stakeholders (program managers, coordinators, leadership) who currently execute the manual version of this work.

**What it replaces:** the weekly "collect → assemble → format → file" handoff that used to live across email, OneDrive, and SharePoint.

---

## TL;DR

You used to do **eight steps** by hand for every class. The system now does seven of them for you, leaving only the **review-and-ship** moment for a human.

| Step | Before (manual) | After (automated) |
|------|------------------|-------------------|
| 1. Collect coordinator emails | Forward to a folder | Inbox watcher ingests automatically |
| 2. Collect instructor emails | Forward to a folder | Inbox watcher ingests automatically |
| 3. Pull the participant roster | Open the .xlsx, copy names | Roster parser extracts the list |
| 4. Pull the survey rollup | Open Cognito, count averages | Survey parser computes per-question stats |
| 5. Cross-check for missing data | Eye-ball the email thread | Exception detector flags gaps inline |
| 6. Assemble the Word document | Re-type into the template | Renderer outputs Word / PDF / JSON |
| 7. File to the SharePoint folder | Drag-drop into the right folder | "Upload to SharePoint" button (1 click) |
| 8. **Review + send / archive** | (you) | (you — still your call) |

---

## The visual flow

```
                              ┌───────────────────────────┐
       coordinator emails ──▶ │                           │
       instructor emails  ──▶ │   1. INBOX WATCHER        │   reads incoming
       roster .xlsx       ──▶ │   (Email feeds)           │   messages on a
       Cognito survey CSV ──▶ │                           │   schedule
                              └─────────────┬─────────────┘
                                            │
                                            ▼
                              ┌───────────────────────────┐
                              │   2. PARSERS              │   each kind of
                              │   (per source type)       │   document gets
                              │                           │   its own parser:
                              │   • coordinator-notes     │   they're small
                              │   • instructor-notes      │   and replaceable
                              │   • participant-roster    │
                              │   • survey-rollup         │
                              └─────────────┬─────────────┘
                                            │   structured snapshots
                                            ▼
                              ┌───────────────────────────┐
                              │   3. SNAPSHOT STORE       │   one row per
                              │   (Postgres)              │   document, with
                              │                           │   the class_key
                              │                           │   it belongs to
                              └─────────────┬─────────────┘
                                            │
                                            ▼
                              ┌───────────────────────────┐
                              │   4. ASSEMBLER            │   joins all
                              │                           │   snapshots that
                              │   one class_key →         │   share the same
                              │   one summary             │   class_key into
                              │                           │   a single
                              │                           │   AssembledSummary
                              └─────────────┬─────────────┘
                                            │
                                            ▼
                              ┌───────────────────────────┐
                              │   5. EXCEPTION DETECTOR   │   flags missing
                              │                           │   coordinator,
                              │                           │   missing roster,
                              │                           │   conflicting
                              │                           │   dates, etc.
                              └─────────────┬─────────────┘
                                            │
                                            ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                      │
   │   /automations/porsche-classes                                       │
   │   ───────────────────────────                                        │
   │   "This week" table — one row per class. Click → open summary.       │
   │                                                                      │
   └──────────────┬───────────────────────────────────────────────────────┘
                  │
                  ▼
   ┌──────────────────────────────────────────────────────────────────────┐
   │                                                                      │
   │   /automations/porsche-classes/summaries/<class>                     │
   │   ──────────────────────────────────────────────                     │
   │   The review page. You see:                                          │
   │     – class meta (course, date, location)                            │
   │     – open exceptions banner (if any)                                │
   │     – attendance + participant list                                  │
   │     – coordinator notes                                              │
   │     – instructor notes                                               │
   │     – survey rollup                                                  │
   │                                                                      │
   │   And six buttons:                                                   │
   │     [Copy as plain text]  → into email / Slack                       │
   │     [Download JSON]       → for downstream tools                     │
   │     [Download Word]       → matches the existing PCNA template       │
   │     [Download PDF]        → printable / shareable                    │
   │     [Upload to SharePoint]→ files into the configured folder         │
   │     [← Back to summaries]                                            │
   │                                                                      │
   └──────────────────────────────────────────────────────────────────────┘
```

---

## What each piece does, in plain language

### 1. The Inbox Watcher

A background process that reads incoming email/document feeds you've configured. It doesn't open anything you didn't authorize — it only watches the folders/feeds set up under **Meetings → Email feeds**. Every new message becomes a parsed *snapshot*.

**What you'd notice:** new entries appearing on the "This week" table without anyone touching the browser.

### 2. The Parsers

Each kind of document has its own parser — a small piece of code whose only job is to turn one specific format into structured data:

- *Coordinator notes parser* — pulls "from / class date / class code / notes" out of free-form coordinator emails.
- *Instructor notes parser* — same idea, instructor side.
- *Participant roster parser* — reads the .xlsx attendee list.
- *Survey rollup parser* — reads the Cognito CSV and computes per-question averages.

If a parser can't make sense of a document, the system logs it as an *exception* (see step 5).

### 3. The Snapshot Store

Every parsed document becomes one row in our database, tagged with a *class_key* like `BA101|2026-04-20|Ritz Carlton`. Two coordinators can both submit notes for the same class — they'll both land here, both visible.

### 4. The Assembler

When you open a summary, the assembler queries every snapshot that shares the same class_key and fuses them into one `AssembledSummary` object: course type, date, location, all coordinator notes, all instructor notes, the participant list, the survey rollup. Single source of truth per class.

### 5. The Exception Detector

Before the summary renders, the detector runs through it asking questions like:

- *Did we get a coordinator note?*
- *Did we get a roster?*
- *Does the date in the roster match the date in the coordinator email?*
- *Did the survey come back with fewer responses than the roster?*

Anything ambiguous gets a row in the **open exceptions banner** at the top of the summary page so you see it before you copy/upload anything.

### 6. The Review Page

This is the human-in-the-loop step. You scan the summary, glance at exceptions, then choose how to ship it:

| Button | What it does |
|--------|--------------|
| Copy as plain text | Copies the whole summary to your clipboard, formatted to match the existing template — drop into an email or chat |
| Download JSON | Raw structured data — useful when feeding another tool |
| Download Word | Renders a `.docx` that matches the existing PCNA Word template |
| Download PDF | Renders a printable PDF — useful for archives + print-outs |
| Upload to SharePoint | Generates the `.docx` and PUTs it into the configured SharePoint folder (`<course> - YYYY-MM-DD - <location>.docx`). One click replaces the manual download → drag-drop step |

Every button has automated test coverage (see *Validation* below) — clicking them must always do the thing they say.

### 7. The Audit Log

Every SharePoint upload is logged with the class_key, the actor who clicked, the resulting Graph item ID, and the timestamp. If something gets uploaded by mistake, the audit row carries the durable Graph handle that lets us undo (DELETE) within the 24-hour window.

---

## Where things show up if something breaks

| Symptom | Where to look |
|---------|---------------|
| A class isn't on "This week" | Email feed isn't ingesting — check **Meetings → Email feeds**. The feed status row shows last poll time + any error. |
| A coordinator submitted notes but they're missing | Open the summary page; the **open exceptions banner** at the top names the parser that couldn't read it (e.g. "coordinator parser: subject mismatch"). |
| Upload to SharePoint fails | The error appears inline below the button. Common causes: |
| | • *"SharePoint not configured"* — the `INSTINCT_SHAREPOINT_*` env vars aren't set yet (graceful skip, 202 response) |
| | • *"Reconnect Microsoft"* — the Microsoft 365 OAuth token expired (graceful skip, 202) |
| | • *"The string did not match the expected pattern"* — fixed Apr 26 by formatting the date as `YYYY-MM-DD` instead of full ISO. If this resurfaces, it's a SharePoint name-validation regression |
| Copy / Download buttons don't seem to do anything | The page guards every button against an unloaded summary; if the summary fetch failed you'll see the error banner instead of the toolbar |

---

## Validation — what we test automatically

Every piece below has test coverage that runs on every CI build. If any of these fail, the change can't ship.

| Surface | Tests | Asserts |
|---------|-------|---------|
| `buildFilename` | 8 cases | Drops time-of-day, accepts bare dates, falls back to parsed date, strips `\\ / : * ? " < > \|`, strips `# % &`, trims trailing whitespace + periods, collapses spaces, fills `Class` for empty fields |
| `POST /api/automations/.../upload-sharepoint` | 11 cases | 401 unauth, 404 unknown automation, 404 no snapshots, 500 assembler/render error, 200 happy path, 202 not_configured, 202 no_token, 502 graph_error, attempt + success analytics, audit row written |
| Summary page toolbar | 8 cases | Copy → clipboard contains formatted text; Download JSON → Blob created with `application/json`; Download Word → anchor click to `/export-docx`; Download PDF → anchor click to `/export-pdf`; Upload SharePoint success → success banner; Upload skipped (202) → soft-skip banner; Upload error (502) → error banner with message; Back-to-summaries → real `<a>` to `/automations/<id>/summaries` |
| Renderer (Word, PDF) | covered by `export-docx` + `export-pdf` route tests | Document renders, magic bytes correct, fields populated |

The test rule: every time we add a button or a path, a test goes with it. No new feature ships unless it can be exercised end-to-end in CI.

---

## What's NEXT (not yet automated)

These remain manual and are worth flagging before you trust the pipeline end-to-end for a new program:

- **Email feed setup** — onboarding a new program (e.g. a non-Porsche track) still requires creating the Email feed entry and pointing it at the right inbox.
- **Parser onboarding** — a new document format means a new parser class. We've built four; the framework makes adding a fifth small, but it isn't zero.
- **SharePoint folder mapping** — the destination folder is configured per environment via `INSTINCT_SHAREPOINT_SITE_ID`, `INSTINCT_SHAREPOINT_DRIVE_ID`, and `INSTINCT_SHAREPOINT_CLASS_SUMMARIES_PATH`. Switching to a different SharePoint site is a config change, not a code change.

---

## Where the data goes

Every step writes to one of three durable stores so nothing is ever lost:

- **Postgres (`instinct_*` tables)** — snapshots, assembled summaries, exceptions, audit log.
- **Microsoft Graph (SharePoint drive)** — the rendered `.docx` itself once you click Upload.
- **Analytics (`system.*` events)** — every attempt, success, and skip is logged to the analytics warehouse so the Brain can learn which classes need the most coordinator chasing, which surveys come back the fastest, etc.

If a stakeholder ever asks "did this run, when, and what happened?" — the answer lives in those three places, in that order.
