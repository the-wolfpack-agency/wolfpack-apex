/**
 * Server-side response for "the provider is not connected".
 *
 * Every route that learns from the integrations layer that the user has no
 * usable provider connection answers through `providerNotConnected()`. Never a
 * 401: see `./connection-state.ts` for the rule and why.
 *
 *   GET / HEAD           -> 200 { ...empty, connected: false, provider, error, notice }
 *   any other method     -> 409 { connected: false, provider, error, notice }
 *
 * Each answer emits `integration.not_connected_served` so the learning loop can
 * see which surfaces people reach before connecting a provider.
 */

import { NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics";
import {
  NOT_CONNECTED_ACTION_STATUS,
  notConnectedBody,
  type ConnectableProvider,
} from "./connection-state";

export {
  NOT_CONNECTED_ACTION_STATUS,
  notConnectedBody,
  isProviderNotConnected,
  type ConnectableProvider,
} from "./connection-state";

export interface NotConnectedUser {
  id: string;
  role: string;
}

export interface ProviderNotConnectedOptions {
  /** The empty payload a read returns, e.g. `{ messages: [] }`, so a consumer
   *  that only reads the data key still renders an empty list. Ignored for
   *  actions. */
  empty?: Record<string, unknown>;
  /** Short route label for analytics, e.g. "emails/inbox". */
  surface?: string;
}

function isRead(method: string | undefined): boolean {
  const m = (method ?? "GET").toUpperCase();
  return m === "GET" || m === "HEAD";
}

export function providerNotConnected(
  req: { method?: string },
  user: NotConnectedUser | null,
  provider: ConnectableProvider,
  opts: ProviderNotConnectedOptions = {},
): NextResponse {
  const read = isRead(req.method);
  if (user) {
    trackEvent("integration.not_connected_served", user.id, user.role, {
      provider,
      method: (req.method ?? "GET").toUpperCase(),
      surface: opts.surface ?? "unknown",
    });
  }
  const body = notConnectedBody(provider);
  if (read) {
    return NextResponse.json({ ...(opts.empty ?? {}), ...body }, { status: 200 });
  }
  return NextResponse.json(body, { status: NOT_CONNECTED_ACTION_STATUS });
}
