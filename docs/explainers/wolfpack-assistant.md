# Wolfpack Assistant, explained

> 1 minute for execs, 5 minutes for ops and PMs, 10 minutes for new engineers. Every claim grounds in source files listed in the manifest.

```yaml
sources:
  - src/lib/assistant/orchestrator.ts          # routing, tool-first pipeline
  - src/lib/assistant/intent-router.ts         # deterministic intent classification
  - src/lib/assistant/tools/                   # 6 codified tools (calendar, mail, etc.)
  - src/lib/assistant/learning.ts              # org-wide correction capture
  - src/lib/knowledge/                         # RAG fallback when no tool matches
  - src/app/(dashboard)/assistant/page.tsx     # user-facing chat surface
last_translated: 2026-05-14
```

---

## 1-minute version (for an exec)

A team's institutional memory is scattered across email, calendar, meeting notes, financial reports, and chat. People spend hours hunting for facts that exist somewhere.

The Wolfpack Assistant is one place to ask any of those questions in plain English and get the right answer with a link to the source. It works across the whole team's data. When someone corrects it ("the decision was Tuesday, not Wednesday"), the correction sticks for everyone.

What you tell a buyer: your team's collective memory, instantly searchable, getting smarter every time someone corrects an answer.

---

## 5-minute version (for ops, a PM, or a new hire)

### Analogy: the executive assistant who has been there forever

Picture an executive assistant who has worked at the same company for 15 years. They know every calendar, can find any email in seconds, remember the conversation where the launch slipped to Q3, and remember why. When you ask "did we ever follow up with Acme about the renewal," they say "yes, March 14, here is the email."

That is not magic. It is a person with access to the right systems and the muscle memory of where everything lives.

The Wolfpack Assistant is that EA from day one. The orchestrator routes each question to the right system. The six tools (calendar, mail, meetings, goals, financials, brain history) are the systems. Intent routing is the EA's instinct for which to check first.

Unlike a human EA, the Assistant learns from corrections across the whole team. Correct it once, every future answer for everyone uses the corrected fact.

### What problem this solves

The naive approach is a chatbot that calls an LLM on every question: expensive ($0.05–$1.00 per real question), slow, and frequently wrong because the model has no access to your team's data.

The Wolfpack way: route to the right tool first. "When is my next meeting with design?" is a calendar lookup. "Find the email where we decided on Q3" is a mail search. Zero AI tokens. Only when the question is genuinely open-ended ("what did we talk about with the program lead last week") does the system fall back to RAG, and even then the LLM call is bounded.

### What a user actually sees

```
You: when's my next call with the launch team?
Wolfpack Assistant: Thursday at 2 pm.
  Source: calendar event "Q3 launch sync" with the program team.
  [Open in calendar →]

You: did we ever follow up with the vendor about the contract?
Wolfpack Assistant: Yes. Last reply was March 14 from the program lead.
  "Sending the updated draft EOD." No reply from the vendor since.
  [Open thread →]

You: who owns the goal "ship Q3 launch"?
Wolfpack Assistant: The program manager is the lead. Status: on track.
  Last update: April 28.
  [Open goal →]
```

### Everyday consequences

If it works: a new hire is functional from day one. Tenured employees stop re-finding the same fact six times. The org accumulates a queryable memory instead of losing context every time someone leaves.

If it breaks: the worst failure mode is the LLM fallback returning a confident-sounding wrong answer. Mitigated by requiring a source link with every answer — no source, no answer.

### What competitors do

- Generic AI chat (ChatGPT, Claude, Gemini): no access to your calendar, email, or meeting notes. Every question becomes a guess, plus token cost.
- Microsoft Copilot: has the data access but fragmented per app (Outlook, Teams, Word). Expensive at scale.
- Salesforce / Notion AI: pinned to one tool.
- Generic internal search (Glean, Coveo): finds documents, does not answer or learn.

What we do differently: one place, all sources, deterministic-first routing, and a learning loop that makes future answers more accurate.

