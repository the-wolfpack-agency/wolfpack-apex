/**
 * OGIAM brand tokens for the Factory Chat surface (ogiam.com): antique-brass gold
 * signal on a bone-dark ground, Geist type, a layered gold+blue glow over a faint
 * grid. The "neon-outline" treatment (glowing 1px borders) is kept - rendered in
 * the brand gold, not cyan. Single source so the standalone Code Factory repo
 * carries the identity. Status colors are semantic, distinct from the gold accent.
 */
export const NEON = {
  accent: "#e8b528",          // signal - antique brass gold (OGIAM primary accent)
  accentDim: "rgba(232,181,40,0.35)",
  accentInk: "#1a1505",       // text on a gold fill
  ground: "#0b0d11",          // bone - page base
  deep: "#070809",            // darker contrast
  surface: "rgba(18,21,28,0.72)", // card surface (glass)
  hairline: "rgba(255,255,255,0.08)",
  text: "#e9edf4",            // ink
  textDim: "#929cad",         // muted
  blueGlow: "rgba(106,166,255,0.05)",
  goldGlow: "rgba(232,181,40,0.06)",
  clear: "#22e5a4",           // checkpoint cleared (green)
  blocked: "#ff5c7a",         // blocked (red)
  held: "#e8b528",            // held / awaiting a human (brand gold)
  pending: "#3a4452",         // not yet reached
  /** Brand font stacks (Geist on the site; safe fallbacks when the var is absent). */
  fontSans: "var(--font-geist-sans, ui-sans-serif, system-ui, -apple-system, sans-serif)",
  fontMono: "var(--font-geist-mono, ui-monospace, SFMono-Regular, Menlo, monospace)",
} as const;

export const neonBorder = (color: string): string => `1px solid ${color}`;
/** A brand-gold-friendly box-shadow glow for `color` (hex). */
export const neonGlow = (color: string): string => `0 0 6px ${color}, 0 0 18px ${color}40`;

/** The OGIAM layered background: gold (top-right) + blue (top-left) glows over a
 *  faint 56px grid on the bone base. Reused by the route shell. */
export const BRAND_BACKGROUND =
  "radial-gradient(820px 540px at 82% -10%, rgba(232,181,40,0.05), transparent 58%)," +
  "radial-gradient(680px 520px at -6% 8%, rgba(106,166,255,0.05), transparent 55%)," +
  "linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px) 0 0 / 100% 56px," +
  "linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px) 0 0 / 56px 100%," +
  "#0b0d11";
