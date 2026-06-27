/**
 * Target OWNERSHIP VERIFICATION for the platform scanner.
 *
 * THE LEGAL/SAFETY GATE: we actively scan and pentest client systems. We must
 * NEVER probe a target the client has not proven they own or are authorized to
 * test. An operator typo in a baseUrl, or a stored target pointed at a third
 * party, must be REFUSED before any probe is issued. Unauthorized scanning of a
 * third party is a CFAA / Computer Misuse Act exposure; this module is the
 * control that prevents it.
 *
 * Design (the industry standard: Google Search Console, ACME / Let's Encrypt,
 * Detectify): the SERVER issues a cryptographically-random challenge token. The
 * client proves control of the target out-of-band by placing the token where
 * only the target's owner could. The server then fetches/resolves the token and,
 * on a constant-time match, marks the target verified.
 *
 * TWO METHODS ARE SUPPORTED, and we deliberately support BOTH:
 *
 *   (a) http_well_known - the client serves the token at
 *       https://<target>/.well-known/ogiam-site-verification.txt and we GET it.
 *       PRO: trivial for a web app the client already controls (drop a static
 *       file). It is the lowest-friction path and mirrors Google's HTML-file
 *       method. CON: only proves control of THAT origin/host (not the whole
 *       domain), and requires the ability to deploy a file - impossible for some
 *       static hosts, CDNs, or when the path is rewritten.
 *
 *   (b) dns_txt - the client adds a TXT record
 *       "ogiam-site-verification=<token>" on the target's host and we resolve it.
 *       PRO: proves DOMAIN control (you can only edit DNS for a domain you own),
 *       works even when you cannot deploy a file, and is host/path-agnostic. It
 *       mirrors ACME dns-01 and Google's DNS method. CON: higher friction (DNS
 *       propagation delay, registrar access) than dropping a file.
 *
 * Supporting both means a client always has at least one workable proof path,
 * which is why every serious verification product offers the pair.
 *
 * SECURITY:
 *   - Token is generated with node crypto.randomBytes (CSPRNG), NEVER Math.random.
 *   - The HTTP fetch goes through assertScannableUrl (the SSRF guard) so a target
 *     that resolves to a private/loopback/metadata IP is refused - you cannot use
 *     the verification fetch as an SSRF primitive.
 *   - Token comparison is constant-time (crypto.timingSafeEqual) to avoid a
 *     timing oracle on the secret.
 *   - The token is never logged at error level; failure reasons are coarse
 *     strings ('token_mismatch', 'ssrf_blocked', ...), never the token value.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { assertScannableUrl, SsrfBlockedError } from "../ssrf-guard";
import { getStoredScanTarget } from "../targets-store";

export type VerificationMethod = "http_well_known" | "dns_txt";
export type VerificationStatus = "pending" | "verified" | "failed";

/** The well-known path the client serves the token at (relative to the target origin). */
export const WELL_KNOWN_PATH = "/.well-known/ogiam-site-verification.txt";
/** The DNS TXT record prefix the client adds on the target host. */
export const DNS_TXT_PREFIX = "ogiam-site-verification=";

/** Token length in bytes (32 bytes -> 64 hex chars). */
const TOKEN_BYTES = 32;

export interface VerificationInstructions {
  method: VerificationMethod;
  /** Human-readable summary of what to place where. */
  summary: string;
  /** The exact path (http_well_known) or record name (dns_txt). */
  location: string;
  /** The exact content the client must place. */
  value: string;
}

export interface IssueResult {
  workspaceId: string;
  platform: string;
  token: string;
  status: VerificationStatus;
  verifiedAt: string | null;
  instructions: VerificationInstructions[];
}

export interface CheckResult {
  ok: boolean;
  workspaceId: string;
  platform: string;
  method: VerificationMethod;
  status: VerificationStatus;
  verifiedAt: string | null;
  /** Coarse reason on failure (never the token). */
  reason?: string;
}

