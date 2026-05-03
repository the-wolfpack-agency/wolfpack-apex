/**
 * Debug-only endpoint: prove what provisioning actually does at runtime.
 *
 * When self-heal silently no-ops on a freshly-created client repo and
 * Vercel's function logs aren't handy, this route surfaces:
 *   - which env vars Instinct currently sees (prefixes only, never values)
 *   - the fingerprint of GITHUB_TOKEN_WOLFPACK_AGENCY so you can confirm
 *     the new PAT is actually in runtime (not the stale deployment)
 *   - the exact HTTP status + error body from GET /actions/secrets/public-key
 *     and from one attempted setRepoSecret call on a target repo
 *
 * Admin-gated (hr+). Never logs secret values. Query with:
 *   GET /api/sites/_debug/provision?repo=the-wolfpack-agency/wolfpack-test8
 *
 * Remove or admin-lock further before wider rollout — harmless by
 * default (read-only probe + one idempotent PUT) but still a capability
 * surface worth minimizing.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, hasRole } from "@/lib/auth";

interface ProbeResult {
  env: {
    GITHUB_TOKEN_WOLFPACK_AGENCY: string;
    VERCEL_TOKEN_WOLFPACK_AGENCY: string;
    VERCEL_ORG_ID: string;
    WOLFPACK_SITES_WEBHOOK_SECRET: string;
  };
  repo?: string;
  publicKey?: { status: number; ok: boolean; bodySnippet?: string };
  setSecret?: { status: number; ok: boolean; bodySnippet?: string };
}

function fingerprint(s: string | undefined): string {
  if (!s) return "<missing>";
  if (s.length < 10) return "<too-short>";
  return `${s.slice(0, 4)}...${s.slice(-4)} (len=${s.length})`;
}

export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasRole(user.role, "hr")) {
    return NextResponse.json({ error: "admin only" }, { status: 403 });
  }

  const repoRaw = req.nextUrl.searchParams.get("repo") ?? undefined;
  // Validate `repo` shape strictly so the URL we hand to fetch() can
  // only ever target api.github.com and only ever in the
  // `<owner>/<name>` slot. Refuses anything containing `/` outside that
  // single slash, schemes, query strings, or `..`. (CodeQL:
  // js/request-forgery — we hardcode the host + path prefix and let
  // only an allow-listed pattern fill in the trailing segment.)
  const repo =
    repoRaw && /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repoRaw)
      ? repoRaw
      : undefined;
  if (repoRaw && !repo) {
    return NextResponse.json(
      { error: "repo must match owner/name (alphanumerics, dot, dash, underscore)" },
      { status: 400 },
    );
  }

  const result: ProbeResult = {
    env: {
      GITHUB_TOKEN_WOLFPACK_AGENCY: fingerprint(process.env.GITHUB_TOKEN_WOLFPACK_AGENCY),
      VERCEL_TOKEN_WOLFPACK_AGENCY: fingerprint(process.env.VERCEL_TOKEN_WOLFPACK_AGENCY),
      VERCEL_ORG_ID: fingerprint(process.env.VERCEL_ORG_ID),
      WOLFPACK_SITES_WEBHOOK_SECRET: fingerprint(process.env.WOLFPACK_SITES_WEBHOOK_SECRET),
    },
  };

  if (!repo) return NextResponse.json(result);

  result.repo = repo;
  const token = process.env.GITHUB_TOKEN_WOLFPACK_AGENCY ?? "";

  // Probe 1: GET /actions/secrets/public-key — requires secrets:read
  // which a Classic PAT's `repo` scope grants. 200 means we can fetch
  // the key; 403/404 tells us exactly why self-heal is no-oping.
  try {
    const pk = await fetch(
      `https://api.github.com/repos/${repo}/actions/secrets/public-key`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "wolfpack-instinct-debug",
        },
      },
    );
    const text = await pk.text().catch(() => "");
    result.publicKey = {
      status: pk.status,
      ok: pk.ok,
      bodySnippet: text.slice(0, 200),
    };
  } catch (err) {
    result.publicKey = { status: 0, ok: false, bodySnippet: (err as Error).message.slice(0, 200) };
  }

  // Probe 2: attempt a throwaway setRepoSecret (named __PROBE_OK so
  // it's obvious in the UI and safe to delete manually). Writes the
  // literal string "probe" encrypted with the repo's public key.
  if (result.publicKey?.ok && result.publicKey.bodySnippet) {
    try {
      const { setRepoSecret } = await import("@/lib/github-secrets");
      const { defaultGithubClient } = await import("@/lib/github-client");
      await setRepoSecret(defaultGithubClient(), repo, "__PROBE_OK", "probe");
      result.setSecret = { status: 201, ok: true, bodySnippet: "wrote __PROBE_OK" };
    } catch (err) {
      const e = err as { status?: number; message?: string };
      result.setSecret = {
        status: e.status ?? 0,
        ok: false,
        bodySnippet: (e.message ?? "").slice(0, 200),
      };
    }
  }

  return NextResponse.json(result);
}
