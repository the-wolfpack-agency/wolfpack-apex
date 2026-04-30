/**
 * GET /api/assistant/grounding-debug?q=<urlencoded question>
 *
 * Self-service one-shot diagnostic for "the assistant says it doesn't have
 * access to my SharePoint/Mail/Calendar".
 *
 * Combines THREE diagnostic signals into one response so the
 * /admin/assistant-debug page can render the full picture without
 * fan-out:
 *   1. Token introspection — decode the user's stored Microsoft access
 *      token and surface the `scp` claim. This is the single most useful
 *      signal: if Sites.Read.All isn't in the token, SharePoint will 403
 *      no matter what the Azure portal says.
 *   2. Live Graph probes — issue a few cheap, bounded GET/POST requests
 *      against Graph using the user's token. We capture HTTP status,
 *      whether it's a scope_missing 403, and (for 200s) a count of
 *      results. Probes mirror the resolver's actual call sites so users
 *      see what the resolver sees.
 *   3. getRelevantContext bundle — re-runs the resolver with the
 *      caller's question (defaults to the test case the user keeps
 *      failing on) and returns the bundle so users can confirm where
 *      grounding falls apart.
 *
 * Auth: Bearer token from /api/assistant (existing pattern). The
 * dashboard page hits this endpoint with `fetchWithRefresh` which
 * reads localStorage Bearer + auto-refreshes on 401, so the page
 * Just Works once the user is signed in.
 *
 * Privacy: every probe runs with the CALLING USER's delegated Graph
 * token, so the response only ever reflects that user's access.
 * Token bytes themselves are never returned — we surface scopes,
 * expiry, audience, and probe results only.
 *
 * Cost: zero LLM calls. Probes are bounded ($top=1 / size=1) so this
 * route is safe to hit on every page load.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { getValidToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";
import {
  getRelevantContext,
  type ContextBundle,
  type ContextSurface,
} from "@/lib/assistant/context-resolver";

/**
 * Default question — matches the user's recurring failing test case so
 * opening the page surfaces the diagnosis with zero typing.
 */
export const DEFAULT_QUESTION = "What's in the TWA Agenda 4.20 doc?";

/** Scopes the assistant grounding pipeline relies on. */
export const EXPECTED_GROUNDING_SCOPES = [
  "User.Read",
  "Mail.Read",
  "Calendars.Read",
  "Calendars.ReadWrite",
  "Sites.Read.All",
  "Files.Read.All",
  "Tasks.Read",
  "Tasks.ReadWrite",
] as const;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/* ------------------------------------------------------------------ */
/* Token JWT introspection                                            */
/* ------------------------------------------------------------------ */

interface MsJwtPayload {
  scp?: string;
  aud?: string;
  appid?: string;
  tid?: string;
  upn?: string;
  exp?: number;
  iat?: number;
}

/**
 * Decode the payload of a Microsoft delegated access token. Microsoft
 * signs these as JWS (header.payload.sig) so we can read the payload
 * without verifying the signature — Azure already verified it on issue
 * and we are not making security decisions on its contents, only
 * showing the user what scopes Microsoft baked into the token.
 *
 * Returns null when the token is opaque (some tenants issue
 * non-decodable tokens) or the payload cannot be parsed.
 */
export function decodeMsToken(token: string): MsJwtPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
    const json = Buffer.from(padded + padding, "base64").toString("utf-8");
    const parsed = JSON.parse(json) as MsJwtPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export interface ScopeReport {
  /** Token's `scp` claim split + sorted. */
  scopes_in_token: string[];
  /** Subset of EXPECTED_GROUNDING_SCOPES the token DOES carry. */
  expected_present: string[];
  /** Subset of EXPECTED_GROUNDING_SCOPES the token DOES NOT carry. */
  expected_missing: string[];
  /** True when every expected scope is present. */
  has_all_expected: boolean;
}

/**
 * Compare the scopes the token actually carries to the scopes the
 * grounding pipeline needs. Pure data-mapping — no IO.
 */