### What we do better

| Capability | Generic AI chat | Wolfpack Assistant |
|---|---|---|
| Access to YOUR team's data | None | Calendar, mail, meetings, goals, financials, knowledge |
| Token cost per routine question | $0.05 to $1.00 | $0 (tool layer) |
| Cites sources in every answer | Rarely | Every answer, with link |
| Cross-team learning from corrections | No | Every correction promoted to org-wide fact |
| Answers in the right system context | No | Surfaces a link to open the underlying doc / calendar / thread |
| Predictable latency (no LLM round trip) | No | Sub-second for tool-served questions |

### How to verify

- "Tool-first routing": [`src/lib/assistant/orchestrator.ts`](src/lib/assistant/orchestrator.ts), line comment "Everything the orchestrator does is zero-token."
- "Six deterministic tools": [`src/lib/assistant/tools/`](src/lib/assistant/tools/) directory, count the files.
- "Org-wide correction capture": [`src/lib/assistant/learning.ts`](src/lib/assistant/learning.ts), see `detectCorrection()` and the `instinct_org_facts` table.
- "Sources in every answer": every tool result includes a `source` field rendered as a clickable link.

---

## 10-minute deep dive (for a new engineer)

Read in order:

1. Orchestrator + intent routing: [`src/lib/assistant/orchestrator.ts`](src/lib/assistant/orchestrator.ts) and [`src/lib/assistant/intent-router.ts`](src/lib/assistant/intent-router.ts). Deterministic regex/keyword matching, dispatch to tool, RAG fallback only when nothing matches.
2. The six tools: [`src/lib/assistant/tools/`](src/lib/assistant/tools/). `calendar-availability`, `meetings-on-date`, `mail-search` (Microsoft Graph); `goals-lookup`, `financials-metric`, `brain-history` (DB-backed).
3. Learning loop: [`src/lib/assistant/learning.ts`](src/lib/assistant/learning.ts). `detectCorrection()` parses structured facts from user follow-ups, writes to `instinct_org_facts`. Every future Assistant prompt is grounded with these facts.
4. RAG fallback: [`src/lib/knowledge/`](src/lib/knowledge/). Semantic search over Qdrant, top-K into LLM context. Only invoked when retrieval confidence justifies it.

UI surface: [`src/app/(dashboard)/assistant/page.tsx`](src/app/(dashboard)/assistant/page.tsx).

### How to add a new tool

1. Create `src/lib/assistant/tools/your-tool.ts` exporting `runYourTool(query): Promise<ToolAnswer | null>`.
2. Add the intent classification rule in `intent-router.ts`.
3. Wire dispatch in `orchestrator.ts`.
4. Add unit tests: matches, no-match, graceful null fallback.

### Safety layers

- LLM fallback hallucinates with high confidence: blocked by "no source = no answer."
- Intent classifier matches the wrong tool: the tool returns null, orchestrator falls through to RAG.
- Correction-loop integrity is enforced by AgenticQA's `learning_loop_unsafe` scanner on every push. The scanner flags any code path that writes a fact without (a) typed-schema validation, (b) per-user rate limit, (c) role allowlist, or (d) newline/control-char sanitization on the value. Defense-in-depth: values are sanitized again at render time so a poisoned fact cannot break out of the LLM grounding fence even if write-side checks ever regress.

---

## Future potential

- Voice interface: same intent router, same tools, different surface.
- Action tools (not just lookup): "schedule a follow-up with the vendor next Tuesday" routes to a calendar-create tool with the same zero-token path.
- Per-user calibration: a second learning loop for user-specific preferences ("I prefer 1-hour meetings").
- Cross-product Assistant: same orchestrator, different tool set, deployed inside wolfpack-auto for dealers.

All reuse the existing orchestrator and learning loop. The expensive engineering is the architecture, not any single tool.

---

> Trustworthy because: manifest at top + CI staleness check. If a source file changes, this doc gets flagged for re-translation.