/** Injectable IO so checkVerification is fully unit-testable without network/DNS. */
export interface CheckDeps {
  /** fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** DNS TXT resolver (defaults to node:dns/promises resolveTxt). */
  dnsResolveTxt?: (host: string) => Promise<string[][]>;
  /** SSRF guard (defaults to assertScannableUrl); injectable for tests. */
  assertScannable?: (url: string) => Promise<void>;
  /** Resolve the target baseUrl for a (workspace, platform); defaults to the store. */
  resolveBaseUrl?: (workspaceId: string, platform: string) => Promise<string | null>;
}

interface VerificationRow {
  verification_token: string;
  verification_method: string | null;
  verification_status: string;
  verified_at: string | null;
}

/** Generate a cryptographically-random token. CSPRNG only - never Math.random. */
function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("hex");
}

/** Constant-time string compare. Returns false on any length/format mismatch. */
function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function buildInstructions(token: string, baseUrl: string | null): VerificationInstructions[] {
  let host = "<your-target-host>";
  let origin = baseUrl ?? "https://<your-target>";
  if (baseUrl) {
    try {
      const u = new URL(baseUrl);
      host = u.hostname;
      origin = u.origin;
    } catch {
      /* fall back to placeholders */
    }
  }
  return [
    {
      method: "http_well_known",
      summary: `Serve the token at ${WELL_KNOWN_PATH} on the target, then click Check.`,
      location: `${origin}${WELL_KNOWN_PATH}`,
      value: token,
    },
    {
      method: "dns_txt",
      summary: `Add a DNS TXT record on ${host} with the value below, then click Check.`,
      location: host,
      value: `${DNS_TXT_PREFIX}${token}`,
    },
  ];
}

/**
 * Issue (or re-issue) a verification token for a (workspace, platform). Persists
 * the token, resets status to pending, and returns the token plus placement
 * instructions for BOTH methods. Re-issuing rotates the token (a fresh challenge).
 */
export async function issueVerificationToken(
  workspaceId: string,
  platform: string,
): Promise<IssueResult> {
  const token = generateToken();
  await writeQuery(
    `INSERT INTO instinct_target_verifications
       (workspace_id, platform, verification_token, verification_status, verification_method, verified_at, verification_reason, updated_at)
     VALUES ($1, $2, $3, 'pending', NULL, NULL, NULL, NOW())
     ON CONFLICT (workspace_id, platform) DO UPDATE SET
       verification_token = EXCLUDED.verification_token,
       verification_status = 'pending',
       verification_method = NULL,
       verified_at = NULL,
       verification_reason = NULL,
       updated_at = NOW()`,
    [workspaceId, platform, token],
  );

  let baseUrl: string | null = null;
  try {
    const manifest = await getStoredScanTarget(workspaceId, platform);
    baseUrl = manifest?.baseUrl ?? null;
  } catch {
    /* instructions still render with placeholders if the target isn't stored yet */
  }

  return {
    workspaceId,
    platform,
    token,
    status: "pending",
    verifiedAt: null,
    instructions: buildInstructions(token, baseUrl),
  };
}

async function loadRow(workspaceId: string, platform: string): Promise<VerificationRow | null> {
  const { rows } = await safeQuery<VerificationRow>(
    `SELECT verification_token, verification_method, verification_status, verified_at
       FROM instinct_target_verifications
      WHERE workspace_id = $1 AND platform = $2 LIMIT 1`,
    [workspaceId, platform],
  );
  return rows[0] ?? null;
}

async function markVerified(workspaceId: string, platform: string, method: VerificationMethod): Promise<string> {
  const { rows } = await writeQuery<{ verified_at: string }>(
    `UPDATE instinct_target_verifications
        SET verification_status = 'verified',
            verification_method = $3,
            verified_at = NOW(),
            verification_reason = NULL,
            updated_at = NOW()
      WHERE workspace_id = $1 AND platform = $2
      RETURNING verified_at`,
    [workspaceId, platform, method],
  );
  return rows[0]?.verified_at ?? new Date().toISOString();
}

async function markFailed(workspaceId: string, platform: string, method: VerificationMethod, reason: string): Promise<void> {
  await writeQuery(
    `UPDATE instinct_target_verifications
        SET verification_status = 'failed',
            verification_method = $3,
            verification_reason = $4,
            updated_at = NOW()
      WHERE workspace_id = $1 AND platform = $2`,
    [workspaceId, platform, method, reason],
  );
}

