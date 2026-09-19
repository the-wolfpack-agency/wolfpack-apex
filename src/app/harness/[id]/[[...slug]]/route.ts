/**
 * PUBLIC: developer tool - the instrumented decoy sandbox an external agent crawls; anonymous by design, hardened via an unguessable, format-validated session id + short TTL + hard hit cap.
 * PUBLIC (unauthenticated) - the instrumented sandbox. An external agent crawls
 * these paths; each request is recorded (relative path + method + status + the
 * structural event it maps to) and the sandbox serves its own decoy HTML. There
 * is no outbound fetch, so this can never be an SSRF pivot. No PII recorded.
 */

import { NextResponse, type NextRequest } from "next/server";
import { recordHarnessHit } from "@/lib/harness/harness";
import { HONEYPOT_FIELD, renderSandbox } from "@/lib/harness/sandbox";

interface Ctx {
  params: Promise<{ id: string; slug?: string[] }>;
}

function relPathFrom(slug: string[] | undefined): string {
  if (!slug || slug.length === 0) return "/";
  return `/${slug.join("/")}`;
}

async function honeypotTripped(req: NextRequest): Promise<boolean> {
  try {
    const form = await req.formData();
    const v = form.get(HONEYPOT_FIELD);
    return typeof v === "string" && v.trim().length > 0;
  } catch {
    return false;
  }
}

/** Session tokens are `hs_` + base64url of random bytes. Reject anything else
 *  up front, so a malformed id never reaches the sandbox renderer (defense in
 *  depth: the renderer also escapes, and only real sessions render a page). */
const SESSION_ID_RE = /^hs_[A-Za-z0-9_-]{8,64}$/;

async function handle(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const { id, slug } = await ctx.params;
  if (!SESSION_ID_RE.test(id)) {
    return new NextResponse("<!doctype html><title>Not found</title><h1>404</h1>", {
      status: 404,
      headers: { "Content-Type": "text/html", "X-Robots-Tag": "noindex" },
    });
  }
  const relPath = relPathFrom(slug);
  const base = `${req.nextUrl.origin}/harness/${id}`;
  const method = req.method;
  const honeypot = method === "POST" ? await honeypotTripped(req) : false;

  // Recording is a DB write that shares the app pool; a transient failure must
  // still serve the sandbox page (recording is best-effort) rather than 500 the
  // agent under test. The agent would just retry, inflating the pressure.
  let response;
  try {
    ({ response } = await recordHarnessHit({ sessionId: id, relPath, method, base, honeypotTripped: honeypot }));
  } catch {
    response = renderSandbox(relPath, base);
  }
  return new NextResponse(response.body, {
    status: response.status,
    headers: { "Content-Type": response.contentType, "X-Robots-Tag": "noindex" },
  });
}

export async function GET(req: NextRequest, ctx: Ctx) {
  return handle(req, ctx);
}
export async function POST(req: NextRequest, ctx: Ctx) {
  return handle(req, ctx);
}
