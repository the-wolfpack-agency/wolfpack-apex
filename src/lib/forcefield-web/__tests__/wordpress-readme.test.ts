/** @jest-environment node */
/**
 * WordPress.org submission readiness for the plugin readme.txt. A malformed readme
 * is rejected by the WordPress.org validator, and a Stable tag that drifts from the
 * plugin's actual Version ships the wrong code. This pins both so neither can rot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WP = join(process.cwd(), "integrations", "wordpress", "ogiam-forcefield");
const readme = readFileSync(join(WP, "readme.txt"), "utf8");
const plugin = readFileSync(join(WP, "ogiam-forcefield.php"), "utf8");

describe("wordpress.org readme.txt", () => {
  it("has the required header fields", () => {
    expect(readme).toMatch(/^=== OGIAM Forcefield ===/m);
    for (const field of ["Stable tag:", "Tested up to:", "Requires at least:", "Requires PHP:", "License:"]) {
      expect(readme).toContain(field);
    }
  });

  it("Stable tag matches the plugin's Version (never ship the wrong code)", () => {
    const stable = readme.match(/Stable tag:\s*([0-9.]+)/)?.[1];
    const version = plugin.match(/Version:\s*([0-9.]+)/)?.[1];
    expect(stable).toBeTruthy();
    expect(stable).toBe(version);
  });

  it("documents the required sections (Installation + Changelog)", () => {
    expect(readme).toMatch(/== Installation ==/);
    expect(readme).toMatch(/== Changelog ==/);
  });
});

describe("publishing runbook", () => {
  const runbook = readFileSync(join(process.cwd(), "integrations", "PUBLISHING.md"), "utf8");
  it("covers every external go-live step", () => {
    for (const step of ["Redirect URL", "MARKETPLACE_VERCEL_CLIENT_ID", "WordPress.org", "wrangler deploy", "FORCEFIELD_DISTRIBUTE_BLOCKS"]) {
      expect(runbook).toContain(step);
    }
  });
});
