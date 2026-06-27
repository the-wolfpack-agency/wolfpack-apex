/**
 * Stored client scan targets: the onboarding spine. A full ScanManifest per
 * (workspace, platform), so a client system is onboarded by registering its
 * config (deployed URL, repo for static + remediation, routes, API endpoints,
 * login) rather than editing curated code. resolveScanTarget reads these, so
 * every capability (scan / profile / recommend / report / pentest) works against
 * an onboarded client with no code change.
 */
import net from "node:net";
import { safeQuery, writeQuery } from "@/lib/db";
import { isPrivateIp } from "./ssrf-guard";
import type { ScanManifest } from "./manifests";

export interface ValidatedTarget {
  ok: true;
  manifest: ScanManifest;
}
export interface InvalidTarget {
  ok: false;
  error: string;
}

/** Validate + normalize onboarding input into a ScanManifest. Pure: no I/O.
 *  baseUrl must be a public http(s) URL (an internal/loopback target is rejected
 *  by the SSRF guard at scan time too, but we reject the obvious cases here). */
export function validateScanTargetInput(input: unknown): ValidatedTarget | InvalidTarget {
  if (!input || typeof input !== "object") return { ok: false, error: "body_required" };
  const x = input as Record<string, unknown>;

  const baseUrl = typeof x.baseUrl === "string" ? x.baseUrl.trim() : "";
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return { ok: false, error: "baseUrl_invalid" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "baseUrl_scheme" };
  // Reject an obvious internal/loopback/metadata IP literal at registration time
  // (defense in depth: the SSRF guard also blocks it at scan/probe execution,
  // incl. hostnames that resolve to a private IP, but failing fast here is clearer).
  const hostLiteral = url.hostname.toLowerCase();
  if (net.isIP(hostLiteral) && isPrivateIp(hostLiteral)) return { ok: false, error: "baseUrl_private" };

  // routes: array of { path, journey, auth }
  const routes = Array.isArray(x.routes) ? x.routes : [];
  for (const r of routes) {
    const rr = r as Record<string, unknown>;
    if (typeof rr.path !== "string" || !rr.path.startsWith("/")) return { ok: false, error: "route_path_invalid" };
    if (rr.auth !== "required" && rr.auth !== "public") return { ok: false, error: "route_auth_invalid" };
    if (typeof rr.journey !== "string") return { ok: false, error: "route_journey_invalid" };
  }

  // static repo target (optional): { owner, repo, ref?, paths? }
  let staticTarget: ScanManifest["static"];
  if (x.static && typeof x.static === "object") {
    const s = x.static as Record<string, unknown>;
    if (typeof s.owner !== "string" || typeof s.repo !== "string") return { ok: false, error: "static_invalid" };
    staticTarget = {
      owner: s.owner,
      repo: s.repo,
      ref: typeof s.ref === "string" ? s.ref : undefined,
      paths: Array.isArray(s.paths) ? (s.paths as unknown[]).filter((p): p is string => typeof p === "string") : [],
    };
  }

  const manifest: ScanManifest = {
    baseUrl,
    routes: routes as ScanManifest["routes"],
    ...(staticTarget ? { static: staticTarget } : {}),
    ...(Array.isArray(x.apiEndpoints) ? { apiEndpoints: x.apiEndpoints as ScanManifest["apiEndpoints"] } : {}),
    ...(x.login && typeof x.login === "object" ? { login: x.login as ScanManifest["login"] } : {}),
  };
  return { ok: true, manifest };
}

export async function saveScanTarget(
  workspaceId: string,
  platform: string,
  manifest: ScanManifest,
  createdBy: string,
): Promise<void> {
  await writeQuery(
    `INSERT INTO instinct_scan_targets (workspace_id, platform, manifest, created_by)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (workspace_id, platform) DO UPDATE SET
       manifest = EXCLUDED.manifest, is_active = true, updated_at = NOW()`,
    [workspaceId, platform, JSON.stringify(manifest), createdBy],
  );
}

interface DbRow {
  platform: string;
  manifest: ScanManifest | string;
  is_active: boolean;
}

export async function getStoredScanTarget(workspaceId: string, platform: string): Promise<ScanManifest | null> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT platform, manifest, is_active FROM instinct_scan_targets
      WHERE workspace_id = $1 AND platform = $2 AND is_active = true LIMIT 1`,
    [workspaceId, platform],
  );
  if (!rows[0]) return null;
  const m = rows[0].manifest;
  return typeof m === "string" ? (JSON.parse(m) as ScanManifest) : m;
}

export async function listStoredTargets(
  workspaceId: string,
): Promise<{ platform: string; manifest: ScanManifest }[]> {
  const { rows } = await safeQuery<DbRow>(
    `SELECT platform, manifest, is_active FROM instinct_scan_targets
      WHERE workspace_id = $1 AND is_active = true ORDER BY platform`,
    [workspaceId],
  );
  return rows.map((r) => ({
    platform: String(r.platform),
    manifest: typeof r.manifest === "string" ? (JSON.parse(r.manifest) as ScanManifest) : r.manifest,
  }));
}

/** Soft-remove (deactivate) an onboarded target. Returns true if one was active. */
export async function removeScanTarget(workspaceId: string, platform: string): Promise<boolean> {
  const { rows } = await writeQuery<{ platform: string }>(
    `UPDATE instinct_scan_targets SET is_active = false, updated_at = NOW()
      WHERE workspace_id = $1 AND platform = $2 AND is_active = true RETURNING platform`,
    [workspaceId, platform],
  );
  return rows.length > 0;
}
