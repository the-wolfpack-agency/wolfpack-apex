/**
 * CORS for the PUBLIC harness API. ogiam.com fronts the harness (the apex CSP
 * sets frame-ancestors 'self', so it cannot be iframed - it is called via
 * cross-origin fetch instead). We allow only our own marketing origins + local
 * dev; everything else gets no CORS grant. This is not an auth boundary (the API
 * is deliberately public), just a browser-fetch allowlist.
 */

const ALLOWED_ORIGINS = new Set<string>([
  "https://ogiam.com",
  "https://www.ogiam.com",
  "http://localhost:3000",
  "http://localhost:3001",
]);

export function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://ogiam.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}
