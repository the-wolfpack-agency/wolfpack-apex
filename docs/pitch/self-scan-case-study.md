# Case study: we ran the scan on ourselves

The free read-only scan we offer prospects is the same scan we run on our own
codebase. Here is what it found, unedited. It is a worked example of the wedge in
[pricing-framework.md](pricing-framework.md): no integration, read-only, a real
inventory in minutes. Reproduce it any time with `npm run self-scan`.

Numbers below are from a scan of our tracked source (it respects .gitignore, so
no dependencies or build artifacts inflate the count). Client-safe: counts,
categories, and providers only. No secret values appear here, by design.

---

## The headline

**2,639 files scanned. 74 AI touchpoints discovered. 14 flagged critical.**

A team's honest first reaction to "74 ungoverned AI touchpoints in our own repo"
is the right one: that is the point. AI shows up in a modern codebase in far more
places than anyone tracks by hand, and none of them announce themselves. You
cannot govern what you cannot see, and a list you maintain by hand is stale the
day after you write it.

## What it found

By kind:

| Kind | Count | What it is |
|---|---|---|
| Provider endpoint | 39 | A hardcoded model-provider API URL |
| AI SDK call | 21 | An import/use of a known model SDK |
| API key signature | 14 | A provider key pattern in the source |

By provider: Anthropic 26, Azure OpenAI 22, OpenAI 21, with a long tail across
LangChain, Google, Groq, and Mistral. That spread is itself a finding: AI access
is not centralized behind one client, it is scattered across the codebase, which
is exactly how an ungoverned call slips through.

## The honest part (and the real lesson)

All 14 of the "critical" API-key hits are **test fixtures**, the deliberately
fake keys our own tests use to exercise the gate. They are not live credentials,
and the scan did not find a single real leaked secret in tracked source.

A raw regex tool would scream "14 leaked keys" and you would learn to ignore it
by the third false alarm. An ignored tool protects nothing. The value is not the
pattern match, it is the triage: the scan flags the pattern, and the human plus
the gate decide what is real. That is the precision-first posture, shown on our
own code rather than asserted on a slide.

The genuine governance work the scan surfaced is the roughly 60 SDK and endpoint
integrations that should route through the gate rather than call providers
directly. Each one comes with a specific remediation: wrap the call in a
gate-authorized client so every model action is decided and recorded. That is the
"now what" a detection-only tool never gives you.

## Why this sells

- **It is real.** We did not mock it. We ran the product on the product and
  published the count.
- **It is fast and safe.** Read-only, no integration, a full inventory in the
  time it takes to read this page.
- **It is the start of the program, not the end.** The scan creates the number;
  the governance program closes the gap, and the trend line proves it stayed
  closed.

The ask is the same one we make of every prospect: let us run this read-only scan
on your codebase. If the inventory is not worth acting on, you have lost nothing.
If it is, you have your first proof, and the conversation is no longer "do we have
an AI governance problem" but "which gap do we close first."

---

*Reproduce: `npm run self-scan` from the repo root. Numbers will drift as the
codebase changes; that drift is the point of running it continuously.*
