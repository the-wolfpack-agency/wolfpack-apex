/**
 * Connector registry — process-wide directory of available external-
 * system adapters.
 *
 * Connectors register themselves at module load (side-effect import in
 * src/lib/assistant/connectors/index.ts). Tools look up by name via
 * getConnector(name). Unconfigured connectors stay registered but
 * report isConfigured()=false so the tool can return a deterministic
 * "set up the connector first" message instead of trying and failing.
 */

import type { Connector } from "./types";

const _registry = new Map<string, Connector>();

export function registerConnector(connector: Connector): void {
  _registry.set(connector.name, connector);
}

export function getConnector(name: string): Connector | null {
  return _registry.get(name) ?? null;
}

export function listConnectors(): Connector[] {
  return Array.from(_registry.values());
}

export function __resetConnectorRegistryForTests(): void {
  _registry.clear();
}
