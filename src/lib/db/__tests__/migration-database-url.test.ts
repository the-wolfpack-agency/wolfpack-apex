/**
 * RLS cutover prerequisite 1 (docs/security/rls-cutover.md): schema work keeps
 * the owner connection after DATABASE_URL becomes the non-owner app role.
 *
 * Proves the rule (MIGRATION_DATABASE_URL, else DATABASE_URL, blank = unset),
 * and that every build-time script that does schema or seed work goes through
 * it rather than reading DATABASE_URL directly. The db-contract workflow proves
 * the same against a real Postgres by running migrate with a broken
 * DATABASE_URL and a working MIGRATION_DATABASE_URL.
 */
import fs from "fs";
import path from "path";
import { migrationDatabaseUrl, applyMigrationDatabaseUrl } from "../../../../scripts/migration-database-url.cjs";

const ROOT = path.resolve(__dirname, "../../../..");
const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

describe("migrationDatabaseUrl", () => {
  it("prefers MIGRATION_DATABASE_URL", () => {
    expect(migrationDatabaseUrl(env({ MIGRATION_DATABASE_URL: "postgres://owner", DATABASE_URL: "postgres://app" }))).toBe("postgres://owner");
  });

  it("falls back to DATABASE_URL when unset or blank (today's behavior)", () => {
    expect(migrationDatabaseUrl(env({ DATABASE_URL: "postgres://app" }))).toBe("postgres://app");
    expect(migrationDatabaseUrl(env({ MIGRATION_DATABASE_URL: "  ", DATABASE_URL: "postgres://app" }))).toBe("postgres://app");
    // A GitHub Actions secret that does not exist expands to "".
    expect(migrationDatabaseUrl(env({ MIGRATION_DATABASE_URL: "", DATABASE_URL: "postgres://app" }))).toBe("postgres://app");
  });

  it("is undefined when neither is set (shadow mode)", () => {
    expect(migrationDatabaseUrl(env({}))).toBeUndefined();
    expect(migrationDatabaseUrl(env({ DATABASE_URL: "" }))).toBeUndefined();
  });
});

describe("applyMigrationDatabaseUrl", () => {
  it("points DATABASE_URL at the owner connection for this process", () => {
    const e = env({ MIGRATION_DATABASE_URL: "postgres://owner", DATABASE_URL: "postgres://app" });
    expect(applyMigrationDatabaseUrl(e)).toBe("postgres://owner");
    expect(e.DATABASE_URL).toBe("postgres://owner");
  });

  it("changes nothing when MIGRATION_DATABASE_URL is unset", () => {
    const e = env({ DATABASE_URL: "postgres://app" });
    applyMigrationDatabaseUrl(e);
    expect(e.DATABASE_URL).toBe("postgres://app");
    const none = env({});
    expect(applyMigrationDatabaseUrl(none)).toBeUndefined();
    expect(none.DATABASE_URL).toBeUndefined();
  });
});

describe("build-time schema scripts use the migration connection", () => {
  const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

  it("migrate.mjs connects through migrationDatabaseUrl and never reads DATABASE_URL itself", () => {
    const src = read("scripts/migrate.mjs");
    expect(src).toMatch(/from "\.\/migration-database-url\.cjs"/);
    expect(src).toMatch(/connectionString: url/);
    expect(src).not.toMatch(/process\.env\.DATABASE_URL/);
  });

  it("check-upsert-targets.ts does the same", () => {
    const src = read("scripts/check-upsert-targets.ts");
    expect(src).toMatch(/from "\.\/migration-database-url\.cjs"/);
    expect(src).not.toMatch(/process\.env\.DATABASE_URL/);
  });

  it("seed-engineering-wiki.ts switches the pool before anything imports @/lib/db", () => {
    const lines = read("scripts/seed-engineering-wiki.ts").split("\n");
    const loadEnv = lines.findIndex((l) => l.startsWith('import "./load-env"'));
    const useMig = lines.findIndex((l) => l.startsWith('import "./use-migration-database-url"'));
    const firstLib = lines.findIndex((l) => /^import .* from "@\//.test(l));
    expect(loadEnv).toBeGreaterThanOrEqual(0);
    expect(useMig).toBeGreaterThan(loadEnv);
    expect(firstLib).toBeGreaterThan(useMig);
  });

  it("vercel-build still runs the three scripts before next build", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["vercel-build"]).toBe("npm run migrate && npm run check:upserts && npm run engineering:seed && next build");
  });
});
