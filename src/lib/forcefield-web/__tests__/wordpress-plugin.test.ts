/** @jest-environment node */
/**
 * Safety invariants for the WordPress plugin (integrations/wordpress/).
 *
 * The plugin's SYNTAX is verified in CI by php -l (.github/workflows/php-lint.yml);
 * the apex repo has no PHP runtime. What this pins are the security properties that
 * a syntax check cannot: dark-until-configured, watch-first, fail-open, and
 * SHAPE-ONLY forwarding (no request body / PII). If a future edit weakens one of
 * these, this test fails before it ships.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const php = readFileSync(
  join(process.cwd(), "integrations", "wordpress", "ogiam-forcefield", "ogiam-forcefield.php"),
  "utf8",
);

describe("wordpress plugin safety invariants", () => {
  it("is a valid plugin header + blocks direct access", () => {
    expect(php).toMatch(/Plugin Name:\s*OGIAM Forcefield/);
    expect(php).toMatch(/if \(!defined\('ABSPATH'\)\) \{ exit; \}/);
  });

  it("is dark until a site key is configured", () => {
    expect(php).toMatch(/if \(empty\(\$token\).*\) \{ return; \}/);
  });

  it("authorizes with the site key as x-edge-token (its own credential)", () => {
    expect(php).toMatch(/'x-edge-token'\s*=>\s*\$token/);
    expect(php).toContain("get_option('ogiam_ff_token'");
  });

  it("is watch-first: watch mode is fire-and-forget, blocking is gated on the enforce option", () => {
    expect(php).toContain("get_option('ogiam_ff_enforce', '') === 'on'");
    expect(php).toMatch(/'blocking'\s*=>\s*false/); // watch = non-blocking best-effort
    // the 403 block path exists only after the enforce branch returns
    const enforceIdx = php.indexOf("if (!$enforce)");
    const blockIdx = php.indexOf("status_header(403)");
    expect(enforceIdx).toBeGreaterThan(-1);
    expect(blockIdx).toBeGreaterThan(enforceIdx);
  });

  it("fails open on any engine error (never takes the site down)", () => {
    expect(php).toMatch(/if \(is_wp_error\(\$res\)\) \{ return; \}/);
  });

  it("forwards SHAPE only - never the request body or $_POST", () => {
    expect(php).not.toContain("$_POST");
    expect(php).not.toContain("php://input");
    expect(php).not.toContain("file_get_contents");
    // the body sent is built only from the shape fields
    for (const key of ["'site'", "'path'", "'method'", "'userAgent'", "'country'", "'headerNames'"]) {
      expect(php).toContain(key);
    }
  });

  it("never gates wp-admin", () => {
    expect(php).toMatch(/if \(is_admin\(\)\) \{ return; \}/);
  });
});
