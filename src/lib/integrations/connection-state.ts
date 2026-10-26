/**
 * Provider connection state, shared by route handlers and the UI.
 *
 * Client-safe: no server imports. The server-side response builder lives in
 * `./not-connected.ts`.
 *
 * THE RULE. HTTP 401 means one thing in Instinct: "your Instinct session is
 * invalid". `fetchWithRefresh` (src/lib/client-auth.ts) treats every 401 as an
 * expired session, rotates the refresh token, retries, and on a refresh failure
 * sends a signed-in person to /login. A user who simply has not connected
 * Microsoft 365 (or whose grant lapsed) is NOT signed out, so a provider
 * "not connected" answer must never be a 401:
 *
 *   - reads  (GET / HEAD): 200 `{ ...empty, connected: false, provider, error: "<provider>_not_connected", notice }`
 *     matching the unread-count / presence convention, so a widget renders its
 *     connect-or-empty state from a normal response.
 *   - actions (POST / PATCH / PUT / DELETE): 409 with the same body. A 200 would
 *     let a `res.ok` check report "sent" or "saved" for something that never
 *     happened; 409 says the request conflicts with the account's current state
 *     (no provider connection) without claiming the session is bad.
 *   - connected but missing a Graph scope: 403 `{ code: "scope_missing" }` per
 *     .ai/integrations.md (unchanged).
 *
 * `src/__tests__/no-provider-401.test.ts` fails the build if a route handler
 * answers 401 for a provider-connection reason.
 */

export type ConnectableProvider = "microsoft" | "quickbooks" | "plaud";

/** Status for a mutation that cannot run because the provider is not connected. */
export const NOT_CONNECTED_ACTION_STATUS = 409;

export const PROVIDER_LABEL: Record<ConnectableProvider, string> = {
  microsoft: "Microsoft 365",
  quickbooks: "QuickBooks",
  plaud: "Plaud",
};

export interface ProviderNotConnectedBody {
  connected: false;
  provider: ConnectableProvider;
  /** Stable machine code, e.g. "microsoft_not_connected". Kept so existing
   *  consumers that switch on `error` keep working. */
  error: `${ConnectableProvider}_not_connected`;
  /** Human-readable copy. Named `notice`, not `message`, because several
   *  read routes already use `message` as their data key (GET /api/mail/[id]). */
  notice: string;
}

export function notConnectedMessage(provider: ConnectableProvider): string {
  return `${PROVIDER_LABEL[provider]} is not connected. Connect it in Settings, Integrations.`;
}

export function notConnectedBody(provider: ConnectableProvider): ProviderNotConnectedBody {
  return {
    connected: false,
    provider,
    error: `${provider}_not_connected`,
    notice: notConnectedMessage(provider),
  };
}

/**
 * True when a parsed response body says the provider is not connected.
 * Accepts the current shape and the legacy `{ error: "microsoft_not_connected" }`
 * body so a consumer works across a deploy boundary.
 */
export function isProviderNotConnected(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as { connected?: unknown; error?: unknown };
  if (b.connected === false) return true;
  return typeof b.error === "string" && /_not_connected$/.test(b.error);
}
