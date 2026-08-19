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
  /** How you would prove it if asked in the room. */
  proof: string;
}

const CLAIMS: Claim[] = [
  {
    headline: "Most questions never reach an AI model at all",
    plain:
      "Your calendar, mail, records and documents are read directly. If the answer is already in your own systems, that is where it comes from: no model, no cost, and nothing sent outside.",
    proof: "The activity below counts the questions that did reach a model. It is a fraction of what people ask.",
  },
  {
    headline: "Nothing leaves without being checked",
    plain:
      "Every question that does go to a model passes one gate first. Passwords, keys, card and account numbers are found and replaced before the message leaves us, so the model never receives them and neither does the company that runs it.",
    proof: "The protection panel shows how many calls were checked, and what was withheld.",
  },
  {
    headline: "The same rules apply to every model, including ones we did not build",
    plain:
      "The gate sits between your data and whichever model answers. Swapping a model, adding a cheaper one, or trying a new provider changes nothing about what is allowed to leave, because the check happens on our side of the line.",
    proof: "The models list below shows several providers. All of them are behind the same gate.",
  },
  {
    headline: "The cheapest model that can do the job gets the job",
    plain:
      "Simple questions go to small, inexpensive models. Hard ones go to larger models. That decision is made by fixed rules rather than by another AI, so it is the same every time and can be explained afterwards.",
    proof: "The reasons panel names why each model was chosen, in plain words.",
  },
  {
    headline: "Every answer's real cost is recorded",
    plain:
      "Not an estimate: the amount the provider billed, per answer, per model. That is what makes the saving from choosing a smaller model a fact rather than a claim.",
    proof: "Total spent, above, and the per-model figures below it.",
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
          <p className="rx-proof">Where to point: {c.proof}</p>
        </div>
      ))}
    </div>
  );
}
