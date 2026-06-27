/**
 * buildSystemProfile composition test: all I/O is injected (discover, read,
 * summarize) so the builder runs with no network or DB. Asserts the extractors
 * are wired together correctly, surface counts, entities from migrations,
 * integrations from package.json, the auth model from the route manifest, and
 * the risk summary from the findings summarizer.
 */
import { buildSystemProfile } from "@/lib/platform-scan/profile/build";

it("composes the extractors over injected repo + findings signals", async () => {
  const files = [
    "app/page.tsx",
    "app/api/x/route.ts",
    "db/migrations/001_a.sql",
    "lib/foo.ts",
    "components/B.tsx",
  ];
  const deps = {
    discoverFiles: async () => files,
    readFile: async (path: string): Promise<string | null> => {
      if (path === "db/migrations/001_a.sql") return "CREATE TABLE leads (id uuid);";
      if (path === "package.json") return JSON.stringify({ dependencies: { stripe: "1" } });
      return null;
    },
    summarize: async () => ({
      bySeverity: { critical: 1, high: 2, medium: 0, low: 0 },
      total: 3,
    }),
  };

  const profile = await buildSystemProfile(
    { platform: "acme", routes: [{ auth: "required" }] },
    deps,
  );

  expect(profile.platform).toBe("acme");
  expect(profile.surface.pages).toBe(1);
  expect(profile.surface.apiRoutes).toBe(1);
  expect(profile.surface.migrations).toBe(1);
  expect(profile.entities).toContain("leads");
  expect(profile.integrations.map((i) => i.name)).toContain("Stripe");
  expect(profile.authModel.protectedRoutes).toBe(1);
  expect(profile.riskSummary.critical).toBe(1);
  expect(profile.riskSummary.total).toBe(3);
  // generatedAt is a valid ISO timestamp.
  expect(typeof profile.generatedAt).toBe("string");
  expect(new Date(profile.generatedAt).toISOString()).toBe(profile.generatedAt);
});
