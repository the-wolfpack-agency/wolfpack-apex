/**
 * POST /api/admin/integrations/probe
 *
 * Calls each quiet Microsoft surface once, read-only, and reports whether it
 * works, is merely empty, is awaiting a consent, or is genuinely broken.
 *
 * WHY THIS EXISTS AS A ROUTE. The question cannot be answered from a developer
 * machine: MS_CLIENT_ID and MS_CLIENT_SECRET are marked sensitive in Vercel and
 * come back redacted from an env pull, so every stored token is expired locally
 * with no way to refresh one. The probe correctly refuses to report anything in
 * that state, which means the only place it can produce an answer is a server
 * running where the credentials are.
 *
 * POST, NOT GET. This makes real calls to a third party on the caller's
 * infrastructure. A GET invites a link, a prefetch, or a monitoring check to
 * fire it, and a diagnostic that runs because something crawled it is a
 * diagnostic nobody is deciding to run.
 *
 * Gated on settings.manage_team: reading which integrations work is an
 * administrative question, and this one also spends real API calls.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { probeAll } from "@/lib/integrations/probe";
import { getValidToken } from "@/lib/microsoft-graph";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId ?? "default";

  /* PROBE AS THE CALLER, using their own connected account.
   *
   * The first version selected the most recently updated row from
   * instinct_ms_tokens "for this workspace". Two things were wrong with that.
   * The table has no workspace_id column, so the query would have thrown on
   * the first real request; and picking whichever account happened to be
   * newest meant an administrator could spend a colleague's credential
   * without either of them choosing it.
   *
   * getValidToken resolves by connected_by OR user_email, so the caller's own
   * email is the right key: they authorised the connection, and the probe
   * therefore reaches exactly what they can already reach.
   */
  const userId = auth.user.email;
  if (!userId) {
    return NextResponse.json(
      {
        probed: false,
        reason: "no_connected_account",
        detail: "No Microsoft account is connected for this user, so there is nothing to probe.",
      },
      { status: 409 },
    );
  }

  /* FAIL CLOSED ON A DEAD TOKEN, and report nothing rather than a table of
     failures that all share one irrelevant cause. Without this every surface
     comes back broken for the same reason and the result reads as breakage. */
  const token = await getValidToken(userId);
  if (!token) {
    return NextResponse.json(
      {
        probed: false,
        reason: "no_live_token",
        detail:
          "The connected account has no live token, so every call would fail for that one reason. Nothing was probed. Reconnect the account and try again.",
      },
      { status: 409 },
    );
  }

  const results = await probeAll(userId);

  /* AUDITED, because this is an administrator spending live calls against a
     third party using a tenant credential. Read-only does not mean
     unremarkable: "who ran this, when, and against whose account" is the
     question asked afterwards, and the verdicts are recorded rather than the
     data any of them returned. */
  try {
    await recordAudit({
      actor: { user_id: auth.user.id, role: auth.user.role },
      action: "integrations.probed",
      resourceType: "integration",
      resourceId: workspaceId,
      afterState: {
        surfaces: results.length,
        verdicts: results.map((r) => `${r.label}:${r.verdict}`),
      },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[integrations/probe audit]", (err as Error).message);
  }

  return NextResponse.json(
    { probed: true, results },
    { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
