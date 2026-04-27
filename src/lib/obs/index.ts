/**
 * src/lib/obs — public API barrel.
 *
 * Usage:
 *   import { getObsClient } from "@/lib/obs";
 *   const obs = getObsClient();
 *   await obs.wrap("cron.support.poll", () => doWork(), { source: "cron" });
 */

export { getObsClient, ObsClient, _resetObsClientForTests } from "./router";
export { ConsoleBackend } from "./console-backend";
export { AppInsightsBackend } from "./app-insights-backend";
export type {
  ObservabilityBackend,
  Span,
  SpanAttributes,
  SpanAttributeValue,
  SpanError,
  SpanHandle,
  SpanStatus,
} from "./types";
export { NotImplementedError } from "./types";
