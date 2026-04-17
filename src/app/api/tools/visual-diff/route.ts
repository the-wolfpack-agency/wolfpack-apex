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

  try {
    const raw = execSync(
      `python3 -c "
import json
from agenticqa.client.visual_diff import VisualDiffEngine
engine = VisualDiffEngine()
result = engine.compare()
print(json.dumps(result))
"`,
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
    const changed = (result.results ?? []).filter(
      (r: { status: string }) => r.status === "changed",
    ).length;

    trackEvent("tools.visual_diff_run", user.id, user.role, {
      total: (result.results ?? []).length,
      changed,
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

    trackEvent("tools.visual_diff_run", user.id, user.role, {
      success: false,
      error: msg.slice(0, 200),
    });
    return NextResponse.json(
      { error: "Diff failed", detail: msg.slice(0, 300) },
      { status: 500 },
    );
  }
}
