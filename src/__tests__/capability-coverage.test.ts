/**
 * Capability coverage guardrail.
 *
 * Walks every route.ts under the "protected" API module dirs and asserts
 * the file contains a call to `requireCapability(` or is in the
 * explicit allowlist. Fails loudly with the list of missing files so a
 * new route can't silently ship without gating.
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";
import { CAPABILITY_ALLOWLIST } from "./CAPABILITY_ALLOWLIST";

/**
 * Module dirs under `src/app/api/` whose route.ts files must gate.
 * Some of these don't exist yet (hr, finance, tasks) — that's fine,
 * the walker just returns no files for those.
 */
const PROTECTED_MODULES = [
  "admin",
  "hr",
  "finance",
  "clients",
  "meetings",
  "docs",
  "journal",
  "tasks",
  "knowledge",
  "tools",
];

const REPO_ROOT = join(__dirname, "..", "..");
const API_ROOT = join(REPO_ROOT, "src", "app", "api");

function walkRoutes(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkRoutes(full, acc);
    else if (entry === "route.ts") acc.push(full);
  }
  return acc;
}

/** POSIX-style path from repo root. */
function posixRelative(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

describe("capability coverage", () => {
  for (const mod of PROTECTED_MODULES) {
    it(`every route.ts under src/app/api/${mod}/ calls requireCapability or is allowlisted`, () => {
      const dir = join(API_ROOT, mod);
      if (!existsSync(dir)) {
        // Nothing to check yet — forward-looking module not built.
        return;
      }
      const routes = walkRoutes(dir);
      const missing: string[] = [];
      for (const routePath of routes) {
        const rel = posixRelative(routePath);
        if (CAPABILITY_ALLOWLIST.includes(rel)) continue;
        const source = readFileSync(routePath, "utf8");
        if (!/requireCapability\s*\(/.test(source)) {
          missing.push(rel);
        }
      }
      if (missing.length > 0) {
        throw new Error(
          `Routes missing requireCapability() and not in CAPABILITY_ALLOWLIST:\n  ${missing.join("\n  ")}`,
        );
      }
    });
  }

  it("CAPABILITY_ALLOWLIST entries all point to real files", () => {
    const stale: string[] = [];
    for (const rel of CAPABILITY_ALLOWLIST) {
      if (!existsSync(join(REPO_ROOT, rel))) stale.push(rel);
    }
    expect(stale).toEqual([]);
  });
});
