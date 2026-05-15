/**
 * Connectors barrel — importing this file registers every available
 * connector with the registry. Tools obtain connectors by name via
 * getConnector().
 */

/* eslint-disable @typescript-eslint/no-unused-vars */

import "./rest-connector";

export { registerConnector, getConnector, listConnectors, __resetConnectorRegistryForTests } from "./registry";
export type { Connector, ConnectorResult } from "./types";
export { RestConnector, buildRestConnectorForWorkspace } from "./rest-connector";
export {
  loadConnectorCredentials,
  saveConnectorCredentials,
  listConnectorCredentials,
  pickConfiguredConnector,
} from "./credentials";
export type { ConnectorCredentials, MaskedConnectorCredentials } from "./credentials";
