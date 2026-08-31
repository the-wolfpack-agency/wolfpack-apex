/**
 * Per-client GitHub token resolution.
 *
 * THE FALLBACK GUARANTEE
 * ----------------------
 * resolveGithubToken(workspaceId) returns the workspace's short-lived GitHub
 * App INSTALLATION token when BOTH (a) the App is configured (GITHUB_APP_ID +
 * GITHUB_APP_PRIVATE_KEY) AND (b) the workspace has a linked installation row.
 * In EVERY other case - App env missing, no installation row, or ANY error
 * talking to GitHub - it returns process.env.GITHUB_TOKEN_WOLFPACK_AGENCY, the
 * exact PAT used today. It NEVER throws. This means our own curated Sites repos
 * (which have no installation row) keep working with the PAT unchanged, while a
 * client whose repos are reachable only via their App installation get a token
 * scoped to JUST their installation - no single shared credential with
 * cross-client blast radius.
 *
 * The installation token (~1h TTL) is cached per workspace until shortly before
 * expiry to avoid minting on every call.
 *
 * SECURITY: neither the App private key, the App JWT, nor the installation
 * token are ever logged. Failures log only a short reason string.
 */

import { readAppConfigFromEnv, signAppJwt, type AppJwtConfig } from "./jwt";
import { getInstallation } from "./storage";
import type { GithubInstallation } from "./storage";

/** Refresh the cached installation token this many ms BEFORE its real expiry,
 *  so an in-flight request never races the token going stale. */
const EXPIRY_SKEW_MS = 60_000; // 1 minute

interface CachedToken {
  token: string;
  /** Effective expiry (real expiry minus skew), ms since epoch. */
  effectiveExpiresAtMs: number;
}

/** Module-level cache keyed by workspace. Survives across requests in the same
 *  serverless instance; cold starts simply re-mint. */
const tokenCache = new Map<string, CachedToken>();

export interface ResolveDeps {
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable clock (ms) for tests. Defaults to Date.now. */
  now?: () => number;
  /** Override the App config (tests). Defaults to readAppConfigFromEnv(). */
  appConfig?: AppJwtConfig | null;
  /** Override installation lookup (tests). Defaults to getInstallation. */
  loadInstallation?: (workspaceId: string) => Promise<GithubInstallation | null>;
}

interface AccessTokenResponse {
  token?: unknown;
  expires_at?: unknown;
}

/**
 * Exchange the App JWT for a workspace's installation token. Returns null on
 * ANY failure (no App config, no installation, GitHub non-2xx, network error,
 * malformed body) so the caller falls back to the PAT. Caches the token until
 * shortly before expiry.
 *
 * Exported separately from resolveGithubToken so it is unit-testable in
 * isolation and so other call sites that specifically want an installation
 * token (no PAT fallback) can use it.
 */
export async function mintInstallationToken(
  workspaceId: string,
  deps: ResolveDeps = {},
): Promise<string | null> {
  const now = deps.now ?? Date.now;
  const nowMs = now();

  // Serve a still-fresh cached token.
  const cached = tokenCache.get(workspaceId);
  if (cached && cached.effectiveExpiresAtMs > nowMs) {
    return cached.token;
  }

  const appConfig =
    deps.appConfig !== undefined ? deps.appConfig : readAppConfigFromEnv();
  if (!appConfig) return null;

  const loadInstallation = deps.loadInstallation ?? getInstallation;
  let installation: GithubInstallation | null;
  try {
    installation = await loadInstallation(workspaceId);
  } catch (err) {
    console.warn(
      "[github-app] installation lookup failed:",
      (err as Error).message,
    );
    return null;
  }
  if (!installation) return null;

  const doFetch = deps.fetchImpl ?? fetch;

  let appJwt: string;
  try {
    appJwt = signAppJwt(appConfig, { now });
  } catch (err) {
    // Bad/malformed private key, etc. Fall back; never leak key material.
    console.warn("[github-app] App JWT signing failed:", (err as Error).message);
    return null;
  }

  try {
    const res = await doFetch(
      `https://api.github.com/app/installations/${encodeURIComponent(
        installation.installationId,
      )}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${appJwt}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "wolfpack-instinct-github-app",
        },
      },
    );
    if (!res.ok) {
      console.warn(
        `[github-app] installation token exchange returned ${res.status} for workspace ${workspaceId}`,
      );
      return null;
    }
    const body = (await res.json()) as AccessTokenResponse;
    if (typeof body.token !== "string" || body.token.length === 0) {
      console.warn("[github-app] installation token response missing token");
      return null;
    }
    const token = body.token;
    // expires_at is an ISO timestamp ~1h out. Parse defensively.
    let expiresAtMs = nowMs + 30 * 60 * 1000; // conservative default: 30m
    if (typeof body.expires_at === "string") {
      const parsed = Date.parse(body.expires_at);
      if (!Number.isNaN(parsed)) expiresAtMs = parsed;
    }
    tokenCache.set(workspaceId, {
      token,
      effectiveExpiresAtMs: expiresAtMs - EXPIRY_SKEW_MS,
    });
    return token;
  } catch (err) {
    console.warn(
      "[github-app] installation token exchange failed:",
      (err as Error).message,
    );
    return null;
  }
}

/**
 * Resolve the GitHub token to use for a workspace's GitHub operations.
 *
 * Returns the installation token when the App is configured AND the workspace
 * has a linked installation AND the exchange succeeds; OTHERWISE returns the
 * existing PAT (GITHUB_TOKEN_WOLFPACK_AGENCY, possibly empty in dev). NEVER
 * throws.
 */
export async function resolveGithubToken(
  workspaceId: string | null | undefined,
  deps: ResolveDeps = {},
): Promise<string> {
  const pat = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY ?? "";
  if (!workspaceId) return pat;
  try {
    const installationToken = await mintInstallationToken(workspaceId, deps);
    return installationToken ?? pat;
  } catch (err) {
    // Defense in depth - mintInstallationToken already never throws, but if it
    // ever did, we must still degrade to the PAT.
    console.warn(
      "[github-app] resolveGithubToken fell back to PAT:",
      (err as Error).message,
    );
    return pat;
  }
}

/** Test/maintenance helper: drop the cached installation token(s). */
export function __clearTokenCache(workspaceId?: string): void {
  if (workspaceId) tokenCache.delete(workspaceId);
  else tokenCache.clear();
}
