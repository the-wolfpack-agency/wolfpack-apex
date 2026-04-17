import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { execSync } from "child_process";
import { join } from "path";

const LOCAL_ONLY_MSG =
  "This tool requires the local development server with Python and Vibium installed. Run 'npm run dev' on your machine.";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "tools.run");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  let body: { paths?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    // default paths
  }
  const paths = body.paths ?? ["/"];

  try {
    const pathsJson = JSON.stringify(paths);
    const raw = execSync(
      `python3 -c "
import json, sys
from agenticqa.client.accessibility import AccessibilityAuditor
auditor = AccessibilityAuditor()
result = auditor.audit(json.loads(sys.argv[1]))
print(json.dumps(result))
" '${pathsJson.replace(/'/g, "\\'")}'`,
      {
        timeout: 60_000,
        encoding: "utf-8",
        env: {
          ...process.env,
          PYTHONPATH: join(process.cwd(), "..", "AgenticQA", "src"),
        },
      },
    );

    const result = JSON.parse(raw.trim());
    trackEvent("tools.accessibility_checked", user.id, user.role, {
      paths_count: paths.length,
      score: result.audit?.score ?? -1,
      issues_count: (result.audit?.issues ?? []).length,
    });

    return NextResponse.json(result);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (
      msg.includes("ENOENT") ||
      msg.includes("python3") ||
      msg.includes("ModuleNotFoundError") ||
      msg.includes("No such file")
    ) {
      return NextResponse.json({ available: false, message: LOCAL_ONLY_MSG });
    }

    trackEvent("tools.accessibility_checked", user.id, user.role, {
      success: false,
      error: msg.slice(0, 200),
    });
    return NextResponse.json(
      { error: "Accessibility check failed", detail: msg.slice(0, 300) },
      { status: 500 },
    );
  }
}