export function computeScopeReport(scopesInToken: readonly string[]): ScopeReport {
  const set = new Set(scopesInToken);
  const present: string[] = [];
  const missing: string[] = [];
  for (const s of EXPECTED_GROUNDING_SCOPES) {
    if (set.has(s)) present.push(s);
    else missing.push(s);
  }
  return {
    scopes_in_token: [...scopesInToken].sort(),
    expected_present: present,
    expected_missing: missing,
    has_all_expected: missing.length === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Live Graph probes                                                  */
/* ------------------------------------------------------------------ */

export type ProbeName =
  | "user_profile"
  | "sharepoint_sites_search"
  | "sharepoint_search_query"
  | "calendar_view"
  | "mail_search"
  | "todo_lists";

export interface ProbeResult {
  name: ProbeName;
  /** Human label rendered on the page (matches mock-up). */
  label: string;
  /** Endpoint actually hit (prefixed with /v1.0). */
  endpoint: string;
  /** HTTP method. */
  method: "GET" | "POST";
  /** Final HTTP status code. 0 on network failure. */
  status: number;
  /** True iff status === 200/206. */
  ok: boolean;
  /**
   * For 200 responses, a count of the items the probe returned (e.g.
   * SharePoint hits, calendar events). Undefined for failures.
   */
  count?: number;
  /**
   * For 403s, the Microsoft error code (`AccessDenied`,
   * `Authorization_RequestDenied`, etc.) so the diagnosis text can
   * surface which scope is the actual blocker.
   */
  error_code?: string;
  /** Short error message, never user-controlled content. */
  error_message?: string;
  /** True when the failure indicates the token is missing the expected scope. */
  scope_missing: boolean;
  /** Wall time in ms. */
  took_ms: number;
}

interface DoProbeArgs {
  name: ProbeName;
  label: string;
  method: "GET" | "POST";
  endpoint: string;
  body?: unknown;
  /** Function that, given a 200 response payload, returns a count for the UI. */
  countOf?: (payload: unknown) => number;
}

async function doProbe(
  token: string,
  args: DoProbeArgs,
): Promise<ProbeResult> {
  const t0 = Date.now();
  const url = `${GRAPH_BASE}/${args.endpoint}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(args.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(args.body ? { body: JSON.stringify(args.body) } : {}),
    });
  } catch (err) {
    return {
      name: args.name,
      label: args.label,
      endpoint: `/${args.endpoint}`,
      method: args.method,
      status: 0,
      ok: false,
      scope_missing: false,
      error_code: "network_error",
      error_message: (err as Error).message?.slice(0, 200) || "network_error",
      took_ms: Date.now() - t0,
    };
  }

  const took_ms = Date.now() - t0;

  if (res.status === 200 || res.status === 206) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    const count = args.countOf ? args.countOf(payload) : undefined;
    return {
      name: args.name,
      label: args.label,
      endpoint: `/${args.endpoint}`,
      method: args.method,
      status: res.status,
      ok: true,
      ...(typeof count === "number" ? { count } : {}),
      scope_missing: false,
      took_ms,
    };
  }

  // Non-2xx — read body to surface error code (Graph format).
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const errObj =
    body && typeof body === "object" && body !== null && "error" in body
      ? ((body as Record<string, unknown>).error as Record<string, unknown> | undefined)
      : undefined;
  const code =
    typeof errObj?.code === "string" ? (errObj.code as string) : undefined;
  const message =
    typeof errObj?.message === "string" ? (errObj.message as string) : undefined;

  const scopeMissing =
    res.status === 403 &&
    (/AccessDenied/i.test(code ?? "") ||
      /Authorization_RequestDenied/i.test(code ?? "") ||
      /scope/i.test(message ?? "") ||
      /permission/i.test(message ?? ""));

  return {
    name: args.name,
    label: args.label,
    endpoint: `/${args.endpoint}`,
    method: args.method,
    status: res.status,
    ok: false,
    error_code: code,
    error_message: message?.slice(0, 200),
    scope_missing: Boolean(scopeMissing),
    took_ms,
  };
}

/**
 * Run every probe. Sequential rather than parallel: this is a
 * diagnostic page, the user already knows it's slow, and Graph
 * tenants with throttling settings have rejected our parallel fan-out
 * before. Each probe is independently bounded ($top=1 / size=1).
 */
export async function runProbes(
  token: string,
  question: string,
): Promise<ProbeResult[]> {
  const startISO = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
  const endISO = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();

  const probes: DoProbeArgs[] = [
    {
      name: "user_profile",
      label: "User profile",
      method: "GET",
      endpoint: "me",
      countOf: (p) =>
        p && typeof p === "object" && "id" in (p as Record<string, unknown>)
          ? 1
          : 0,
    },
    {
      name: "sharepoint_sites_search",
      label: "SharePoint /sites?search",
      method: "GET",
      endpoint: "sites?search=*&$top=1",
      countOf: (p) => {
        const arr = (p as { value?: unknown[] })?.value;
        return Array.isArray(arr) ? arr.length : 0;
      },
    },
    {
      name: "sharepoint_search_query",
      label: "SharePoint /search/query",
      method: "POST",
      endpoint: "search/query",
      body: {
        requests: [
          {
            entityTypes: ["driveItem", "listItem", "site"],
            query: { queryString: question },
            from: 0,
            size: 1,
          },
        ],
      },
      countOf: (p) => {
        const containers =
          (p as { value?: Array<{ hitsContainers?: Array<{ total?: number; hits?: unknown[] }> }> })
            ?.value?.[0]?.hitsContainers ?? [];
        let total = 0;
        for (const c of containers) {
          if (typeof c.total === "number") total += c.total;
          else if (Array.isArray(c.hits)) total += c.hits.length;
        }
        return total;
      },
    },
    {
      name: "calendar_view",
      label: "Calendar /me/calendarView",
      method: "GET",
      endpoint: `me/calendarView?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}&$top=1`,
      countOf: (p) => {
        const arr = (p as { value?: unknown[] })?.value;
        return Array.isArray(arr) ? arr.length : 0;
      },
    },
    {
      name: "mail_search",
      label: "Mail /search/query (messages)",
      method: "POST",
      endpoint: "search/query",
      body: {
        requests: [
          {
            entityTypes: ["message"],
            query: { queryString: question },
            from: 0,
            size: 1,
          },
        ],
      },
      countOf: (p) => {
        const containers =
          (p as { value?: Array<{ hitsContainers?: Array<{ total?: number; hits?: unknown[] }> }> })
            ?.value?.[0]?.hitsContainers ?? [];
        let total = 0;
        for (const c of containers) {
          if (typeof c.total === "number") total += c.total;
          else if (Array.isArray(c.hits)) total += c.hits.length;
        }
        return total;
      },
    },
    {
      name: "todo_lists",
      label: "Tasks /me/todo/lists",
      method: "GET",
      endpoint: "me/todo/lists?$top=1",
      countOf: (p) => {
        const arr = (p as { value?: unknown[] })?.value;
        return Array.isArray(arr) ? arr.length : 0;
      },
    },
  ];

  const results: ProbeResult[] = [];
  for (const p of probes) {
    results.push(await doProbe(token, p));
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Auto-diagnosis                                                     */
/* ------------------------------------------------------------------ */

export interface DiagnosisInput {
  hasToken: boolean;
  expiresInSec: number | null;
  scopeReport: ScopeReport | null;
  probes: ProbeResult[];
  bundle: { sharepoint_hits: number; meeting_notes: number; calendar_events?: number; total_chars: number };
}

/**
 * Generate a 1-paragraph diagnosis based on the diagnostic signals.
 * Pure function so it's table-test-friendly. No IO. No side effects.
 *
 * Priority order (first-matching wins):
 *   1. No Microsoft 365 connection at all.
 *   2. Token decoded; missing scopes are the obvious blocker.
 *   3. Token has scopes; SharePoint probe still 403s (consent not granted).
 *   4. SharePoint probe 200 but bundle empty (search index miss).
 *   5. Calendar / mail probes failing.
 *   6. Token expired / about to expire.
 *   7. All green.
 */
export function diagnose(input: DiagnosisInput): string {
  if (!input.hasToken) {
    return (
      "No Microsoft 365 token is stored for your account. Connect Microsoft from " +
      "Settings → Microsoft, then reload this page."
    );
  }
  if (input.expiresInSec !== null && input.expiresInSec <= 0) {
    return (
      "Your Microsoft access token has expired. Sign out and back in (or wait one " +
      "minute for the auto-refresh) and reload this page."
    );
  }
  if (input.scopeReport && input.scopeReport.expected_missing.length > 0) {
    const missing = input.scopeReport.expected_missing.join(", ");
    return (
      `Your delegated token is missing required scopes: ${missing}. Even if Azure ` +
      "shows these as admin-consented on the Wolfpack Instinct app registration, " +
      "the OAuth sign-in flow Instinct uses isn't requesting them, so the token " +
      "Microsoft returns to Instinct doesn't carry them. Fix: add the scopes to " +
      "MS_SCOPES in src/lib/microsoft-graph.ts (already done for the assistant " +
      "pipeline scopes — confirm prompt=consent is set on /authorize), then sign " +
      "out + sign back in to receive a fresh token with the new scopes baked in."
    );
  }
  const sharepoint = input.probes.find(
    (p) => p.name === "sharepoint_search_query" || p.name === "sharepoint_sites_search",
  );
  if (sharepoint && sharepoint.status === 403 && sharepoint.scope_missing) {
    return (
      "SharePoint Graph search returned 403 InsufficientPrivilege. Your token " +
      "claims to have Sites.Read.All but Microsoft is rejecting the call — most " +
      "often because admin consent wasn't actually granted at the tenant level. " +
      "Ask a Microsoft 365 admin to consent to Sites.Read.All for the Wolfpack " +
      "Instinct app, then disconnect + reconnect Microsoft on your account."
    );
  }
  const sp200 = input.probes.find(
    (p) => p.name === "sharepoint_search_query" && p.status === 200,
  );
  if (sp200 && input.bundle.sharepoint_hits === 0) {
    return (
      "SharePoint search returned 200 OK but the resolver found no matching " +
      "documents for your question. The doc may not be in your SharePoint " +
      "search index (try opening it once in the SharePoint UI to trigger " +
      "indexing), or the title in the question doesn't match how the doc is " +
      "named. Try the exact filename or a phrase from the doc body."
    );
  }
  const calendar = input.probes.find((p) => p.name === "calendar_view");
  if (calendar && !calendar.ok) {
    return (
      "Calendar probe failed with HTTP " +
      String(calendar.status) +
      ". The assistant's date-bound queries (\"what's on April 20\") will return " +
      "empty. Reconnect Microsoft if this is a 401, or grant Calendars.Read at " +
      "the tenant level if this is a 403."
    );
  }
  const mail = input.probes.find((p) => p.name === "mail_search");
  if (mail && !mail.ok) {
    return (
      "Mail search probe failed with HTTP " +
      String(mail.status) +
      ". Email-grounded answers won't work. Confirm Mail.Read is consented at " +
      "the tenant level."
    );
  }
  if (input.expiresInSec !== null && input.expiresInSec < 5 * 60) {
    return (
      "Your token expires in under 5 minutes; the next refresh tick will rotate " +
      "it. Re-run this page in a minute and the diagnostic should be clean."
    );
  }
  if (input.bundle.total_chars === 0) {
    return (
      "All Graph probes returned OK but the resolver assembled an empty prompt " +
      "block. This usually means the question doesn't trigger any of the " +
      "configured intents (SharePoint search, calendar lookup, mail lookup, " +
      "meeting transcripts). Try wording the question with a date, person name, " +
      "or document title."
    );
  }
  return (
    "All grounding signals look healthy — the assistant SHOULD have context for " +
    "this question. If it's still saying \"I don't have access\", inspect the " +
    "rendered_prompt_block below to confirm the resolver passed grounding to " +
    "the LLM."
  );
}

/* ------------------------------------------------------------------ */
/* Response shape + handler                                           */
/* ------------------------------------------------------------------ */

export interface GroundingDebugResponse {
  question: string;
  user: { id_hint: string; name: string; email: string; role: string };
  token: {
    has_token: boolean;
    decodable: boolean;
    user_email: string | null;
    expires_at: string | null;
    expires_in_seconds: number | null;
    audience: string | null;
    tenant_id: string | null;
    upn: string | null;
    scopes: ScopeReport | null;
  };
  probes: ProbeResult[];
  bundle: {
    surface: ContextSurface;
    total_chars: number;
    took_ms: number;
    sharepoint_hits_count: number;
    project_tasks_count: number;
    meeting_notes_count: number;
    failures_observed: Array<{
      source: "sharepoint" | "project" | "meeting";
      status: number;
      scope_missing: boolean;
      code?: string;
      message?: string;
    }>;
    rendered_prompt_block: string;
  };
  diagnosis: string;
  generated_at: string;
}

function flattenBundleFailures(errors: ContextBundle["errors"]): GroundingDebugResponse["bundle"]["failures_observed"] {
  if (!errors) return [];
  const out: GroundingDebugResponse["bundle"]["failures_observed"] = [];
  if (errors.sharepoint) {
    out.push({
      source: "sharepoint",
      status: errors.sharepoint.status ?? 0,
      scope_missing: errors.sharepoint.code === "scope_missing",
      code: errors.sharepoint.code,
      message: errors.sharepoint.message,
    });
  }
  if (errors.project) {
    out.push({
      source: "project",
      status: errors.project.status ?? 0,
      scope_missing: errors.project.code === "scope_missing",
      code: errors.project.code,
      message: errors.project.message,
    });
  }
  if (errors.meeting) {
    out.push({
      source: "meeting",
      status: errors.meeting.status ?? 0,
      scope_missing: Boolean(errors.meeting.scope_missing),
      code: errors.meeting.code,
      message: errors.meeting.message,
    });
  }
  return out;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = (url.searchParams.get("q") || "").trim() || DEFAULT_QUESTION;

  /* 1. Token introspection. */
  const token = await getValidToken(user.id);
  let tokenSection: GroundingDebugResponse["token"];
  let probeResults: ProbeResult[] = [];
  if (!token) {
    tokenSection = {
      has_token: false,
      decodable: false,
      user_email: null,
      expires_at: null,
      expires_in_seconds: null,
      audience: null,
      tenant_id: null,
      upn: null,
      scopes: null,
    };
  } else {
    const decoded = decodeMsToken(token.accessToken);
    const nowSec = Math.floor(Date.now() / 1000);
    const scopesInToken =
      decoded?.scp?.split(" ").filter(Boolean) ?? [];
    tokenSection = {
      has_token: true,
      decodable: decoded !== null,
      user_email: token.userEmail || null,
      expires_at: decoded?.exp
        ? new Date(decoded.exp * 1000).toISOString()
        : null,
      expires_in_seconds: decoded?.exp ? decoded.exp - nowSec : null,
      audience: decoded?.aud ?? null,
      tenant_id: decoded?.tid ?? null,
      upn: decoded?.upn ?? null,
      scopes: decoded ? computeScopeReport(scopesInToken) : null,
    };

    /* 2. Live probes — only when we have a token. */
    probeResults = await runProbes(token.accessToken, q);
  }

  /* 3. Resolver bundle — always runs (gracefully empty without Graph). */
  const bundle = await getRelevantContext({
    question: q,
    userId: user.id,
    role: user.role,
    surface: "assistant_support",
  });

  const bundleSection: GroundingDebugResponse["bundle"] = {
    surface: bundle.surface,
    total_chars: bundle.total_chars,
    took_ms: bundle.took_ms,
    sharepoint_hits_count: bundle.sharepoint_hits.length,
    project_tasks_count: bundle.project_tasks.length,
    meeting_notes_count: bundle.meeting_notes.length,
    failures_observed: flattenBundleFailures(bundle.errors),
    rendered_prompt_block: bundle.rendered_prompt_block,
  };

  const diagnosis = diagnose({
    hasToken: tokenSection.has_token,
    expiresInSec: tokenSection.expires_in_seconds,
    scopeReport: tokenSection.scopes,
    probes: probeResults,
    bundle: {
      sharepoint_hits: bundleSection.sharepoint_hits_count,
      meeting_notes: bundleSection.meeting_notes_count,
      total_chars: bundleSection.total_chars,
    },
  });

  trackEvent("assistant.grounding_debug_invoked", user.id, user.role, {
    has_token: tokenSection.has_token,
    has_all_expected_scopes: tokenSection.scopes?.has_all_expected ?? false,
    missing_scopes_count: tokenSection.scopes?.expected_missing.length ?? 0,
    probe_failures: probeResults.filter((p) => !p.ok).length,
    sharepoint_hits: bundleSection.sharepoint_hits_count,
    total_chars: bundleSection.total_chars,
    took_ms: bundle.took_ms,
  });

  const body: GroundingDebugResponse = {
    question: q,
    user: {
      id_hint: user.id.slice(0, 8),
      name: user.name,
      email: user.email,
      role: user.role,
    },
    token: tokenSection,
    probes: probeResults,
    bundle: bundleSection,
    diagnosis,
    generated_at: new Date().toISOString(),
  };

  return NextResponse.json(body);
}
