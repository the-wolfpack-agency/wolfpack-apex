/**
 * The GTM docs registry, checked against the REAL files on disk. This is the
 * guard that the in-app viewer and docs/forcefield/*.md never drift: every
 * registered doc must resolve to a file that exists and has content, keys are
 * unique, and an unregistered key reads nothing (no path traversal).
 */
import { GTM_DOCS, listGtmDocs, gtmDocByKey, readGtmDoc } from "../gtm-docs";

it("every registered doc resolves to a real, non-empty file", () => {
  for (const d of GTM_DOCS) {
    const md = readGtmDoc(d.key);
    if (md == null) throw new Error(`doc "${d.key}" (${d.file}) should exist on disk`);
    expect(md.length).toBeGreaterThan(50);
  }
});

it("keys are unique and the set covers the commercial + legal docs", () => {
  const keys = GTM_DOCS.map((d) => d.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const k of ["pricing", "licensing", "sla", "security", "subprocessors", "tos", "privacy", "dpa", "aup"]) {
    expect(keys).toContain(k);
  }
});

it("listGtmDocs returns metadata only (no bodies)", () => {
  const list = listGtmDocs();
  expect(list[0]).toHaveProperty("title");
  expect(list[0]).not.toHaveProperty("html");
  expect(gtmDocByKey("pricing")?.file).toBe("pricing-and-packaging.md");
});

it("an unregistered key reads nothing (no arbitrary-path read)", () => {
  expect(readGtmDoc("../../../etc/passwd")).toBeNull();
  expect(readGtmDoc("nope")).toBeNull();
  expect(gtmDocByKey("nope")).toBeUndefined();
});
