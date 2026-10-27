/**
 * Forcefield Edge entry point (Next.js 16 proxy). No matcher on purpose: every
 * request, including /_next/* paths that belong to a tenant's own Next.js
 * origin, is a tenant request and goes through the engine. All logic lives in
 * lib/handle.ts so it is unit-tested without a server.
 */
import type { NextFetchEvent, NextRequest } from "next/server";
import { handleEdgeRequest } from "./lib/handle";

export async function proxy(request: NextRequest, event: NextFetchEvent): Promise<Response> {
  return handleEdgeRequest(request, process.env, (p) => event.waitUntil(p));
}
