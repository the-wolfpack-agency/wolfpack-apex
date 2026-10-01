/** Shared card + label styling for the Site Analytics console panels. */
import type { CSSProperties } from "react";

export const card: CSSProperties = {
  background: "var(--wp-dark-surface, #1f1f22)",
  border: "1px solid var(--wp-dark-border, #333)",
  borderRadius: 8,
  padding: "1.1rem 1.2rem",
};
export const label: CSSProperties = {
  fontSize: "0.72rem",
  textTransform: "uppercase",
  letterSpacing: "0.03em",
  color: "var(--wp-text-muted, #9ca3af)",
};