/** Strip a "..." quoted TXT chunk and trim whitespace. */
function normalizeTxt(chunk: string): string {
  return chunk.trim().replace(/^"|"$/g, "").trim();
}

/**
 * Perform the proof check for one method. On success: mark verified + fire
 * platform.target_verified. On failure: mark failed + fire
 * platform.target_verification_failed with a coarse reason. The token is never
 * logged.
 */
export async function checkVerification(
  workspaceId: string,
  platform: string,
  method: VerificationMethod,
  actor: { userId: string; role: string },
  deps: CheckDeps = {},
): Promise<CheckResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const assertScannable = deps.assertScannable ?? assertScannableUrl;
  const resolveBaseUrl =
    deps.resolveBaseUrl ??
    (async (ws: string, p: string) => (await getStoredScanTarget(ws, p))?.baseUrl ?? null);

  const fail = async (reason: string): Promise<CheckResult> => {
    await markFailed(workspaceId, platform, method, reason).catch(() => {});
    trackEvent("platform.target_verification_failed", actor.userId, actor.role, {
      platform,
      method,
      reason,
    });
    return { ok: false, workspaceId, platform, method, status: "failed", verifiedAt: null, reason };
  };

  const row = await loadRow(workspaceId, platform);
  if (!row || !row.verification_token) {
    return fail("no_token_issued");
  }
  const token = row.verification_token;

  const baseUrl = await resolveBaseUrl(workspaceId, platform);
  if (!baseUrl) {
    return fail("no_target");
  }
  let host: string;
  let origin: string;
  try {
    const u = new URL(baseUrl);
    host = u.hostname;
    origin = u.origin;
  } catch {
    return fail("baseurl_invalid");
  }

  if (method === "http_well_known") {
    const url = `${origin}${WELL_KNOWN_PATH}`;
    // SSRF guard FIRST: refuse to fetch a target that resolves to a private IP.
    try {
      await assertScannable(url);
    } catch (err) {
      if (err instanceof SsrfBlockedError) return fail("ssrf_blocked");
      return fail("ssrf_check_error");
    }
    let body: string;
    try {
      const res = await fetchImpl(url, { redirect: "manual" });
      if (!res.ok) return fail(`http_${res.status}`);
      body = await res.text();
    } catch {
      return fail("fetch_failed");
    }
    // The file may contain the bare token (optionally with surrounding whitespace).
    if (tokensMatch(body.trim(), token)) {
      const verifiedAt = await markVerified(workspaceId, platform, method);
      trackEvent("platform.target_verified", actor.userId, actor.role, { platform, method });
      return { ok: true, workspaceId, platform, method, status: "verified", verifiedAt };
    }
    return fail("token_mismatch");
  }

  // dns_txt
  const resolveTxt =
    deps.dnsResolveTxt ??
    (async (h: string) => {
      const { resolveTxt: nodeResolveTxt } = await import("node:dns/promises");
      return nodeResolveTxt(h);
    });
  let records: string[][];
  try {
    records = await resolveTxt(host);
  } catch {
    return fail("no_txt_record");
  }
  const expected = `${DNS_TXT_PREFIX}${token}`;
  for (const record of records) {
    // A TXT record can be split into multiple strings; join them.
    const joined = normalizeTxt(record.join(""));
    if (joined.startsWith(DNS_TXT_PREFIX) && tokensMatch(joined, expected)) {
      const verifiedAt = await markVerified(workspaceId, platform, method);
      trackEvent("platform.target_verified", actor.userId, actor.role, { platform, method });
      return { ok: true, workspaceId, platform, method, status: "verified", verifiedAt };
    }
  }
  return fail("token_mismatch");
}

/**
 * THE ORCHESTRATOR GATE.
 *
 * Returns true iff the target is proven verified: a verification row exists,
 * carries a token, and has a non-null verified_at. The scan + pentest paths
 * call this and REFUSE to proceed when it returns false.
 *
 * Signature (the orchestrator depends on this exact shape):
 *   isTargetVerified(workspaceId: string, platform: string): Promise<boolean>
 */
export async function isTargetVerified(workspaceId: string, platform: string): Promise<boolean> {
  const row = await loadRow(workspaceId, platform);
  return !!row && !!row.verification_token && row.verified_at !== null;
}
