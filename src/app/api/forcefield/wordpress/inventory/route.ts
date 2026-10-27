/**
 * POST /api/forcefield/wordpress/inventory - the WordPress plugin reports the
 * server's software versions (on link, then daily via WP-Cron).
 *
 * PUBLIC: no apex session. Authorized by the site key the plugin holds, in the
 * x-edge-token header (the same credential and header the plugin sends to the
 * engine). The site key is resolved by its hash to an ACTIVE tenant. A signed
 * dashboard session is a read-only credential and is refused (403); an unknown,
 * disabled or missing key is 401.
 *
 * Body: { phpVersion, wordpressVersion, serverSoftware?, plugins: [{ slug, version }], pluginVersion? }
 * and nothing else (unknown fields are refused, so no other site data rides along).
 *
 * 200 { ok, status, exposed, unknown } | 400 invalid | 401 | 403 | 413 | 429 | 503. Never 500.
 * Each report is audited and tracked (forcefield.server_inventory_received); each
 * newly found exposure is audited and tracked (forcefield.server_exposure_found)
 * and emailed once to the confirmed alert address (build-phase allowlist applies).
 */
import { NextRequest, NextResponse } from "next/server";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { resolveTenantCredential } from "@/lib/forcefield-web/dashboard-session";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { receiveServerInventory } from "@/lib/forcefield-web/server-inventory";
import { phpLine } from "@/lib/forcefield-web/server-exposure";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const INVENTORY_LIMIT = 30;
const INVENTORY_WINDOW_MS = 60 * 60 * 1000;
const noStore = { "Cache-Control": "no-store" };

// PUBLIC: no session exists; the site key in x-edge-token is the credential (see the file header).
export async function POST(req: NextRequest): Promise<NextResponse> {
  const cred = await resolveTenantCredential(req.headers.get("x-edge-token") ?? "");
  if (!cred) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401, headers: noStore });
  if (cred.via !== "ingest") return NextResponse.json({ ok: false, error: "site_key_required" }, { status: 403, headers: noStore });
  const tenant = cred.tenant;

  const limited = await checkRateLimit(`forcefield:inventory:${tenant.id}`, { limit: INVENTORY_LIMIT, windowMs: INVENTORY_WINDOW_MS }).catch(() => ({ ok: true }));
  if (!limited.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { ...noStore, "Retry-After": String(INVENTORY_WINDOW_MS / 1000) } });
  }

  const text = await req.text().catch(() => "");
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return NextResponse.json({ ok: false, error: "too_large" }, { status: 413, headers: noStore });
  let raw: unknown = null;
  try { raw = JSON.parse(text); } catch { raw = null; }

  const r = await receiveServerInventory({ id: tenant.id, siteLabel: tenant.siteLabel }, raw);
  if (r.reason === "invalid") return NextResponse.json({ ok: false, error: "invalid_request", detail: r.error }, { status: 400, headers: noStore });
  if (!r.ok || !r.report) return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503, headers: noStore });

  const report = r.report;
  const exposed = report.findings.filter((f) => f.state === "exposed");
  const unknown = report.findings.filter((f) => f.state === "unknown");
  const meta = extractRequestMetadata(req);
  const actor = { user_id: `forcefield_tenant:${tenant.id}`, role: "tenant" };
  const php = r.inventory ? phpLine(r.inventory) : "unknown";

  await recordAudit({
    actor,
    action: "forcefield.server_inventory_received",
    resourceType: "forcefield_tenant",
    resourceId: tenant.id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { status: report.status, exposed: exposed.map((f) => f.key), unknown: unknown.map((f) => f.key), phpLine: php },
  }).catch(() => {});
  trackEvent("forcefield.server_inventory_received", actor.user_id, "tenant", {
    tenant_id: tenant.id,
    status: report.status,
    php_line: php,
    exposed: exposed.length,
    unknown: unknown.length,
    plugins: report.otherPlugins + report.findings.filter((f) => f.product === "wordpress_plugin").length,
  });

  for (const f of r.newExposures ?? []) {
    await recordAudit({
      actor,
      action: "forcefield.server_exposure_found",
      resourceType: "forcefield_tenant",
      resourceId: tenant.id,
      ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
      afterState: { key: f.key, product: f.product, installed: f.installed, fixedVersion: f.fixedVersion, cves: f.cves, alert: r.alert ?? "none" },
    }).catch(() => {});
    trackEvent("forcefield.server_exposure_found", actor.user_id, "tenant", {
      tenant_id: tenant.id,
      rule: f.ruleId ?? "",
      product: f.product,
      installed: f.installed ?? "",
      fixed: f.fixedVersion ?? "",
      cve: f.cves.join(","),
      alert: r.alert ?? "none",
    });
  }

  return NextResponse.json({ ok: true, status: report.status, exposed: exposed.length, unknown: unknown.length }, { headers: noStore });
}
