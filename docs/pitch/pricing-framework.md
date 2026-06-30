# Pricing framework (value-based, not a price list)

How to anchor, structure, and talk about price so a deal is sized to the value it
protects, not to a feature count. This is a framework, not a final rate card.
Numbers below are illustrative starting points to anchor a conversation; the real
number comes from discovery. Pairs with founder-gtm-playbook.md (the motion) and
outreach-and-deck.md (slide 9, the business model). No em dashes. Never name a
competitor.

---

## The shape of the deal

Two moves, in order:

1. **The wedge: a free read-only shadow-AI scan.** It inventories where AI is
   already running in their systems and how much of it is ungoverned. It is free
   because its job is to create the alarm and the number, not to make revenue. A
   delivered scan readout is the only outcome that matters at the top of the
   funnel.

2. **The program: a bundled 12-month governance engagement.** The scan finds the
   gap; the program closes it. Sold as a consulting-led program (Wolfpack
   services plus the OGIAM platform), not as seat-based software. This matches who
   the seller is and makes the price about an outcome, not a line item.

The program is the unit you price. The scan is the thing you give away to earn
the right to price it.

---

## Value anchors (set these before you ever say a number)

Price feels expensive in a vacuum and cheap next to the cost of the problem.
Establish the cost of the gap first, using the prospect's own numbers where you
can.

- **One ungoverned AI incident.** An agent that takes a wrong action at machine
  speed, a leaked key in config, a data exfiltration through a tool call. Ask:
  "what would one of those cost you, in remediation, downtime, and the week your
  team loses to it." Their number is your floor.
- **A failed or delayed audit.** Enterprise deals and renewals stall when you
  cannot show how AI is governed. Ask: "is anyone holding up a deal or a renewal
  on AI compliance right now." A stalled six- or seven-figure contract dwarfs the
  program.
- **A breach headline.** The cost that is not on a spreadsheet: the customer who
  churns, the deal that dies in security review, the board conversation. Ask:
  "if you had to explain to your largest customer what your AI did last month,
  could you." The inability to answer is the risk.

The framing line: "the program costs less than the first incident it prevents,
and far less than the deal it unblocks." Make them do that math in the room.

---

## Good / better / best (the tier shape)

Three tiers so there is always a smaller yes and a bigger anchor. Lead with
Better; let Best pull the anchor up and Good catch the budget-constrained.

| | Good (Establish) | Better (Govern) | Best (Assure) |
|---|---|---|---|
| For | First governance footprint | The default program | Regulated or high-exposure |
| Shadow-AI scan | Yes, one-time | Yes, recurring | Yes, recurring |
| AI surface inventory | Yes | Yes | Yes |
| Deterministic gate | Monitor mode | Monitor plus enforce on your schedule | Monitor plus enforce, multi-team |
| Tamper-evident ledger | Yes | Yes | Yes, with export for auditors |
| Human escalation routing | Basic | Yes | Yes, with custom policy |
| Continuous red-team | Periodic | Continuous | Continuous, expanded corpus |
| Compliance crosswalk | One framework | Multi-framework coverage view | Multi-framework plus audit-support evidence pack |
| Policy simulator | No | Yes | Yes |
| Engagement | Quarterly review | Ongoing program, named contact | Ongoing program, priority response |

What every tier includes, always: the read-only scan, the AI surface inventory,
the deterministic gate (at least in monitor mode), and the tamper-evident ledger.
Those four are the product; the tiers differ in how far enforcement, assurance,
and compliance coverage extend.

Illustrative anchor for the Better tier: a 12-month program in the
low-to-mid five figures for a first deployment (the deck references a $60k Year 1
program as the reference point). Treat that as the anchor to react to, not a
quote. The number you land on is the value the discovery surfaced, expressed as a
program.

---

## Discovery questions that size the deal

Ask these before you price. Each answer moves the number.

1. "Are you deploying AI agents, or AI features that take actions, in production
   or close to it." (Live actions raise the value of the gate.)
2. "How many distinct AI surfaces, models, agents, AI-written code paths, do you
   think are in play." (Sizes the inventory and the per-surface scope.)
3. "Who governs what those agents are allowed to do today." (If the answer is
   "nobody," the gap is total and the value is highest.)
4. "Is anyone pushing you on AI compliance, SOC2, ISO 42001, the EU AI Act." (A
   live audit or a stalled deal is the strongest anchor there is.)
5. "If a customer asked you to prove what your AI did last month, could you." (The
   record-keeping gap, sells the ledger.)
6. "What would one ungoverned AI incident cost you." (Their own floor number.)
7. "Is this you, or you plus a security team and a compliance owner." (Sizes the
   engagement and the right tier.)

---

## How to talk price to a founder (without discounting reflexively)

You are a credible peer selling to a peer, not a vendor defending a list. Hold
that posture.

- **Anchor on the gap, then the program.** Say the cost of the problem first, the
  program second. Price stated after value lands cheap; stated cold sounds
  expensive.
- **Sell the program, not the seats.** "A 12-month governance program" is an
  outcome. "Per-agent licensing" invites a line-item negotiation you do not want
  yet.
- **The scan is free, the program is not.** Give away the diagnosis generously.
  Never give away the treatment to win the logo; a free program signals the work
  is worthless.
- **Do not discount to close, change scope to fit budget.** If the number is too
  big, drop from Better to Good or narrow the surface count. Same rate, smaller
  scope. Discounting the rate teaches them the price was never real.
- **Let silence do the work.** State the program and the value, then stop. The
  first person to talk after a price loses margin. You did this in consulting.
- **When they push on budget:** "the scan and the readout are free, so let us put
  a real risk number in front of whoever owns the budget. Governance gets funded
  when the gap is visible, not before." (This is the founder-gtm-playbook line;
  keep it consistent.)

---

## How to update this doc

After the first handful of programs close, replace the illustrative anchors with
the real numbers that landed and the scope shapes that customers actually bought.
Keep the wedge-then-program structure and the discovery questions fixed; they are
the framework. Update the tier table as the platform adds capabilities, mirroring
the capability list in pitch-kit.md so the two never drift.
