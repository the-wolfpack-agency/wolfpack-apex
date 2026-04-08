"use client";

/**
 * Re-exports the canonical client-auth helpers. Kept as a separate file
 * so existing imports from "./auth" inside components/people don't
 * break, but new code should import from "@/lib/client-auth" directly.
 */
export { authHeaders, jsonHeaders } from "@/lib/client-auth";
