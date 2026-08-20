/**
 * What this thing is, for somebody who has to explain it to a client.
 *
 * Asked for on 2026-08-19: a section a non-technical team member can read and
 * then repeat in a meeting. So it is written to be SAID OUT LOUD, not skimmed:
 * short claims, each with the reason it is true, and no vocabulary that needs a
 * second explanation ("tier", "token", "chokepoint" all avoided in the copy).
 *
 * THE HARD RULE HERE IS HONESTY. Every claim below is something the product
 * does today and can be shown on this page. Nothing aspirational, because the
 * person repeating it will be asked "can you show me" by somebody who bought it
 * on that basis. The strongest line is deliberately not a big number: it is
 * that nothing reaches a model without being checked first.
 */

interface Claim {
  headline: string;
  plain: string;
  /**
   * The panel on THIS page that proves the claim, written as an instruction to
   * the reader. Originally labelled "Where to point", which readers took as
   * a direction to point at something physical rather than "here is your
   * evidence" (reported 2026-08-20).
   */
  proof: string;
}

const CLAIMS: Claim[] = [
  {
    headline: "Most questions never reach an AI model at all",
    plain:
      "Your calendar, mail, records and documents are read directly. If the answer is already in your own systems, that is where it comes from: no model, no cost, and nothing sent outside.",
    proof: "Scroll to Activity. It counts only the questions that did reach a model, which is a fraction of what people ask.",
  },
  {
    headline: "Nothing leaves without being checked, and nothing comes back unchecked",
    plain:
      "Every question that does go to a model passes a gate first: passwords, keys, card and account numbers are found and replaced before the message leaves us, so the model never receives them and neither does the company that runs it. The answer is checked the same way on the way back, because a model can repeat something it was shown, and an answer gets saved and read by the whole team.",
    proof: "Scroll to “What the router kept in”. It counts both directions: withheld on the way out, and withheld on the way back.",
  },
  {
    headline: "The same rules apply to every model, including ones we did not build",
    plain:
      "The gate sits between your data and whichever model answers. Swapping a model, adding a cheaper one, or trying a new provider changes nothing about what is allowed to leave, because the check happens on our side of the line.",
    proof: "Scroll to the models list. It names several providers, and every one of them sits behind the same gate.",
  },
  {
    headline: "Where a question may be answered is part of the question",
    plain:
      "A request can say which parts of the world its data may be processed in, and anything that cannot be placed inside one of them is refused. That is set per request rather than once in a settings screen, so the same team can send an ordinary question to the cheapest model anywhere and still refuse to let an employee record leave Europe, in the same minute, with nothing reconfigured. A model whose location nobody has recorded counts as a refusal, because the answer that ends badly is the one that begins with we assumed.",
    proof:
      "Scroll to the models list. Each model says the region it runs in, or says plainly that nobody has declared one.",
  },
  {
    headline: "The cheapest model that can do the job gets the job",
    plain:
      "Simple questions go to small, inexpensive models. Hard ones go to larger models. That decision is made by fixed rules rather than by another AI, so it is the same every time and can be explained afterwards.",
    proof: "Scroll to the reasons panel. It names why each model was chosen, in plain words.",
  },
  {
    headline: "Every answer's real cost is recorded",
    plain:
      "Not an estimate: the amount the provider billed, per answer, per model. That is what makes the saving from choosing a smaller model a fact rather than a claim.",
    proof: "Scroll to Activity. Total spent is the measured amount billed, and “Which models were used” breaks it down per model.",
  },
];

export default function RouterExplainer() {
  return (
    <div className="rx" data-testid="router-explainer">
      <style>{`
        .rx { display: grid; gap: 1.1rem; margin: 0.2rem 0 0.3rem; }
        .rx-claim {
          border-left: 2px solid var(--wp-gold, #e8b528);
          padding-left: 0.9rem;
        }
        .rx-head {
          margin: 0;
          font-size: 0.92rem;
          font-weight: 700;
          color: var(--wp-text, #e8eaed);
          line-height: 1.35;
        }
        .rx-plain {
          margin: 0.3rem 0 0;
          font-size: 0.84rem;
          line-height: 1.55;
          color: var(--wp-text-muted, #9aa0aa);
        }
        /* The line somebody needs when a client says "prove it". Quieter than
           the claim, because it is for the person speaking, not the room. */
        .rx-proof {
          margin: 0.35rem 0 0;
          font-size: 0.76rem;
          line-height: 1.45;
          color: var(--wp-text-muted, #7c828c);
          font-style: italic;
        }
      `}</style>
      {CLAIMS.map((c) => (
        <div className="rx-claim" key={c.headline}>
          <p className="rx-head">{c.headline}</p>
          <p className="rx-plain">{c.plain}</p>
          <p className="rx-proof">Proof on this page: {c.proof}</p>
        </div>
      ))}
    </div>
  );
}
