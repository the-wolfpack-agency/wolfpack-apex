/**
 * Onboarding preflight: verify a target is correctly configured and reachable
 * BEFORE running a real engagement, so a misconfiguration is caught by the
 * operator, not discovered in front of the client. Each check is non-destructive
 * (resolve config, one read-only GET, a repo listing, a credential presence
 * check). Critical checks gate readiness; non-critical ones are advisories.
 */
import { resolveScanTarget } from "./manifests";
import { discoverRepoFiles } from "./static/discover-files";
import { assertScannableUrl, SsrfBlockedError } from "./ssrf-guard";
import { loadConnectorCredentials } from "@/lib/assistant/connectors/credentials";

export interface PreflightCheck {
  name: string;
  pass: boolean;
  detail: string;
  /** A failed critical check means the target is not ready; advisories do not. */
  critical: boolean;
}

export interface PreflightResult {
  platform: string;
  ok: boolean;
  checks: PreflightCheck[];
}

export interface PreflightDeps {
  fetchImpl?: typeof fetch;
}

export async function runPreflight(
  workspaceId: string,
  platform: string,
  deps: PreflightDeps = {},
): Promise<PreflightResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const checks: PreflightCheck[] = [];
  const add = (name: string, pass: boolean, detail: string, critical = true) =>
    checks.push({ name, pass, detail, critical });

  const manifest = await resolveScanTarget(workspaceId, platform);
  if (!manifest) {
    add("target_resolved", false, "No curated, onboarded, or connector target for this platform.");
    return { platform, ok: false, checks };
  }
  add("target_resolved", true, `Resolved target at ${manifest.baseUrl}.`);

  // The target URL must be public (the SSRF floor) and reachable.
  let publicOk = true;
  try {
    await assertScannableUrl(manifest.baseUrl);
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      add("base_url_public", false, `Blocked as non-public: ${e.message}`);
      publicOk = false;
    } else {
      throw e;
    }
  }
  if (publicOk) {
    add("base_url_public", true, "Target URL is public (not an internal address).");
    try {
      const res = await fetchImpl(manifest.baseUrl, { method: "GET", redirect: "manual" });
      add("base_url_reachable", res.status > 0 && res.status < 500, `Target responded HTTP ${res.status}.`);
    } catch (err) {
      add("base_url_reachable", false, `Could not reach the target: ${(err as Error).message}`);
    }
  }

  // Static scan needs the repo to be readable (advisory: HTTP-only targets are fine).
  if (manifest.static) {
    try {
      const files = await discoverRepoFiles(manifest.static.owner, manifest.static.repo, manifest.static.ref);
      add(
        "repo_accessible",
        files.length > 0,
        files.length > 0
          ? `Discovered ${files.length} files in ${manifest.static.owner}/${manifest.static.repo}.`
          : "Repo returned no files (check the token scope or the owner/repo).",
        false,
      );
    } catch (err) {
      add("repo_accessible", false, `Repo not accessible: ${(err as Error).message}`, false);
    }
  }

  // A login-gated target needs connector credentials configured (keyed by the
  // login config's connector name, the same key the scan engine resolves auth by).
  if (manifest.login) {
    const creds = await loadConnectorCredentials(workspaceId, manifest.login.connectorName).catch(() => null);
    add(
      "login_credentials",
      !!creds,
      creds
        ? `Credentials for connector "${manifest.login.connectorName}" are configured.`
        : `Login is required but no credentials are configured for connector "${manifest.login.connectorName}".`,
    );
  }

  const ok = checks.filter((c) => c.critical).every((c) => c.pass);
  return { platform, ok, checks };
}
