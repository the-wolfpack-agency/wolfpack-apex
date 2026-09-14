/**
 * AI data governance — the layer that sits next to a product Palo Alto already
 * sells (Prisma AIRS) and does the part AIRS does not: it governs the DATA path
 * into and out of a model, rather than securing the model at runtime.
 *
 * WHAT IS REAL HERE. Unlike the plain-language certification build, the capability
 * described on this page is not illustrative: it is real code running in our
 * inference router today (redaction, residency, retention, response-safety,
 * per-call provenance and audit). What is NOT real is any Palo Alto engagement,
 * and nothing on this page is measured. The banner and registry say exactly that.
 * Held as data so a test pins the shape.
 */

export const HEADLINE =
  "AIRS secures the AI at runtime. This governs the data path around it: what is allowed to reach a model, where inference runs, what is kept, and what comes back. It is the complement, not a competitor, and it already runs in our router.";

/** Where it sits, said plainly, so the seam with AIRS is obvious. */
export const SEAM =
  "Think of the model as a room people send information into and get answers out of. Prisma AIRS guards what happens inside the room. This governs the doorway: it decides what is allowed through the door, which room (region) it goes to, whether a copy is kept, and it checks what comes back out before it reaches anyone.";

export interface Control { name: string; jargon: string; plain: string; stops: string; without: string }

export const CONTROLS: Control[] = [
  {
    name: "Redaction before the model",
    jargon: "PII redaction, never-send classes",
    plain: "It strips sensitive data (names, account numbers, secrets) out of a request before it ever reaches a model, and some kinds of data are simply never allowed to be sent.",
    stops: "Sensitive data leaking to a model provider inside an ordinary prompt.",
    without: "Your secrets ride along in every request, wherever the model happens to run.",
  },
  {
    name: "Residency",
    jargon: "data residency",
    plain: "It forces the inference to happen in the region or environment your policy requires, so data is processed where it is allowed to be.",
    stops: "Data quietly crossing a border or boundary it was never cleared for.",
    without: "You do not actually know, or control, where your data was processed.",
  },
  {
    name: "Retention control",
    jargon: "zero-retention routing",
    plain: "It routes to providers that do not keep your prompts, and controls how long anything is kept on your own side.",
    stops: "Your prompts living on a vendor's servers indefinitely, outside your control.",
    without: "Your data is retained by someone else, on their terms, not yours.",
  },
  {
    name: "Response safety",
    jargon: "output inspection",
    plain: "It checks what the model sends back before it reaches a person, catching unsafe or leaking output.",
    stops: "A bad or data-leaking answer going straight to a user.",
    without: "Whatever the model says passes through unchecked.",
  },
  {
    name: "Provenance and audit",
    jargon: "per-call logging, provenance",
    plain: "Every call is recorded: what data went in, which model answered, and what it cost.",
    stops: "An unauditable black box nobody can reconstruct after the fact.",
    without: "No record of what the AI did, with what, or at what cost.",
  },
];

/** The honest boundary: real capability, not a shipped Palo Alto integration. */
export const WHATS_REAL = [
  "The controls above run in our inference router today; they are not a drawing.",
  "What is a concept is the Palo Alto framing: they are not a client, and nothing here is integrated with their stack.",
  "Feeding these signals into a dashboard like theirs is a known path (standard formats), not a built integration.",
];
