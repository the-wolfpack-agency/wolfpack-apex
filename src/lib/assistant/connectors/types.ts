/**
 * Connector framework — typed adapter for external systems the Assistant
 * can query (CRMs, billing platforms, support tools, anything with a
 * REST API).
 *
 * Design:
 *   - Each connector is a small, named adapter that exposes typed
 *     methods the Assistant tools call.
 *   - Auth lives ENTIRELY in the connector — handlers never see the
 *     raw token. Credentials are loaded from env (Phase-4 first cut)
 *     and will move to per-tenant encrypted storage in a follow-up.
 *   - Every connector call emits typed analytics so the learning loop
 *     can measure latency, failure rate, and answer quality per
 *     connector — exactly the same observability story the tool
 *     dispatcher already gives us.
 *   - No connector is hardcoded into the Assistant — tools obtain a
 *     connector by name via the registry. Adding a new CRM is a
 *     matter of registering one more adapter; the tool surface stays
 *     stable.
 */

export interface ConnectorResult<R> {
  ok: boolean;
  data?: R;
  /** When ok=false, a stable error code the caller can switch on. */
  code?:
    | "not_configured"
    | "auth_failed"
    | "rate_limited"
    | "not_found"
    | "remote_error"
    | "network"
    | "validation";
  message?: string;
  /** Latency in ms — surfaced into analytics. */
  durationMs?: number;
}

/**
 * Minimal contract every connector implements. Different connectors
 * support different operations; an adapter that doesn't support an op
 * returns ok:false with code:"validation" + a clear message.
 */
export interface Connector {
  /** Stable identifier ("rest-default", "hubspot", "salesforce", ...). */
  readonly name: string;
  /** Free-text description for the available-connectors manifest. */
  readonly description: string;
  /**
   * Is the connector currently usable? Returns false when env / per-
   * tenant credentials are missing. Tools check this before dispatch.
   */
  isConfigured(): boolean;
  /**
   * Fetch a single record by object type + id. Object type is the
   * adapter's domain language ("contact", "deal", "company",
   * "invoice") — the adapter maps it to the vendor's endpoint.
   */
  getRecord(
    objectType: string,
    id: string,
  ): Promise<ConnectorResult<Record<string, unknown>>>;
  /**
   * Search records by free-text query. Returns the first N matches.
   * Adapters that don't support search return validation failure.
   */
  searchRecords(
    objectType: string,
    query: string,
    limit?: number,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>>;
  /**
   * Create a record. Returns the new record's id. Adapters that
   * don't support writes return validation failure. Action-tools
   * dispatching to this method go through the confirmation flow —
   * we never silently mutate a tenant's CRM.
   */
  createRecord?(
    objectType: string,
    fields: Record<string, unknown>,
  ): Promise<ConnectorResult<{ id: string }>>;
  /**
   * Update fields on an existing record. Returns ok with no payload
   * on success (Salesforce 204; HubSpot 200 with body). Same
   * mutation contract as createRecord — gated by confirmation.
   */
  updateRecord?(
    objectType: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<ConnectorResult<{ id: string }>>;
  /**
   * Related-record search: "Acme's open opportunities" / "Jorge's
   * tickets". Connector resolves the relationship via vendor-specific
   * SOQL/equivalent. Adapters without relationship support omit this.
   */
  searchRelated?(
    parentType: string,
    parentName: string,
    relatedType: string,
    limit?: number,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>>;
  /**
   * Filter-query search: structured FilterSpec composed by the tool
   * from regex extraction. The connector calls the vendor preset's
   * builder, then executes. Adapters without filter support omit this.
   */
  searchFiltered?(
    objectType: string,
    filters: import("./vendor-presets").FilterSpec,
    limit?: number,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>>;
  /**
   * Aggregate query — count, sum, avg, win-rate, or top-N. Connector
   * dispatches to the vendor preset's aggregateSearch.build which
   * returns both the request path and a typed parser for the result
   * shape (scalar / rate / list).
   */
  searchAggregate?(
    spec: import("./vendor-presets").AggregateSpec,
  ): Promise<ConnectorResult<import("./vendor-presets").AggregateResult>>;
}
