import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { triggerToolRun, isConfigured } from "@/lib/tools-runner";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "tools.run");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!isConfigured()) {
    return NextResponse.json({
      status: "not_configured",
      message: "Tools are being set up — contact your admin to configure GITHUB_TOKEN_TOOLS.",
    });
  }

  let body: { target_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  const token = process.env.GITHUB_TOKEN_TOOLS!;

  try {
    const result = await triggerToolRun(
      "demo-deck",
      {
        target_url: body.target_url,
        requester: user.id,
        actor: { userId: user.id, role: user.role },
      },
      token,
    );

    if ("error" in result) {
      trackEvent("tools.demo_deck_captured", user.id, user.role, { success: false, error: result.error });
      return NextResponse.json({ status: "failed", error: result.error }, { status: 500 });
    }

    trackEvent("tools.demo_deck_captured", user.id, user.role, { success: true, run_id: result.run_id });
    return NextResponse.json({ status: "queued", run_id: result.run_id });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    trackEvent("tools.demo_deck_captured", user.id, user.role, { success: false, error: msg.slice(0, 200) });
    return NextResponse.json(
      { status: "failed", error: "Failed to trigger workflow", detail: msg.slice(0, 300) },
      { status: 500 },
    );
  }
}
