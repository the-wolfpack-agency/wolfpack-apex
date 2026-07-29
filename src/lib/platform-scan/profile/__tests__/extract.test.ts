/**
 * Pure extractor tests: the SystemProfile is only trustworthy if every transform
 * is deterministic and exhaustively covered. These assert surface classification,
 * entity (table) extraction, integration detection from dependencies, and the
 * auth posture split, including the edge cases (test files, malformed JSON, null).
 */
import {
  classifySurface,
  extractEntities,
  extractIntegrations,
  classifyAuth,
} from "@/lib/platform-scan/profile/extract";

describe("classifySurface", () => {
  it("classifies a mixed set of paths into the right surface counts", () => {
    const paths = [
      "app/page.tsx",
      "app/api/x/route.ts",
      "components/Foo.tsx",
      "lib/foo.ts",
      "db/migrations/001_x.sql",
      "lib/__tests__/y.test.ts",
    ];
    const c = classifySurface(paths);
    expect(c.totalFiles).toBe(6);
    expect(c.pages).toBe(1);
    expect(c.apiRoutes).toBe(1);
    expect(c.components).toBe(1);
    expect(c.libModules).toBe(1);
    expect(c.migrations).toBe(1);
    expect(c.tests).toBe(1);
  });

  it("counts a .test.ts file as a test, not its other category", () => {
    // lib/foo.test.ts would otherwise match the lib-module pattern; the test
    // guard must win so a test file is never double-counted as a lib module.
    const c = classifySurface(["lib/foo.test.ts"]);
    expect(c.tests).toBe(1);
    expect(c.libModules).toBe(0);
    expect(c.totalFiles).toBe(1);
  });

  it("counts files under a __tests__/ segment as tests (unanchored branch)", () => {
    // The __tests__/ branch matches anywhere in the path, not just the start,
    // and only at a segment boundary. Guards the split-regex fix that replaced
    // the mixed-anchor alternation (CodeQL js/regex/missing-regexp-anchor).
    const c = classifySurface([
      "src/lib/foo/__tests__/bar.ts", // deep __tests__ dir
      "__tests__/root.ts", //            top-level __tests__ dir
    ]);
    expect(c.tests).toBe(2);
  });

  it("does not misclassify a path that merely contains 'test' as a test", () => {
    // Neither branch should fire: no __tests__/ segment, no .test/.spec suffix.
    // Proves the end-anchor still binds so `contest.ts` / `my__tests__data` are
    // not swept in.
    const c = classifySurface(["src/lib/contest.ts", "src/lib/attestation.ts"]);
    expect(c.tests).toBe(0);
    expect(c.libModules).toBe(2);
  });
});

describe("extractEntities", () => {
  it("pulls table names, deduped, sorted, lowercased", () => {
    const sql = [
      "CREATE TABLE foo (id uuid);",
      'CREATE TABLE IF NOT EXISTS "bar" (id uuid);',
      "create table baz_qux (",
    ];
    expect(extractEntities(sql)).toEqual(["bar", "baz_qux", "foo"]);
  });

  it("returns [] for empty or no-match input", () => {
    expect(extractEntities([])).toEqual([]);
    expect(extractEntities(["SELECT 1;", ""])).toEqual([]);
  });
});

describe("extractIntegrations", () => {
  it("maps runtime dependencies to known integrations, ignoring unknowns", () => {
    const raw = JSON.stringify({
      dependencies: {
        stripe: "1.0.0",
        twilio: "1.0.0",
        "@aws-sdk/client-s3": "1.0.0",
        pg: "1.0.0",
        leftpad: "1.0.0",
      },
    });
    const out = extractIntegrations(raw);
    const names = out.map((i) => i.name);
    expect(names).toEqual(expect.arrayContaining(["Stripe", "Twilio", "AWS", "Postgres/SQL"]));
    expect(names).not.toContain("leftpad");
  });

  it("ignores devDependencies", () => {
    const raw = JSON.stringify({ devDependencies: { stripe: "1.0.0" } });
    expect(extractIntegrations(raw)).toEqual([]);
  });

  it("returns [] for malformed JSON and null", () => {
    expect(extractIntegrations("{not json")).toEqual([]);
    expect(extractIntegrations(null)).toEqual([]);
  });
});

describe("classifyAuth", () => {
  it("splits routes into protected (auth required) vs public", () => {
    const out = classifyAuth([{ auth: "required" }, { auth: "public" }, {}]);
    expect(out).toEqual({ publicRoutes: 2, protectedRoutes: 1 });
  });
});
