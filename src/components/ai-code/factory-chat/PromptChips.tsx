"use client";
/**
 * The prompt-chip strip: neon-outline chips that seed the composer with the kinds
 * of work the factory does (the FDOS prompt-registry pattern). Clicking a chip
 * calls onPick with its seed prompt.
 */
import { PROMPT_CHIPS, type PromptChip } from "./chips";
import { NEON } from "./neon";

export default function PromptChips({ onPick }: { onPick: (chip: PromptChip) => void }): React.ReactElement {
  return (
    <div data-testid="prompt-chips" style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
      {PROMPT_CHIPS.map((c) => (
        <button
          key={c.id}
          type="button"
          data-testid={`chip-${c.id}`}
          title={c.hint}
          onClick={() => onPick(c)}
          style={{
            background: "transparent",
            border: `1px solid ${NEON.accentDim}`,
            color: NEON.text,
            borderRadius: 999,
            padding: "0.35rem 0.8rem",
            fontSize: "0.78rem",
            cursor: "pointer",
            transition: "border-color 120ms, box-shadow 120ms",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = NEON.accent; e.currentTarget.style.boxShadow = `0 0 10px ${NEON.accent}55`; }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = NEON.accentDim; e.currentTarget.style.boxShadow = "none"; }}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
