/**
 * Choosing which client's database a request uses.
 *
 * Every test here is about the one property the whole architecture rests on:
 * a request must never reach a database it was not resolved to. Instinct is
 * sold per client with a database each, so this file IS the tenant boundary —
 * there is no predicate behind it to catch a mistake.
 *
 * The tests that matter most are the ones asserting it THROWS. A fallback to
 * some default database would turn every bug that loses the tenant into a
 * silent, successful read of another company's data.
 */
import {
  configuredTenants,
  connectionStringFor,
  dbMode,
  isValidTenantId,
  resolveTenant,
  tenantEnvVar,
  TenantResolutionError,
} from "../tenant";

const env = (over: Record<string, string> = {}) => over as unknown as NodeJS.ProcessEnv;

describe("it is inert until switched on", () => {
  it("defaults to single mode, so merging this changes nothing in production", () => {
    // A change this significant must not alter behaviour the moment it lands.
    expect(dbMode(env())).toBe("single");
    expect(dbMode(env({ INSTINCT_DB_MODE: "" }))).toBe("single");
    expect(dbMode(env({ INSTINCT_DB_MODE: "anything-else" }))).toBe("single");
  });

  it("uses DATABASE_URL in single mode and ignores the tenant entirely", () => {
    const e = env({ DATABASE_URL: "postgres://one" });
    expect(connectionStringFor(undefined, e)).toBe("postgres://one");
    expect(connectionStringFor("acme", e)).toBe("postgres://one");
  });

  it("only routes when explicitly asked to", () => {
    expect(dbMode(env({ INSTINCT_DB_MODE: "routed" }))).toBe("routed");
  });
});

describe("routed mode has no default database", () => {
  const routed = { INSTINCT_DB_MODE: "routed", DATABASE_URL: "postgres://wolfpacks-own-db" };

  it("THROWS with no tenant in scope rather than falling back", () => {
    // The single most important assertion in this file. A fallback here is the
    // entire vulnerability: a lost tenant would read someone else's data
    // successfully and silently.
    expect(() => connectionStringFor(undefined, env(routed))).toThrow(TenantResolutionError);
  });

  it("does not use DATABASE_URL even though it is set", () => {
    // DATABASE_URL is Wolfpack's own instance. Reaching it while serving a
    // client would be the worst possible cross-tenant read.
    try {
      connectionStringFor(undefined, env(routed));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as Error).message).not.toContain("wolfpacks-own-db");
      expect((err as Error).message).toMatch(/no default database/i);
    }
  });

  it("THROWS for a tenant that has no database configured", () => {
    expect(() => connectionStringFor("acme", env(routed))).toThrow(/no database configured for tenant 'acme'/);
  });

  it("names the missing variable, because that is the fix", () => {
    try {
      connectionStringFor("acme", env(routed));
    } catch (err) {
      expect((err as Error).message).toContain("INSTINCT_TENANT_DB_ACME");
    }
  });

  it("returns the tenant's own connection string when configured", () => {
    const e = env({ ...routed, INSTINCT_TENANT_DB_ACME: "postgres://acme-db" });
    expect(connectionStringFor("acme", e)).toBe("postgres://acme-db");
  });

  it("keeps two tenants on two different databases", () => {
    const e = env({ ...routed, INSTINCT_TENANT_DB_ACME: "postgres://a", INSTINCT_TENANT_DB_BETA: "postgres://b" });
    expect(connectionStringFor("acme", e)).toBe("postgres://a");
    expect(connectionStringFor("beta", e)).toBe("postgres://b");
  });
});

describe("a tenant id cannot be used to reach configuration it should not", () => {
  it.each([
    "",
    "a",
    "ACME",
    "acme db",
    "acme_db",
    "acme/../other",
    "acme;DROP",
    "acme$(x)",
    "-acme",
    "acme-",
    "a".repeat(64),
  ])("refuses %j", (id) => {
    // The id builds an environment variable NAME, so an unconstrained one is an
    // injection into configuration lookup.
    expect(isValidTenantId(id)).toBe(false);
    expect(() => resolveTenant(id as string, env({ INSTINCT_DB_MODE: "routed" }))).toThrow(TenantResolutionError);
  });

  it.each(["acme", "acme-co", "a1", "north-star-media"])("accepts %j", (id) => {
    expect(isValidTenantId(id)).toBe(true);
  });

  it("refuses a non-string without throwing something unexpected", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(isValidTenantId(bad)).toBe(false);
    }
  });

  it("never echoes a connection string in an error", () => {
    // Errors reach logs and sometimes responses. A credential in one is a
    // credential leak with a stack trace attached.
    const e = env({ INSTINCT_DB_MODE: "routed", INSTINCT_TENANT_DB_ACME: "postgres://user:secret@host/db" });
    try {
      resolveTenant("nope", e);
    } catch (err) {
      expect((err as Error).message).not.toContain("secret");
      expect((err as Error).message).not.toContain("postgres://");
    }
  });
});

describe("tenantEnvVar", () => {
  it("maps a tenant to a stable variable name", () => {
    expect(tenantEnvVar("acme")).toBe("INSTINCT_TENANT_DB_ACME");
    expect(tenantEnvVar("north-star")).toBe("INSTINCT_TENANT_DB_NORTH_STAR");
  });
});

describe("configuredTenants", () => {
  it("lists the tenants this deployment can serve", () => {
    const e = env({
      INSTINCT_TENANT_DB_ACME: "postgres://a",
      INSTINCT_TENANT_DB_NORTH_STAR: "postgres://b",
      DATABASE_URL: "postgres://own",
    });
    expect(configuredTenants(e)).toEqual(["acme", "north-star"]);
  });

  it("ignores a variable that is set but empty", () => {
    // The shape a half-finished deployment leaves behind. Listing it would make
    // the migration runner try to fan out to a database that does not exist.
    expect(configuredTenants(env({ INSTINCT_TENANT_DB_ACME: "   " }))).toEqual([]);
  });

  it("returns nothing when no tenants are configured", () => {
    expect(configuredTenants(env({ DATABASE_URL: "postgres://own" }))).toEqual([]);
  });
});
