/**
 * BriefForm contract test — source-level checks (jest is node env, no DOM
 * render). Asserts the form covers every supported section type, exports
 * the expected props shape, and shows a JSON-fallback toggle so power
 * users always have an escape hatch.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const SRC = path.join(ROOT, "src", "components", "sites", "BriefForm.tsx");

const SUPPORTED = ["hero", "text", "callout", "banner", "stats", "cards", "gallery", "quote"] as const;

describe("BriefForm component contract", () => {
  it("file exists", () => {
    expect(existsSync(SRC)).toBe(true);
  });

  const src = existsSync(SRC) ? readFileSync(SRC, "utf-8") : "";

  it("exports BriefForm + Brief type", () => {
    expect(src).toMatch(/export function BriefForm/);
    expect(src).toMatch(/export interface Brief\b/);
  });

  it("declares all 8 supported section types", () => {
    expect(src).toMatch(/SECTION_TYPES = \[[\s\S]*?\]/);
    for (const type of SUPPORTED) {
      expect(src).toContain(`"${type}"`);
    }
  });

  it("each section type has a case in SectionEditor", () => {
    for (const type of SUPPORTED) {
      expect(src).toMatch(new RegExp(`case\\s+"${type}"\\s*:`));
    }
  });

  it("provides a JSON-fallback toggle", () => {
    expect(src).toMatch(/showJson/);
    expect(src).toMatch(/Show JSON|Form view/);
  });

  it("supports add/remove/reorder section operations", () => {
    expect(src).toMatch(/addSection/);
    expect(src).toMatch(/removeSection/);
    expect(src).toMatch(/moveSection/);
  });

  it("validates stats values stay numeric (Number coercion in input handler)", () => {
    expect(src).toMatch(/Number\(e\.target\.value\)/);
  });
});

describe("migrate script smoke", () => {
  it("scripts/migrate.mjs exists and is executable as plain node", () => {
    const p = path.join(ROOT, "scripts", "migrate.mjs");
    expect(existsSync(p)).toBe(true);
    const s = readFileSync(p, "utf-8");
    expect(s).toContain('import pg from "pg"');
    expect(s).toContain("DATABASE_URL not set");
    // No-op safe path: no DATABASE_URL → warn-and-return, never throw
    expect(s).toMatch(/DATABASE_URL[\s\S]*return/);
  });
});

describe("Sites feature integration coverage", () => {
  it("9 new analytics events are registered in the taxonomy", () => {
    const taxonomy = readFileSync(
      path.join(ROOT, "src", "lib", "analytics.ts"),
      "utf-8",
    );
    for (const evt of [
      "site.created",
      "site.brief_updated",
      "site.asset_uploaded",
      "site.deploy_triggered",
      "site.deploy_succeeded",
      "site.deploy_failed",
      "site.brief_auto_parsed",
      "site.brief_parse_failed",
      "site.dropzone_used",
    ]) {
      expect(taxonomy).toContain(`"${evt}"`);
    }
  });

  it("template canary workflow ships an Instinct webhook step", () => {
    const wf = path.resolve(
      ROOT,
      "..",
      "wolfpack-site-template",
      ".github",
      "workflows",
      "canary-deploy.yml",
    );
    if (!existsSync(wf)) return; // template lives in a sibling repo, skip if not co-located
    const yml = readFileSync(wf, "utf-8");
    expect(yml).toContain("Notify Instinct");
    expect(yml).toContain("X-Wolfpack-Webhook-Secret");
    expect(yml).toContain("deployId");
  });
});
