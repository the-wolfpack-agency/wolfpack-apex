# Candidate constitution rules (agent behavior)

These are decidable rules about how the AGENT behaves, drawn from recurring
friction in real sessions. Their enforcement point is the PreToolUse guard /
constitution loader in AgenticQA-core, not this repo, so they are written up here
for review rather than implemented. Each is a pure predicate over an observable
(a tool call, generated text, the session state), so it can be a hard gate, not
a reminder.

Format: id, when it fires, the deterministic predicate, and the action.

## C-PR-LINK-REQUIRED

- **Pain:** PR created or updated in a turn, but the reply omits the URL. Flagged
  repeatedly; costs a round trip every time.
- **Predicate:** the turn ran `gh pr create` / `gh pr edit` (or a push that opened
  a PR) AND the assistant's final message contains no `https://github.com/.../pull/<n>`.
- **Action:** block the turn from completing until the URL is included (or append
  it automatically).

## C-NO-EM-DASH-IN-OUTPUT

- **Pain:** standing "no em dashes anywhere, including chat" rule, broken because
  it lived in memory. (A committed-content guardrail already exists in apex;
  this covers the assistant's own prose, which nothing checks.)
- **Predicate:** the assistant's outgoing message contains `—` (U+2014) or `–`
  (U+2013).
- **Action:** block / auto-replace with a hyphen before sending.

## C-VERIFY-BEFORE-PUSH

- **Pain:** pushing before the full local guardrail suite has run green, so CI
  catches a guardrail failure and each one costs a full cycle. The directive is
  already "verify once, push once."
- **Predicate:** a `git push` is attempted AND `scripts/verify.sh` has not
  completed successfully against the current HEAD in this session.
- **Action:** block the push until a green verify is recorded for this HEAD.

## C-NO-PRIVATE-EMAIL-IN-COMMAND

- **Pain:** the private email must never be written into commits/config/data.
  (apex now gates the branch's commits via check:commit-hygiene; this covers the
  broader case of any tool call that would write it.)
- **Predicate:** a tool call's arguments contain `nickhomyk@gmail.com` and the
  target is a file write / commit / config, not a test fixture.
- **Action:** block.

## C-CODIFY-REPEATED-COMMAND

- **Pain:** the same manual command sequence run more than twice instead of being
  scripted (the Foundry config was a copy-paste ritual). The directive is "before
  running the same command more than twice, write the script."
- **Predicate:** the same normalized command (or close variants) has run > 2
  times in the session with no script created for it.
- **Action:** advisory prompt to codify it (not a hard block: the shape is
  heuristic and a false block would be worse than the repetition).

## Explicitly NOT rules (kept advisory, by design)

These recurred but are not cleanly decidable; a hard gate would give false
confidence. They stay model-assisted + human:

- "Verify before asserting" (epistemics): the fix is to require a read before a
  claim about a file/flag, which is a workflow nudge, not a decidable gate on the
  claim itself.
- "Considers the full codebase", "not a sub-optimal process", "no fabricated
  facts": judgment calls. Route to the independent-family judge and a human.
