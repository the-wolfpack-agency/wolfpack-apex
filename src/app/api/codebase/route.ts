import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { getRepoStructure, searchCodebase, getCodebaseStats } from "@/lib/codebase-connector";
import * as path from "path";

/**
 * Resolve the repo path from query params or environment.
 */
function resolveRepoPath(requestedPath?: string | null): string {
  if (requestedPath) return requestedPath;

  const envPath = process.env.WOLFPACK_AUTO_REPO_PATH;
  if (envPath) return envPath;

  // Development default
  if (process.env.NODE_ENV !== "production") {
    return path.resolve(process.cwd(), "..", "wolfpack-auto");
  }

  throw new Error(
    "WOLFPACK_AUTO_REPO_PATH is not configured. Set this environment variable to the absolute path of the wolfpack-auto repository.",
  );
}

/**
 * GET /api/codebase — Structure, search, or stats.
 *
 * Query params:
 *   ?action=structure  — file tree
 *   ?action=search&query=term&fileTypes=ts,tsx  — grep search
 *   ?action=stats      — codebase statistics
 *   ?repoPath=/path    — optional override
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action") || "structure";
  const queryParam = url.searchParams.get("query");
  const fileTypesParam = url.searchParams.get("fileTypes");

  let repoPath: string;
  try {
    repoPath = resolveRepoPath(url.searchParams.get("repoPath"));
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message, hint: "Set WOLFPACK_AUTO_REPO_PATH environment variable" },
      { status: 400 },
    );
  }

  trackEvent("system.page_viewed", user.id, user.role, { module: "codebase", action });

  try {
    switch (action) {
      case "structure": {
        const entries = getRepoStructure(repoPath, user.id, user.role);
        return NextResponse.json({ entries, repoPath });
      }

      case "search": {
        if (!queryParam) {
          return NextResponse.json({ error: "query parameter is required for search" }, { status: 400 });
        }
        const fileTypes = fileTypesParam ? fileTypesParam.split(",").map((t) => t.trim()) : undefined;
        const results = searchCodebase(repoPath, queryParam, user.id, user.role, fileTypes);
        return NextResponse.json({ results, query: queryParam, repoPath });
      }

      case "stats": {
        const stats = getCodebaseStats(repoPath, user.id, user.role);
        return NextResponse.json({ stats, repoPath });
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}. Use structure, search, or stats.` },
          { status: 400 },
        );
    }
  } catch (err) {
    return NextResponse.json(
      { error: "Codebase operation failed", detail: (err as Error).message },
      { status: 500 },
    );
  }
}
