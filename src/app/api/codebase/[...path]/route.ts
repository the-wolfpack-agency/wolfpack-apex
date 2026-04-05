import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { getFileContent, explainFile } from "@/lib/codebase-connector";
import * as path from "path";

/**
 * Resolve the repo path from query params or environment.
 */
function resolveRepoPath(requestedPath?: string | null): string {
  if (requestedPath) return requestedPath;

  const envPath = process.env.WOLFPACK_AUTO_REPO_PATH;
  if (envPath) return envPath;

  if (process.env.NODE_ENV !== "production") {
    return path.resolve(process.cwd(), "..", "wolfpack-auto");
  }

  throw new Error(
    "WOLFPACK_AUTO_REPO_PATH is not configured. Set this environment variable to the absolute path of the wolfpack-auto repository.",
  );
}

/**
 * GET /api/codebase/[...path] — Read file content or explain a file.
 *
 * Query params:
 *   ?action=explain   — parse and explain the file (zero-token)
 *   ?repoPath=/path   — optional override
 *
 * Default action: read file content.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const resolvedParams = await params;
  const filePath = resolvedParams.path.join("/");
  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "content";

  let repoPath: string;
  try {
    repoPath = resolveRepoPath(url.searchParams.get("repoPath"));
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, hint: "Set WOLFPACK_AUTO_REPO_PATH environment variable" },
      { status: 400 },
    );
  }

  trackEvent("system.page_viewed", user.id, user.role, {
    module: "codebase",
    action,
    file: filePath,
  });

  try {
    if (action === "explain") {
      const explanation = explainFile(repoPath, filePath, user.id, user.role);
      return NextResponse.json({ explanation });
    }

    // Default: read file content
    const content = getFileContent(repoPath, filePath, user.id, user.role);
    return NextResponse.json({ filePath, content });
  } catch (err) {
    const message = (err as Error).message;

    if (message.includes("Path traversal")) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (message.includes("not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }

    return NextResponse.json(
      { error: "Failed to read file", detail: message },
      { status: 500 },
    );
  }
}
