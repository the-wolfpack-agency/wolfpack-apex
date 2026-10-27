/**
 * Forcefield Edge - report what Edge saw into the same path as every other
 * Forcefield site (POST /api/site-analytics/ingest), so Edge traffic feeds the
 * tenant's board, alerts, operator fingerprints and the shared threat network.
 *
 * Authorized by the Edge service token plus the tenant id header; apex pins the
 * event to that tenant's site label (the body cannot pick another site).
 * Fire-and-forget: the caller hands the promise to waitUntil, and a failed or
 * slow ingest never affects the visitor's request.
 */
import { EDGE_TENANT_HEADER } from "./forcefield-web/gateway";
import type { Observation } from "./forcefield-web/observe";
import type { RequestIntent } from "./forcefield-web/monitor";

export interface ReportConfig {
  ingestUrl: string;
  serviceToken: string;
  fetchImpl?: typeof fetch;
}

/** The ingest body: the same shape monitor.ts and the Worker send. */
export function ingestBody(type: string, path: string, country: string, props: Record<string, string | number | boolean>): string {
  return JSON.stringify({ type, path, country: country || undefined, props });
}

export async function reportEdgeEvents(
  cfg: ReportConfig,
  tenantId: string,
  country: string,
  observation: Observation | null,
  intent: RequestIntent | null,
  path: string,
): Promise<void> {
  if (!cfg.ingestUrl || !cfg.serviceToken) return;
  const doFetch = cfg.fetchImpl ?? fetch;
  const send = (body: string) =>
    doFetch(cfg.ingestUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-token": cfg.serviceToken, [EDGE_TENANT_HEADER]: tenantId },
      body,
    }).then(
      () => undefined,
      () => undefined,
    );
  try {
    if (observation) await send(ingestBody(observation.type, observation.path, country, observation.props));
    if (intent?.report) await send(ingestBody("site.intent_scored", path, country, intent.props));
  } catch {
    /* best-effort */
  }
}
