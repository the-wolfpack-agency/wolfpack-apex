/**
 * AgenticQAPipeline: a self-contained flow diagram of the AgenticQA CI/CD
 * pipeline, for the "Testing and quality" wiki page. Pure HTML/CSS (no diagram
 * library, no SVG, no new dependency), theme-token styled, responsive.
 *
 * It shows the input -> output path a change travels, the gate at each step,
 * and the single rule that makes it safe: a failure at ANY gate stops the
 * change cold (it never merges, deploys, or reaches production) and returns it
 * to its author. Deterministic tooling, not opinion, makes each call.
 */

interface Stage {
  n: number;
  name: string;
  checks: string;
  /** Optional emphasis note under the checks. */
  note?: string;
}

const STAGES: Stage[] = [
  {
    n: 1,
    name: "Local verify",
    checks: "One shared script runs lint, type-check, tests, and a production build.",
    note: "The same checks CI runs, so a green local run predicts a green CI run.",
  },
  {
    n: 2,
    name: "Pull request opened",
    checks: "The change is proposed as a pull request, by a person or an AI agent.",
  },
  {
    n: 3,
    name: "CI gate",
    checks: "The full suite re-runs on a clean machine: contract, database, unit, UI, and end-to-end tests, plus a build.",
    note: "This is the real gate, not the local run.",
  },
  {
    n: 4,
    name: "Security & dependencies",
    checks: "A static security scan and a dependency-vulnerability audit.",
  },
  {
    n: 5,
    name: "Human review",
    checks: "A person reviews the change and approves the merge.",
  },
  {
    n: 6,
    name: "Deploy",
    checks: "Automatic on merge for most systems.",
  },
  {
    n: 7,
    name: "Live verification",
    checks: "Confirm the new version is serving and the page renders correctly on the real URL, including mobile.",
  },
];

