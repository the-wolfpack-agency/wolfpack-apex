/**
 * SystemProfile: the agent's knowledge model of a target platform, built by
 * deterministic static introspection of the target's repo (zero-token). It is
 * the spine that powers automation creation, the report System Map, and grounded
 * diagnosis: "what does this system consist of, what does it talk to, where is
 * the risk." Persisted (one row per workspace+platform) and ingested into the
 * Brain so it is semantically queryable. Derived + lossy; the repo + findings
 * tables remain the source of truth.
 */
export interface SurfaceCounts {
  pages: number;
  apiRoutes: number;
  components: number;
  libModules: number;
  migrations: number;
  tests: number;
  totalFiles: number;
}

export interface DetectedIntegration {
  /** Human name, e.g. "Stripe". */
  name: string;
  /** The npm package that revealed it, e.g. "@stripe/stripe-js". */
  package: string;
  /** Category, e.g. "Payments", "Email", "CRM", "Datastore". */
  category: string;
}

export interface SystemProfile {
  platform: string;
  surface: SurfaceCounts;
  /** Data-model entities (DB table names discovered in migrations). */
  entities: string[];
  /** External systems the target integrates with (from its dependencies). */
  integrations: DetectedIntegration[];
  /** Auth posture inferred from the route manifest. */
  authModel: { publicRoutes: number; protectedRoutes: number };
  /** Current risk surface (open findings by severity). */
  riskSummary: { critical: number; high: number; medium: number; low: number; total: number };
  generatedAt: string;
}
