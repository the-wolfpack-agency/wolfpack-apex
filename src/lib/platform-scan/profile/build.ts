/**
 * buildSystemProfile: compose the deterministic extractors over a target's repo
 * + current findings into a SystemProfile. All I/O is injected (discover repo
 * tree, read a file, summarize findings) so the builder is fully unit-testable
 * with no network or DB, and the same code path runs in production with the real
 * GitHub + store implementations.
 */
import { classifySurface, extractEntities, extractIntegrations, classifyAuth } from "./extract";
import type { SystemProfile } from "./types";

export interface BuildProfileDeps {
  /** List the target repo's file paths (GitHub tree). */
  discoverFiles: () => Promise<string[]>;
  /** Read one repo file's content, or null if absent. */
  readFile: (path: string) => Promise<string | null>;
  /** Open-finding counts by severity for the risk surface. */
  summarize: () => Promise<{ bySeverity: { critical: number; high: number; medium: number; low: number }; total: number }>;
}

export interface BuildProfileInput {
  platform: string;
  routes: ReadonlyArray<{ auth?: string }>;
  /** Cap on migration files read for entity extraction (bounds GitHub calls). */
  maxMigrations?: number;
}

export async function buildSystemProfile(input: BuildProfileInput, deps: BuildProfileDeps): Promise<SystemProfile> {
  const files = await deps.discoverFiles();
  const surface = classifySurface(files);

  // Entities: read the migration files (bounded) and pull CREATE TABLE names.
  const migrationFiles = files
    .filter((p) => /migrations?\/.*\.sql$/.test(p))
    .slice(0, input.maxMigrations ?? 60);
  const migrationContents = await Promise.all(
    migrationFiles.map((p) => deps.readFile(p).catch(() => null)),
  );
  const entities = extractEntities(migrationContents.filter((c): c is string => c !== null));

  // Integrations: read package.json from the repo root (or a couple common spots).
  let pkgRaw: string | null = null;
  for (const candidate of ["package.json", "app/package.json", "src/package.json"]) {
    pkgRaw = await deps.readFile(candidate).catch(() => null);
    if (pkgRaw) break;
  }
  const integrations = extractIntegrations(pkgRaw);

  const authModel = classifyAuth(input.routes);

  const s = await deps.summarize();
  const riskSummary = {
    critical: s.bySeverity.critical,
    high: s.bySeverity.high,
    medium: s.bySeverity.medium,
    low: s.bySeverity.low,
    total: s.total,
  };

  return {
    platform: input.platform,
    surface,
    entities,
    integrations,
    authModel,
    riskSummary,
    generatedAt: new Date().toISOString(),
  };
}