export default function AgenticQAPipeline() {
  return (
    <div className="aqa" data-testid="agenticqa-pipeline" role="img"
      aria-label="AgenticQA pipeline flow: a change passes seven gates from local verify to live verification; a failure at any gate blocks it and returns it to the author, so it never reaches production.">
      <style>{`
        .aqa {
          --pass: var(--wp-success, #3fb950);
          --fail: var(--wp-error, #ef4444);
          --gold: var(--wp-gold, #e8b528);
          --surface: var(--wp-dark-surface, rgba(255,255,255,0.04));
          --border: var(--wp-dark-border, rgba(255,255,255,0.12));
          --text: var(--wp-text, #e8eaed);
          --dim: var(--wp-text-muted, #9aa0aa);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 1.1rem 1rem 1.3rem;
          margin: 0.4rem 0 1.4rem;
          background: rgba(255,255,255,0.015);
        }
        .aqa-legend {
          display: flex; flex-wrap: wrap; gap: 0.4rem 1rem;
          margin-bottom: 1rem; font-size: 0.8rem; color: var(--dim);
        }
        .aqa-legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
        .aqa-dot { width: 0.7rem; height: 0.7rem; border-radius: 50%; flex: 0 0 auto; }
        .aqa-terminal {
          display: flex; align-items: center; gap: 0.6rem;
          border-radius: 10px; padding: 0.7rem 0.9rem; font-weight: 700;
          border: 1px solid var(--border); background: var(--surface); color: var(--text);
        }
        .aqa-terminal .aqa-tag {
          font-size: 0.68rem; letter-spacing: 0.06em; text-transform: uppercase;
          color: var(--dim); font-weight: 700;
        }
        .aqa-arrow {
          display: flex; justify-content: center; align-items: center;
          color: var(--pass); font-size: 0.95rem; line-height: 1; padding: 0.28rem 0;
        }
        .aqa-arrow span {
          font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase;
          color: var(--pass); font-weight: 700; margin-left: 0.4rem;
        }
        .aqa-stage {
          display: grid; grid-template-columns: 2rem 1fr auto; gap: 0.7rem;
          align-items: start;
          border: 1px solid var(--border); border-radius: 10px;
          padding: 0.7rem 0.85rem; background: var(--surface);
        }
        .aqa-badge {
          width: 1.7rem; height: 1.7rem; border-radius: 50%;
          display: flex; align-items: center; justify-content: center;
          background: rgba(232,181,40,0.14); color: var(--gold);
          font-weight: 800; font-size: 0.85rem; border: 1px solid rgba(232,181,40,0.4);
        }
        .aqa-stage h4 { margin: 0.15rem 0 0.2rem; font-size: 0.95rem; font-weight: 700; color: var(--text); }
        .aqa-stage p { margin: 0; font-size: 0.84rem; line-height: 1.5; color: var(--dim); }
        .aqa-stage p.aqa-note { margin-top: 0.3rem; color: var(--gold); font-size: 0.78rem; }
        .aqa-fail-chip {
          align-self: center;
          white-space: nowrap; font-size: 0.66rem; font-weight: 700;
          letter-spacing: 0.04em; text-transform: uppercase;
          color: var(--fail); border: 1px solid rgba(239,68,68,0.4);
          background: rgba(239,68,68,0.08); border-radius: 999px; padding: 0.2rem 0.5rem;
        }
        .aqa-input .aqa-badge { background: rgba(255,255,255,0.06); color: var(--text); border-color: var(--border); }
        .aqa-success { border-color: rgba(63,185,80,0.5); background: rgba(63,185,80,0.08); }
        .aqa-success .aqa-mark { color: var(--pass); font-size: 1.1rem; }
        .aqa-outcomes { display: grid; gap: 0.7rem; margin-top: 1rem; }
        .aqa-blocked {
          border: 1px solid rgba(239,68,68,0.5); background: rgba(239,68,68,0.08);
          border-radius: 10px; padding: 0.8rem 0.9rem;
        }
        .aqa-blocked h4 { margin: 0 0 0.3rem; color: var(--fail); font-size: 0.9rem; font-weight: 800;
          display: flex; align-items: center; gap: 0.45rem; }
        .aqa-blocked p { margin: 0; font-size: 0.83rem; line-height: 1.55; color: var(--dim); }
        @media (max-width: 460px) {
          .aqa-stage { grid-template-columns: 1.7rem 1fr; }
          .aqa-fail-chip { grid-column: 2; justify-self: start; margin-top: 0.1rem; }
        }
      `}</style>

      <div className="aqa-legend">
        <span><span className="aqa-dot" style={{ background: "var(--pass)" }} /> Pass = the change continues to the next gate</span>
        <span><span className="aqa-dot" style={{ background: "var(--fail)" }} /> Fail = the change is stopped and returned</span>
      </div>

      <div className="aqa-terminal aqa-input">
        <span className="aqa-badge" aria-hidden="true">▶</span>
        <div>
          <div className="aqa-tag">Input</div>
          A change is proposed (by a person or an AI agent)
        </div>
      </div>

      {STAGES.map((s) => (
        <div key={s.n}>
          <div className="aqa-arrow" aria-hidden="true">▼<span>pass</span></div>
          <div className="aqa-stage">
            <span className="aqa-badge" aria-hidden="true">{s.n}</span>
            <div>
              <h4>{s.name}</h4>
              <p>{s.checks}</p>
              {s.note ? <p className="aqa-note">{s.note}</p> : null}
            </div>
            <span className="aqa-fail-chip" aria-hidden="true">✕ fail &rarr; blocked</span>
          </div>
        </div>
      ))}

      <div className="aqa-arrow" aria-hidden="true">▼<span>pass</span></div>
      <div className="aqa-terminal aqa-success">
        <span className="aqa-mark" aria-hidden="true">✓</span>
        <div>
          <div className="aqa-tag">Output</div>
          Live in production, verified
        </div>
      </div>

      <div className="aqa-outcomes">
        <div className="aqa-blocked">
          <h4><span aria-hidden="true">✕</span> If any gate fails</h4>
          <p>
            The change stops immediately. It does not merge, does not deploy, and never reaches
            production. It is returned to its author with the exact failure so it can be fixed and
            run through the gates again. The decision is made by deterministic tooling, not opinion,
            so the same input always gets the same verdict, and bad code cannot slip through.
          </p>
        </div>
      </div>
    </div>
  );
}
