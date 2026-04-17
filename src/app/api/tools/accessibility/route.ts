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

  let body: { target_url?: string; paths?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine
  }

  const token = process.env.GITHUB_TOKEN_TOOLS!;
  const paths = (body.paths ?? ["/", "/sites", "/knowledge"]).join(",");

  try {
    const result = await triggerToolRun(
      "accessibility",
      { target_url: body.target_url, paths, requester: user.id },
      token,
    );

    if ("error" in result) {
      trackEvent("tools.accessibility_checked", user.id, user.role, { success: false, error: result.error });
      return NextResponse.json({ status: "failed", error: result.error }, { status: 500 });
    }

    trackEvent("tools.accessibility_checked", user.id, user.role, { success: true, run_id: result.run_id });
    return NextResponse.json({ status: "queued", run_id: result.run_id });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    trackEvent("tools.accessibility_checked", user.id, user.role, { success: false, error: msg.slice(0, 200) });
    return NextResponse.json(
      { status: "failed", error: "Failed to trigger workflow", detail: msg.slice(0, 300) },
      { status: 500 },
    );
  }
}
