/**
 * POST /api/automations/porsche-classes/config/sharepoint-test —
 * verify the saved SharePoint folder is reachable via Microsoft Graph.
 *
 * The wizard at /automations/porsche-classes/setup hits this route
 * AFTER the operator saves a folder URL. Two outcomes:
 *
 *   ok=true   → the folder exists, the operator's token can read it,
 *               we're confident the next class summary upload will land.
 *   ok=false  → the folder couldn't be opened. The accompanying `error`
 *               is a plain-language sentence the operator can act on
 *               (e.g. "Outlook isn't connected" or "We couldn't open
 *               that folder — check it still exists").
 *
 * Why it's a separate endpoint instead of part of PUT /config: the
 * health check needs to exercise Graph end-to-end. The PUT /config call
 * already calls Graph once (to resolve site_id + drive_id) but doesn't
 * verify the folder bytes are reachable — a renamed folder or a
 * permissions change would still let the resolve succeed but break the
 * upload. This route does the second round-trip explicitly.
 *
 * Auth: automations.run (same as the PUT — only operators who can
 * configure should be able to test).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getSharepointConfig } from "@/lib/automations/porsche-classes/config-repo";
import { getValidToken } from "@/lib/microsoft-graph";
import { trackEvent } from "@/lib/analytics";

const AUTOMATION_ID = "porsche-classes";

interface SharepointTestResponse {
  ok: boolean;
  error?: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  const config = await getSharepointConfig();
  if (!config) {
    trackEvent("automations.sharepoint_test_run", auth.user.id, auth.user.role, {
      automation_id: AUTOMATION_ID,
      ok: false,
    });
    const body: SharepointTestResponse = {
      ok: false,
      error:
        "No SharePoint folder is set yet. Paste a folder URL in Step 3 and save first.",
    };
    return NextResponse.json(body, { status: 400 });
  }

  const token = await getValidToken(auth.user.id);
  if (!token) {
    trackEvent("automations.sharepoint_test_run", auth.user.id, auth.user.role, {
      automation_id: AUTOMATION_ID,
      ok: false,
    });
    const body: SharepointTestResponse = {
      ok: false,
      error: "Outlook isn't connected. Connect Outlook in Step 1 and try again.",
    };
    return NextResponse.json(body, { status: 400 });
  }

  /* Minimal Graph "is the folder there?" lookup — request the drive
     item by path. Cheap call (no children traversal) that fails fast
     when the folder is gone or unreachable. */
  const folder = config.path
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => encodeURIComponent(s))
    .join("/");
  const url =
    `https://graph.microsoft.com/v1.0/sites/${encodeURIComponent(config.site_id)}` +
    `/drives/${encodeURIComponent(config.drive_id)}` +
    `/root:/${folder}`;

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token.accessToken}` },
    });
  } catch (err) {
    trackEvent("automations.sharepoint_test_run", auth.user.id, auth.user.role, {
      automation_id: AUTOMATION_ID,
      ok: false,
    });
    return NextResponse.json(
      {
        ok: false,
        error: `We couldn't reach Microsoft to check the folder: ${(err as Error).message}`,
      },
      { status: 502 },
    );
  }

  if (res.ok) {
    trackEvent("automations.sharepoint_test_run", auth.user.id, auth.user.role, {
      automation_id: AUTOMATION_ID,
      ok: true,
      status: res.status,
    });
    return NextResponse.json({ ok: true } as SharepointTestResponse);
  }

  let bodyText = "";
  try {
    bodyText = await res.text();
  } catch {
    bodyText = "";
  }
  const message =
    res.status === 404
      ? "We couldn't open that folder. Check the link still works in your browser."
      : res.status === 401 || res.status === 403
        ? "Microsoft says we don't have access to that folder. Make sure your account can open it in your browser."
        : `Microsoft returned an error (${res.status}). Try saving the folder URL again.`;

  trackEvent("automations.sharepoint_test_run", auth.user.id, auth.user.role, {
    automation_id: AUTOMATION_ID,
    ok: false,
    status: res.status,
  });

  return NextResponse.json(
    {
      ok: false,
      error: message,
      // diagnostic for the server logs only — DON'T surface to the user
      // body: bodyText.slice(0, 300),
    } as SharepointTestResponse,
    { status: 200 }, // 200 — semantically a successful test result
  );
  // bodyText is intentionally consumed but not surfaced — keeping the
  // ref so future logging additions can use it without re-reading.
  void bodyText;
}
