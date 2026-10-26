/**
 * Edge-device exposure over an existing platform-scan crawl.
 *
 * Wires the #1263 classifier into the HTTP platform-scan flow WITHOUT adding a
 * single request: it reads only the responses the verified crawl already
 * collected (status + headers per manifest route) and runs the offline
 * classifier over them. Findings land in the same store via recordScan.
 *
 * Fail-closed: checkEdgeExposureFloor (OFF by default, ownership-gated) runs
 * once before anything is classified. Precision-first: the crawled route is
 * never evidence (routeIsEvidence: false), so only a vendor-specific response
 * marker can match, and one finding is kept per product.
 *
 * This is outside-in exposure monitoring. It does not protect the appliance.
 */
import type { RouteObservation, ScanFinding } from "../types";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { classifyEdgeExposure } from "./classify";
import { checkEdgeExposureFloor, recordEdgeExposureAudit, type EdgeExposureDeps } from "./gate";

export interface CrawledResponse {
  route: string;
  obs: Pick<RouteObservation, "status" | "headers" | "networkError">;
}

export interface EdgeExposureCrawlInput {
  workspaceId: string;
  platform: string;
  actor: { userId: string; role: string };
  responses: readonly CrawledResponse[];
}

export type EdgeExposureCrawlResult =
  | { ran: true; findings: ScanFinding[] }
  | { ran: false; reason: string };

export async function runEdgeExposureOverCrawl(
  input: EdgeExposureCrawlInput,
  deps: EdgeExposureDeps = {},
): Promise<EdgeExposureCrawlResult> {
  const track = deps.track ?? trackEvent;
  const audit = deps.audit ?? recordAudit;

  const refused = await checkEdgeExposureFloor(input, deps);
  if (refused !== null) return { ran: false, reason: refused };

  const byProduct = new Map<string, ScanFinding>();
  for (const r of input.responses) {
    const s = r.obs.status;
    if (r.obs.networkError || s === undefined || s >= 400) continue;
    const found = classifyEdgeExposure(
      { route: r.route, status: s, headers: r.obs.headers },
      { routeIsEvidence: false },
    );
    for (const f of found) {
      const product = String(f.evidence.product ?? "");
      if (product && !byProduct.has(product)) byProduct.set(product, f);
    }
  }

  const findings = [...byProduct.values()];
  for (const f of findings) {
    track("platform.edge_exposure_detected", input.actor.userId, input.actor.role, {
      platform: input.platform,
      product: String(f.evidence.product ?? ""),
      vendor: String(f.evidence.vendor ?? ""),
      kev_count: Number(f.evidence.kev_count ?? 0),
      severity: f.severity,
    });
    await recordEdgeExposureAudit(audit, input, "detected", {
      product: f.evidence.product ?? null,
      kev_count: f.evidence.kev_count ?? 0,
      severity: f.severity,
    });
  }
  if (findings.length === 0) {
    await recordEdgeExposureAudit(audit, input, "clean", { responses: input.responses.length });
  }
  return { ran: true, findings };
}
