/**
 * CustomerSuccessLoop: two diagrams for the "Customer success" wiki page.
 *
 * The first shows the path a client's problem takes at most software
 * companies: four handoffs between the person who feels it and the person who
 * can fix it, losing detail at each one and usually ending without the client
 * being told anything. The second shows the loop we build instead, where the
 * report and the fix live in the same system and nobody re-types anything.
 *
 * Pure HTML/CSS, matching AgenticQAPipeline: no diagram library, no SVG, no new
 * dependency, theme tokens only, and it reflows to one column on a phone.
 *
 * Each diagram carries its own aria-label describing the flow in words, because
 * a picture of an argument is useless to a screen reader and this page IS the
 * argument.
 */

interface Step {
  who: string;
  what: string;
  /** What is lost or gained on the way to the next step. */
  cost?: string;
}

/* The chain being argued against. Deliberately concrete: "weeks later" and
   "nobody tells the client" are the two parts everyone recognises. */
const TRADITIONAL: Step[] = [
  { who: "Client", what: "Hits something confusing", cost: "Describes it from memory, later" },
  { who: "CS manager", what: "Takes the call, writes it up", cost: "Context becomes prose" },
  { who: "Ticket queue", what: "Waits to be triaged", cost: "Days" },
  { who: "Product", what: "Prioritises against everything else", cost: "Detail drops out" },
  { who: "Engineering", what: "Fixes it, weeks later", cost: "Nobody tells the client" },
];

const CLOSED: Step[] = [
  { who: "Client", what: "Reports inside the product", cost: "Who, which org and which screen are already attached" },
  { who: "One queue", what: "The builder reads it as sent", cost: "No re-typing, no summary of a summary" },
  { who: "Builder", what: "Can stand where the client stands", cost: "Bounded, recorded, shown on screen" },
  { who: "Shipped", what: "The client sees the change", cost: "Reporting is worth doing again" },
];

export default function CustomerSuccessLoop() {
  return (
    <div className="csl" data-testid="customer-success-loop">
      <style>{`
        .csl {
          --gold: var(--wp-gold, #e8b528);
          --pass: var(--wp-success, #3fb950);
          --fail: var(--wp-error, #ef4444);
          --border: var(--wp-dark-border, rgba(255,255,255,0.12));
          --text: var(--wp-text, #e8eaed);
          --dim: var(--wp-text-muted, #9aa0aa);
          margin: 0.4rem 0 1.4rem;
          display: grid;
          gap: 1rem;
        }
        .csl-panel {
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1rem 1rem 1.15rem;
          background: rgba(255,255,255,0.015);
        }
        .csl-title {
          margin: 0 0 0.15rem;
          font-size: 0.95rem;
          font-weight: 700;
          color: var(--text);
        }
        .csl-sub {
          margin: 0 0 0.9rem;
          font-size: 0.82rem;
          color: var(--dim);
        }
        /* A GRID OF EXACTLY AS MANY COLUMNS AS THERE ARE STEPS.
           As a wrapping flex row, five steps broke after the fourth and left an
           arrow pointing at nothing at the end of the first line. A grid with a
           fixed column count cannot strand an arrow, because it does not wrap;
           on a phone it becomes one column and the arrows turn to face down. */
        .csl-flow {
          display: grid;
          grid-template-columns: repeat(var(--steps), minmax(0, 1fr));
          align-items: stretch;
          gap: 1.4rem;
        }
        .csl-step {
          position: relative;
          min-width: 0;
          border: 1px solid var(--border);
          border-left: 3px solid var(--edge, var(--dim));
          border-radius: 8px;
          padding: 0.55rem 0.65rem;
          background: rgba(255,255,255,0.03);
        }
        .csl-who {
          font-size: 0.78rem;
          font-weight: 700;
          color: var(--text);
        }
        .csl-what {
          margin-top: 0.15rem;
          font-size: 0.78rem;
          line-height: 1.35;
          color: var(--dim);
        }
        .csl-cost {
          margin-top: 0.4rem;
          font-size: 0.72rem;
          line-height: 1.3;
          color: var(--edge, var(--dim));
        }
        /* The arrow is decorative: the aria-label carries the sequence. Drawn
           in the gap by the step it follows, so there is no element to be left
           behind by a line break. */
        .csl-step:not(:last-child)::after {
          content: "→";
          position: absolute;
          right: -1rem;
          top: 50%;
          transform: translateY(-50%);
          color: var(--dim);
          font-size: 0.9rem;
          line-height: 1;
        }
        .csl-note {
          margin: 0.85rem 0 0;
          font-size: 0.78rem;
          line-height: 1.45;
          color: var(--dim);
          border-top: 1px solid var(--border);
          padding-top: 0.7rem;
        }
        .csl-note strong { color: var(--text); }
        @media (max-width: 700px) {
          .csl-flow { grid-template-columns: 1fr; gap: 1.5rem; }
          .csl-step:not(:last-child)::after {
            right: auto;
            left: 50%;
            top: auto;
            bottom: -1.15rem;
            transform: translateX(-50%) rotate(90deg);
          }
        }
      `}</style>

      <section
        className="csl-panel"
        role="img"
        aria-label="The traditional path: a client hits something confusing and describes it later from memory; a customer success manager writes it up, turning context into prose; it waits in a ticket queue for days; product prioritises it against everything else and detail drops out; engineering fixes it weeks later and nobody tells the client."
      >
        <p className="csl-title">The traditional path</p>
        <p className="csl-sub">
          Four handoffs between the person who feels the problem and the person who can fix it.
        </p>
        <div className="csl-flow" style={{ ["--steps" as string]: TRADITIONAL.length }}>
          {TRADITIONAL.map((s) => (
            <div className="csl-step" key={s.who} style={{ ["--edge" as string]: "var(--fail)" }}>
                <div className="csl-who">{s.who}</div>
                <div className="csl-what">{s.what}</div>
                {s.cost ? <div className="csl-cost">{s.cost}</div> : null}
            </div>
          ))}
        </div>
        <p className="csl-note">
          The failure is not any one step. It is that <strong>nothing returns to the client</strong>, so they
          learn that reporting things is pointless and stop. The company then concludes there are no problems.
        </p>
      </section>

      <section
        className="csl-panel"
        role="img"
        aria-label="The closed loop: the client reports inside the product with their identity, organisation and screen already attached; it lands in one queue the builder reads as sent, with no re-typing; the builder can open the client's workspace to see exactly what they see, bounded and recorded; the change ships and the client sees it, which makes reporting worth doing again."
      >
        <p className="csl-title">The closed loop</p>
        <p className="csl-sub">The report and the fix live in the same system, so there is nothing to hand off.</p>
        <div className="csl-flow" style={{ ["--steps" as string]: CLOSED.length }}>
          {CLOSED.map((s) => (
            <div className="csl-step" key={s.who} style={{ ["--edge" as string]: "var(--pass)" }}>
                <div className="csl-who">{s.who}</div>
                <div className="csl-what">{s.what}</div>
                {s.cost ? <div className="csl-cost">{s.cost}</div> : null}
            </div>
          ))}
        </div>
        <p className="csl-note">
          It closes because the last step reaches the first: the client sees the change they asked for. That is
          the whole mechanism. <strong>The same layer serves every client</strong>, so the eleventh costs no more
          process than the first.
        </p>
      </section>
    </div>
  );
}
