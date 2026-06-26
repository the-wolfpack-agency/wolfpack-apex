/**
 * Enforces: every `fetch("/api/...")` call from client components must go
 * through fetchWithRefresh (which transparently refreshes expired JWTs).
 *
 * Raw fetch() to authenticated endpoints is how the dashboard silently
 * broke on April 16 2026 — stale JWTs returned 401 on every call, the
 * page rendered with zeros. This test is the permanent guardrail so no
 * future code regresses.
 *
 * Exceptions: the `fetchWithRefresh` implementation itself (which calls
 * fetch internally) and the login endpoint (no token exists yet pre-login).
 */
import fs from "fs";
import path from "path";

const EXCEPTIONS = [
  "src/lib/client-auth.ts", // the implementation itself
  "src/app/login",           // pre-auth by definition
  "src/app/api/",            // server routes, not client
  "src/app/share/",          // unauthenticated client share pages (035) —
                             //   the signed share token IS the credential; no
                             //   JWT refresh flow applies. See
                             //   src/app/share/[token]/ShareApprovalPanel.tsx.
  "src/app/s/",              // public survey responder (migration 161/162) —
                             //   anonymous, no JWT; the /api/s/* routes are
                             //   unauthenticated by design (view beacon +
                             //   submit). No refresh flow applies.
  "src/app/accept-invite",   // pre-auth: invitee has no session yet
  "src/app/forgot-password", // pre-auth: no session by definition
  "src/app/reset-password",  // pre-auth: token-in-URL flow, no session
  "__tests__/",              // test files (any nested __tests__ dir) — fixtures
                             //   may contain sample buggy `fetch("/api/…")`
                             //   strings (e.g. platform-scan detector fixtures);
                             //   tests are never shipped client code.
  "node_modules/",
  ".next/",
];

/**
 * Endpoints that are SAFE to call with a raw fetch from client code,
 * because the "401 → blank page" failure mode this guard exists for does
 * not apply to them:
 *   - /api/analytics is a fire-and-forget observability beacon (often
 *     keepalive); a 401 is silently ignored and never blanks the UI, and
 *     fetchWithRefresh's retry/redirect semantics are wrong for a beacon.
 *   - /api/auth/whoami is the session BOOTSTRAP (re-mints the JWT via the
 *     refresh cookie). Routing it through fetchWithRefresh would be
 *     circular — it's the very call that establishes the token.
 * Anything not listed here still must use fetchWithRefresh.
 */
const ENDPOINT_EXCEPTIONS = ["/api/analytics", "/api/auth/whoami"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (EXCEPTIONS.some((e) => full.includes(e))) continue;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no raw fetch to authenticated API endpoints from client code", () => {
  it("forbids `fetch(\"/api/...\")` outside of the fetchWithRefresh implementation", () => {
    const root = path.resolve(__dirname, "../..");
    const files = walk(path.join(root, "src"));
    const offenders: Array<{ file: string; line: number; match: string }> = [];
    const pattern = /\bfetch\s*\(\s*["`](\/api\/[^"`]+)["`]/g;

    for (const file of files) {
      const src = fs.readFileSync(file, "utf8");
      // Only flag files marked "use client" or components/pages that render in browser
      if (!src.includes('"use client"') && !file.includes("src/components/")) continue;
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        let m: RegExpExecArray | null;
        pattern.lastIndex = 0;
        while ((m = pattern.exec(line)) !== null) {
          // Skip if the same line already uses fetchWithRefresh
          if (line.includes("fetchWithRefresh") || line.includes("fetchJsonWithRefresh")) continue;
          // Skip fire-and-forget / bootstrap endpoints (see ENDPOINT_EXCEPTIONS).
          const endpoint = m[1].split("?")[0];
          if (ENDPOINT_EXCEPTIONS.includes(endpoint)) continue;
          offenders.push({ file: path.relative(root, file), line: i + 1, match: m[1] });
        }
      });
    }

    if (offenders.length > 0) {
      const list = offenders
        .map((o) => `  ${o.file}:${o.line} — fetch("${o.match}")`)
        .join("\n");
      throw new Error(
        `Raw fetch() to /api/* from client code detected. Use fetchWithRefresh instead.\n${list}\n\n` +
          `See src/lib/client-auth.ts + .ai/conventions.md (token refresh section).`,
      );
    }
  });
});
