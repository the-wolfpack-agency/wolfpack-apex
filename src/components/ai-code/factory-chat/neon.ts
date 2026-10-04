/** Shared neon palette for the Factory Chat surface. Single source so the standalone
 *  repo extraction keeps one look. Status colors are semantic, distinct from the accent. */
export const NEON = {
  accent: "#22d3ee",          // electric cyan - the outline accent
  accentDim: "rgba(34,211,238,0.35)",
  ground: "#0a0b0f",
  surface: "rgba(16,20,28,0.7)",
  text: "#e6f6fb",
  textDim: "#8aa0ab",
  clear: "#22e5a4",           // checkpoint cleared (neon green)
  blocked: "#ff5c7a",         // blocked (neon red)
  held: "#f5b84b",            // held / pending (amber)
  pending: "#3a4452",         // not yet reached
} as const;

export const neonBorder = (color: string): string => `1px solid ${color}`;
/** A neon box-shadow glow for `color` (hex). */
export const neonGlow = (color: string): string => `0 0 6px ${color}, 0 0 18px ${color}40`;
