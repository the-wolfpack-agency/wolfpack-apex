/**
 * Command Center UI kit — the single source of the new dark-glass monitoring
 * visual language shared by the platform-scans, agents list, and agent detail
 * admin pages. Built entirely on the existing --wp-* tokens and the shared
 * StaggeredItem reveal motion. Pure presentational: no data fetching, no
 * analytics inside the kit (consuming pages own that).
 *
 * Reuse these primitives; do not duplicate them per page.
 */

export { ConsoleShell, default as ConsoleShellDefault } from "./ConsoleShell";
export type { ConsoleShellProps } from "./ConsoleShell";

export { GlassPanel, default as GlassPanelDefault } from "./GlassPanel";
export type { GlassPanelProps, GlassGlow } from "./GlassPanel";

export { MetricTile, default as MetricTileDefault } from "./MetricTile";
export type { MetricTileProps, MetricDelta } from "./MetricTile";

export { StatusPill, default as StatusPillDefault } from "./StatusPill";
export type { StatusPillProps } from "./StatusPill";

export { Sparkline, default as SparklineDefault } from "./Sparkline";
export type { SparklineProps } from "./Sparkline";

export { SectionHeader, default as SectionHeaderDefault } from "./SectionHeader";
export type { SectionHeaderProps } from "./SectionHeader";

export { ConsoleGrid, default as ConsoleGridDefault } from "./ConsoleGrid";
export type { ConsoleGridProps } from "./ConsoleGrid";

export { Stepper, default as StepperDefault } from "./Stepper";
export type { StepperProps, StepperStep, StepStatus } from "./Stepper";

// Shared severity vocabulary + count-up hook (importable by pages too).
export {
  toneForStatus,
  colorForStatus,
  TONE_VAR,
  type SeverityTone,
} from "./severity";
export { useCountUp, type UseCountUpOptions } from "./useCountUp";
