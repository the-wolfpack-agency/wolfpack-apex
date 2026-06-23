/**
 * Public build-version endpoint. Returns the git SHA and deployment id of the
 * CURRENTLY SERVING build so we can confirm a push actually reached production
 * (a green local build does not prove the production alias advanced). No auth,
 * no DB, no secrets: only Vercel-provided build metadata.
 */
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  return NextResponse.json({
    sha: process.env.VERCEL_GIT_COMMIT_SHA ?? "local",
    ref: process.env.VERCEL_GIT_COMMIT_REF ?? "unknown",
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID ?? "unknown",
    env: process.env.VERCEL_ENV ?? "unknown",
  });
}
