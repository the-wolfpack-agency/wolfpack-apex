import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  getRunStatus,
  fetchArtifactResult,
  getLatestToolRun,
  isConfigured,
  type ToolName,
} from "@/lib/tools-runner";

const VALID_TOOLS = new Set(["pdf-report", "demo-deck", "visual-diff", "accessibility"]);

/**
 * GET /api/tools/status?run_id=123&tool=pdf-report
 *
 * If run_id is provided: returns the status of that specific run.
 * If only tool is provided: returns the latest completed run for that tool.
 *
 * When a run is completed, the result.json artifact is fetched and included.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "tools.run");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  if (!isConfigured()) {
    return NextResponse.json({
      status: "not_configured",
      message: "Tools are being set up — contact your admin to configure GITHUB_TOKEN_TOOLS.",
    });
  }

  const { searchParams } = new URL(req.url);
  const runIdParam = searchParams.get("run_id");
  const tool = searchParams.get("tool") as ToolName | null;

  const token = process.env.GITHUB_TOKEN_TOOLS!;

  // Validate tool name if provided
  if (tool && !VALID_TOOLS.has(tool)) {
    return NextResponse.json(
      { error: `Invalid tool: ${tool}. Must be one of: ${[...VALID_TOOLS].join(", ")}` },
      { status: 400 },
    );
  }

  try {
    // Case 1: specific run_id
    if (runIdParam) {
      const run_id = parseInt(runIdParam, 10);
      if (isNaN(run_id)) {
        return NextResponse.json({ error: "run_id must be a number" }, { status: 400 });
      }

      const status = await getRunStatus(run_id, token);

      // If completed and we know the tool, fetch the artifact result
      if (status.status === "completed" && tool) {
        const result = await fetchArtifactResult(run_id, tool, token);
        if (result) {
          status.result = result;
        }
      }

      trackEvent("tools.page_viewed", user.id, user.role, {
        run_id,
        tool: tool ?? "unknown",
        status: status.status,
      });

      return NextResponse.json(status);
    }

    // Case 2: latest run for a tool
    if (tool) {
      const latest = await getLatestToolRun(tool, token);
      if (!latest) {
        return NextResponse.json({ status: "no_runs", tool });
      }

      // Fetch the result for the latest completed run
      if (latest.status === "completed" && latest.run_id) {
        const result = await fetchArtifactResult(latest.run_id, tool, token);
        if (result) {
          latest.result = result;
        }
      }

      return NextResponse.json(latest);
    }

    return NextResponse.json(
      { error: "Provide either run_id or tool query parameter" },
      { status: 400 },
    );
  } catch (err) {
    const msg = (err as Error).message ?? "";
    return NextResponse.json(
      { status: "failed", error: "Failed to check status", detail: msg.slice(0, 300) },
      { status: 500 },
    );
  }
}
