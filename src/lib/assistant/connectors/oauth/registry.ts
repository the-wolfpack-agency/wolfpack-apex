/**
 * OAuth provider registry.
 *
 * Lookup by provider name (kebab-case). Adding a vendor (QBO, Jira,
 * GitHub, …) is a single-file change here: implement OAuthProvider,
 * import it, register it. The /start + /callback routes and the
 * refresh orchestrator are provider-agnostic.
 */

import type { OAuthProvider } from "./types";
import { salesforceProvider } from "./providers/salesforce";
import { hubspotProvider } from "./providers/hubspot";

const REGISTRY: Map<string, OAuthProvider> = new Map();

function register(p: OAuthProvider): void {
  REGISTRY.set(p.name, p);
}

register(salesforceProvider);
register(hubspotProvider);

export function getOAuthProvider(name: string): OAuthProvider | null {
  return REGISTRY.get(name) ?? null;
}

export function listOAuthProviders(): OAuthProvider[] {
  return Array.from(REGISTRY.values());
}

/** Test seam: wipe + re-seed so unit tests can isolate. Not for prod. */
export function __resetRegistryForTests(): void {
  REGISTRY.clear();
  register(salesforceProvider);
  register(hubspotProvider);
}

/** Test seam: register a custom provider (e.g. a mock with controllable
 *  exchangeCode / refresh implementations). Pair with __resetRegistryForTests
 *  in afterEach to keep tests isolated. */
export function __registerOAuthProviderForTests(p: OAuthProvider): void {
  REGISTRY.set(p.name, p);
}
