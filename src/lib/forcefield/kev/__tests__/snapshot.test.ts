/**
 * The checked-in KEV snapshot against the code that uses it (offline, so this
 * runs on every PR): every CVE the Forcefield rules and the edge-device map name
 * is in the snapshot, the generated file was not hand-edited, and the event
 * annotation is deterministic and cannot be forged by a client.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { KEV_SNAPSHOT, annotateKevProps, kevEntry, KEV_PROP_KEYS } from "..";
import { renderSnapshotFile } from "../refresh";
import { FORCEFIELD_KEV_CVES, KEV_PROBE_RULES } from "@/lib/forcefield-web/kev-rules";
import { EDGE_EXPOSURE_KEV_CVES } from "@/lib/platform-scan/edge-exposure/kev-snapshot";

describe("bundled KEV snapshot", () => {
  it("holds every CVE the code references, and only those", () => {
    const tracked = [...new Set([...FORCEFIELD_KEV_CVES, ...EDGE_EXPOSURE_KEV_CVES])].sort();
    expect(Object.keys(KEV_SNAPSHOT.entries).sort()).toEqual(tracked);
  });

  it("was produced by the refresh script (the file equals its own rendering)", () => {
    const onDisk = readFileSync(join(__dirname, "..", "catalog.generated.ts"), "utf8");
    expect(onDisk).toBe(renderSnapshotFile(KEV_SNAPSHOT));
  });

  it("records the CISA feed it came from and a catalog version", () => {
    expect(KEV_SNAPSHOT.source).toBe("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
    expect(KEV_SNAPSHOT.catalogVersion).toMatch(/^\d{4}\.\d{2}\.\d{2}$/);
  });

  it("every rule id is unique and maps to a snapshot entry", () => {
    const ids = KEV_PROBE_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of KEV_PROBE_RULES) expect(kevEntry(r.cve)).not.toBeNull();
  });
});

describe("annotateKevProps", () => {
  const rule = KEV_PROBE_RULES[0];

  it("annotates a probe event with the CVE and its KEV status", () => {
    const out = annotateKevProps("site.agent_probed_sensitive", { site: "s", probe: rule.id });
    const e = kevEntry(rule.cve)!;
    expect(out).toMatchObject({ site: "s", probe: rule.id, cve: rule.cve, kev: true, kev_added: e.dateAdded, kev_ransomware: e.knownRansomware, kev_catalog: KEV_SNAPSHOT.catalogVersion });
  });

  it("annotates a payload event from its attack family", () => {
    expect(annotateKevProps("site.agent_payload_attack", { attack: "log4shell" }).cve).toBe("CVE-2021-44228");
  });

  it("annotates the body-marker RCEs as KEV-listed (both PHP CVEs shipped in the snapshot)", () => {
    const php = annotateKevProps("site.agent_payload_attack", { attack: "php2shell" });
    expect(php).toMatchObject({ cve: "CVE-2026-109618", kev: true });
    expect(kevEntry("CVE-2026-109619")).not.toBeNull(); // the second PHP CVE is tracked too
    const react = annotateKevProps("site.agent_payload_attack", { attack: "react2shell" });
    expect(react).toMatchObject({ cve: "CVE-2025-55182", kev: true });
  });

  it("strips client-sent cve/kev props and re-derives them (no forging)", () => {
    const forged = annotateKevProps("site.agent_probed_sensitive", { probe: "/.env", cve: "CVE-2099-0001", kev: true, kev_added: "x", kev_ransomware: true, kev_catalog: "x" });
    for (const k of KEV_PROP_KEYS) expect(forged).not.toHaveProperty(k);
  });

  it("never annotates a non-hostile event type, and leaves the input untouched", () => {
    const input = { probe: rule.id };
    const out = annotateKevProps("site.page_viewed", input);
    expect(out).not.toHaveProperty("cve");
    expect(input).toEqual({ probe: rule.id });
  });

  it("handles absent props", () => {
    expect(annotateKevProps("site.agent_flagged", undefined)).toEqual({});
  });
});
