/**
 * RouterFlow: what happens to a question between typing it and reading the
 * answer, drawn for somebody who does not work on this.
 *
 * WHY IT EXISTS
 *
 * /admin/ai-router reported decisions, models and costs to a reader who had no
 * way to know what a "decision" was. Asked for on 2026-08-19: show the flow of
 * a prompt through the router to the right model, in a way a non-technical
 * person can follow.
 *
 * THE HONEST PART IS THE SECOND STEP. Most questions never reach a model at
 * all: they are answered from the workspace's own data by a deterministic tool,
 * at zero cost. A diagram showing every question going to a model would be
 * tidier and would misrepresent the product.
 *
 * Pure HTML/CSS, matching AgenticQAPipeline: no diagram library, no SVG, theme
 * tokens only, one column on a phone. The aria-label carries the whole flow in
 * words, because a picture of a process is nothing to a screen reader.
 */

interface Stage {
  title: string;
  detail: string;
  /** What leaves this stage, shown on the connector. */
  out?: string;
}

const STAGES: Stage[] = [
  {
    title: "You ask",
    detail: "A question typed into the assistant, with anything you attached.",
    out: "the question",
  },
  {
    title: "Answer it without a model?",
    detail:
      "Your calendar, mail, CRM and knowledge base are read directly first. Most questions stop here: no model, no cost.",
    out: "only what is left",
  },
  {
    title: "How much model does this need?",
    detail:
      "A fixed set of rules reads the question. A greeting needs very little. A question asking why something happened, or one carrying a document, needs a lot.",
    out: "a tier: cheap, standard or premium",
  },
  {
    title: "The router picks",
    detail:
      "Of the models we can actually reach, it takes the cheapest one that meets that tier. You can override it by naming a tier or a model in your message.",
    out: "one model",
  },
  {
    title: "The model answers",
    detail:
      "What it cost is recorded from the provider's own numbers, not estimated, and shown on this page.",
  },
];

export default function RouterFlow() {
  return (
    <div
      className="rf"
      data-testid="router-flow"
      role="img"
      aria-label="How a question is routed: you ask a question; the assistant first tries to answer it from your own data, and most questions stop there at no cost; what is left is measured by fixed rules to decide how capable a model it needs, producing a tier of cheap, standard or premium; the router then picks the cheapest available model that meets that tier, unless you named a tier or a model yourself; the model answers, and what it actually cost is recorded from the provider's own numbers."
    >
      <style>{`
        .rf {
          --line: var(--wp-dark-border, rgba(255,255,255,0.12));
          --text: var(--wp-text, #e8eaed);
          --dim: var(--wp-text-muted, #9aa0aa);
          --gold: var(--wp-gold, #e8b528);
          display: grid;
          gap: 0.9rem;
          margin: 0.2rem 0 0.4rem;
        }
        .rf-step {
          display: grid;
          grid-template-columns: 1.6rem 1fr;
          gap: 0.75rem;
          align-items: start;
        }
        .rf-num {
          width: 1.6rem;
          height: 1.6rem;
          border-radius: 999px;
          border: 1px solid var(--line);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.75rem;
          font-weight: 700;
          color: var(--gold);
        }
        .rf-title { font-size: 0.9rem; font-weight: 700; color: var(--text); }
        .rf-detail {
          margin: 0.2rem 0 0;
          font-size: 0.82rem;
          line-height: 1.5;
          color: var(--dim);
        }
        /* The connector states what moves on to the next step, which is what
           makes this read as a flow rather than a list. */
        .rf-out {
          margin: 0.45rem 0 0;
          padding-left: 0.9rem;
          border-left: 2px solid var(--line);
          font-size: 0.76rem;
          color: var(--gold);
        }
        @media (max-width: 560px) {
          .rf-step { grid-template-columns: 1fr; gap: 0.3rem; }
          .rf-num { display: none; }
        }
      `}</style>

      {STAGES.map((s, i) => (
        <div className="rf-step" key={s.title}>
          <div className="rf-num" aria-hidden="true">
            {i + 1}
          </div>
          <div>
            <div className="rf-title">{s.title}</div>
            <p className="rf-detail">{s.detail}</p>
            {s.out ? <p className="rf-out">↓ {s.out}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}
