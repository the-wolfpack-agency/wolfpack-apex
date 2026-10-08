/** @jest-environment node */
/**
 * Deployable-config parity for the Cloudflare Worker (integrations/cloudflare/).
 *
 * The Worker LOGIC is covered by cloudflare-worker.test.ts + the fail-open test; a
 * real `wrangler deploy` needs a Cloudflare account and is verified there, not here.
 * What this pins is that the deploy CONFIG cannot silently drift from the adapter:
 *   - wrangler.toml's `main` points at the real, existing adapter file, and
 *   - every env binding the adapter reads (ForcefieldWorkerEnv) is documented in
 *     wrangler.toml, so onboarding never hands a client a config missing a var.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const CF_DIR = join(process.cwd(), "integrations", "cloudflare");
const toml = readFileSync(join(CF_DIR, "wrangler.toml"), "utf8");
const readme = readFileSync(join(CF_DIR, "README.md"), "utf8");
const adapterSrc = readFileSync(join(process.cwd(), "src", "lib", "forcefield-web", "adapters", "cloudflare-worker.ts"), "utf8");

/** The env field names the adapter actually declares in ForcefieldWorkerEnv. */
function adapterEnvFields(): string[] {
  const block = adapterSrc.match(/interface ForcefieldWorkerEnv\s*\{([\s\S]*?)\n\}/);
  expect(block).not.toBeNull();
  return Array.from(block![1].matchAll(/^\s*([A-Z0-9_]+)\??:/gm)).map((m) => m[1]);
}

describe("cloudflare deployable config", () => {
  it("main points at the real, existing adapter file", () => {
    const main = toml.match(/^main\s*=\s*"([^"]+)"/m)?.[1];
    expect(main).toBeTruthy();
    const resolved = resolve(CF_DIR, main!);
    expect(existsSync(resolved)).toBe(true);
    expect(resolved.endsWith("adapters/cloudflare-worker.ts")).toBe(true);
  });

  it("declares name + a valid compatibility_date", () => {
    expect(toml).toMatch(/^name\s*=\s*"forcefield-edge"/m);
    expect(toml).toMatch(/^compatibility_date\s*=\s*"\d{4}-\d{2}-\d{2}"/m);
  });

  it("documents EVERY env binding the adapter reads (no missing var)", () => {
    const fields = adapterEnvFields();
    expect(fields.length).toBeGreaterThanOrEqual(5); // sanity: the interface parsed
    for (const f of fields) {
      // present either as a [vars] entry or (for the secret token) a documented line
      expect(toml.includes(f)).toBe(true);
    }
  });

  it("is watch-first + fail-open in the docs (never claims it blocks by default)", () => {
    expect(toml).toMatch(/FORCEFIELD_ENFORCE\s*=\s*"off"/);
    expect(readme.toLowerCase()).toContain("monitor-first");
    expect(readme.toLowerCase()).toContain("fail-open");
  });

  it("keeps the site key a SECRET (never a plaintext var)", () => {
    // The token must NOT appear as a [vars] assignment; it is a wrangler secret.
    expect(toml).not.toMatch(/^\s*SITE_ANALYTICS_INGEST_TOKEN\s*=/m);
    expect(toml).toMatch(/wrangler secret put SITE_ANALYTICS_INGEST_TOKEN/);
  });
});
