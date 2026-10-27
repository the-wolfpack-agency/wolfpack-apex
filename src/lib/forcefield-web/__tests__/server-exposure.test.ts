/** @jest-environment node */
/**
 * Version comparison and findings for "Is your server exposed?". The certainty
 * rule is the point: exposed / up to date only when the comparison is certain,
 * "could not check" for everything else.
 */
import {
  parseVersion,
  parsePluginVersion,
  compareParts,
  evaluateRule,
  buildExposureReport,
  exposureKeys,
  phpLine,
  type ServerInventory,
} from "../server-exposure";
import { FIXED_VERSION_RULES } from "@/lib/forcefield/kev/fixed-versions";

const PHP = FIXED_VERSION_RULES.find((r) => r.id === "php2shell")!;
const FILE_MANAGER = FIXED_VERSION_RULES.find((r) => r.id === "wp_file_manager_rce")!;
const DUPLICATOR = FIXED_VERSION_RULES.find((r) => r.id === "duplicator_file_download")!;

const inv = (o: Partial<ServerInventory> = {}): ServerInventory => ({
  phpVersion: "8.4.27",
  wordpressVersion: "6.8.3",
  serverSoftware: "Apache/2.4.62 (Debian)",
  plugins: [],
  pluginVersion: "0.4.0",
  ...o,
});

describe("parseVersion", () => {
  it.each([
    ["8.3.10", [8, 3, 10], "release"],
    ["8.4", [8, 4], "release"],
    [" 8.2.35 ", [8, 2, 35], "release"],
    ["8.1.2-1ubuntu2.20", [8, 1, 2], "distro"],
    ["8.2.7+deb12u1", [8, 2, 7], "distro"],
    ["8.3.0RC1", [8, 3, 0], "prerelease"],
    ["8.5.0-dev", [8, 5, 0], "prerelease"],
    ["8.4.0alpha2", [8, 4, 0], "prerelease"],
    ["8.3.10-rc.1", [8, 3, 10], "prerelease"],
  ])("%s", (raw, parts, kind) => {
    expect(parseVersion(raw)).toMatchObject({ parts, kind });
  });

  it.each([[""], ["8"], ["php8.3"], ["latest"], ["8.3.x"], ["8.3.10 beta"], [null], [undefined], [83], ["1".repeat(41)]])("rejects %p", (raw) => {
    expect(parseVersion(raw)).toBeNull();
  });
});

describe("parsePluginVersion and compareParts", () => {
  it("accepts plain numeric versions only", () => {
    expect(parsePluginVersion("6.9")?.parts).toEqual([6, 9]);
    expect(parsePluginVersion("1.3.28")?.parts).toEqual([1, 3, 28]);
    expect(parsePluginVersion("7")?.parts).toEqual([7]);
    for (const bad of ["6.9-beta", "v6.9", "", "6..9", null]) expect(parsePluginVersion(bad)).toBeNull();
  });

  it("compares numerically, treating missing segments as 0", () => {
    expect(compareParts([6, 9], [6, 9, 0])).toBe(0);
    expect(compareParts([8, 3, 9], [8, 3, 10])).toBe(-1); // not string order
    expect(compareParts([8, 10], [8, 9, 99])).toBe(1);
    expect(compareParts([1, 3, 28], [1, 3, 27, 9])).toBe(1);
  });
});

describe("PHP2Shell (per-line fixed releases)", () => {
  it.each([
    ["8.5.11", "exposed", "8.5.12"],
    ["8.5.12", "fixed", "8.5.12"],
    ["8.5.13", "fixed", "8.5.12"],
    ["8.4.26", "exposed", "8.4.27"],
    ["8.4.27", "fixed", "8.4.27"],
    ["8.3.35", "exposed", "8.3.36"],
    ["8.3.36", "fixed", "8.3.36"],
    ["8.3.9", "exposed", "8.3.36"],
    ["8.2.34", "exposed", "8.2.35"],
    ["8.2.35", "fixed", "8.2.35"],
    ["8.2.100", "fixed", "8.2.35"],
  ])("%s -> %s (fixed in %s)", (v, state, fixed) => {
    expect(evaluateRule(PHP, v)).toMatchObject({ state, fixed });
  });

  it("branches older than 8.2 are unsupported and exposed, whatever the patch level", () => {
    for (const v of ["8.1.34", "8.0.30", "7.4.33", "5.6.40"]) {
      const r = evaluateRule(PHP, v);
      expect(r.state).toBe("exposed");
      expect(r).toMatchObject({ fixed: "8.2.35", unsupportedLine: v.split(".").slice(0, 2).join(".") });
    }
  });

  it("a distribution build below the fix could carry a backport: could not check, never exposed", () => {
    expect(evaluateRule(PHP, "8.3.6-1ubuntu1")).toMatchObject({ state: "unknown", reason: "distro_build", fixed: "8.3.36" });
    expect(evaluateRule(PHP, "8.1.2-1ubuntu2.20")).toMatchObject({ state: "unknown", reason: "distro_build" });
  });

  it("a distribution build at or above the fix is fixed (the upstream fix is in it)", () => {
    expect(evaluateRule(PHP, "8.4.27-1+deb13u1")).toMatchObject({ state: "fixed" });
  });

  it("pre-releases are could not check, even on the fixed number", () => {
    expect(evaluateRule(PHP, "8.3.36RC1")).toMatchObject({ state: "unknown", reason: "prerelease" });
    expect(evaluateRule(PHP, "8.1.0-dev")).toMatchObject({ state: "unknown", reason: "prerelease" });
  });

  it("a release line newer than the data is could not check, never assumed safe", () => {
    expect(evaluateRule(PHP, "8.6.0")).toMatchObject({ state: "unknown", reason: "line_not_tracked" });
    expect(evaluateRule(PHP, "9.0.1")).toMatchObject({ state: "unknown", reason: "line_not_tracked" });
  });

  it("missing or unreadable versions are could not check", () => {
    expect(evaluateRule(PHP, null)).toMatchObject({ state: "unknown", reason: "no_version" });
    expect(evaluateRule(PHP, "")).toMatchObject({ state: "unknown", reason: "no_version" });
    expect(evaluateRule(PHP, "eight")).toMatchObject({ state: "unknown", reason: "unreadable_version" });
  });
});

describe("plugin rules (single fixed release)", () => {
  it("File Manager: before 6.9 exposed (NVD gives no lower bound), 6.9+ fixed", () => {
    expect(evaluateRule(FILE_MANAGER, "6.8")).toMatchObject({ state: "exposed", fixed: "6.9" });
    expect(evaluateRule(FILE_MANAGER, "6.0")).toMatchObject({ state: "exposed" });
    expect(evaluateRule(FILE_MANAGER, "5.9")).toMatchObject({ state: "exposed" });
    expect(evaluateRule(FILE_MANAGER, "6.9")).toMatchObject({ state: "fixed" });
    expect(evaluateRule(FILE_MANAGER, "7.2.1")).toMatchObject({ state: "fixed" });
    expect(evaluateRule(FILE_MANAGER, "6.9-beta")).toMatchObject({ state: "unknown", reason: "unreadable_version" });
  });

  it("a rule with affectedFrom: below the advisory range could not check", () => {
    const ranged = { ...FILE_MANAGER, affectedFrom: "6.0" };
    expect(evaluateRule(ranged, "5.9")).toMatchObject({ state: "unknown", reason: "older_than_advisory" });
    expect(evaluateRule(ranged, "6.0")).toMatchObject({ state: "exposed" });
  });

  it("Social Warfare: before 3.5.3 exposed", () => {
    const sw = FIXED_VERSION_RULES.find((r) => r.id === "social_warfare_xss")!;
    expect(evaluateRule(sw, "3.5.2")).toMatchObject({ state: "exposed", fixed: "3.5.3" });
    expect(evaluateRule(sw, "3.5.3")).toMatchObject({ state: "fixed" });
  });

  it("Duplicator: before 1.3.28 exposed", () => {
    expect(evaluateRule(DUPLICATOR, "1.3.26")).toMatchObject({ state: "exposed", fixed: "1.3.28" });
    expect(evaluateRule(DUPLICATOR, "1.3.28")).toMatchObject({ state: "fixed" });
    expect(evaluateRule(DUPLICATOR, "1.5.10")).toMatchObject({ state: "fixed" });
  });
});

describe("buildExposureReport", () => {
  it("an old PHP is exposed, in plain words, with who fixes it", () => {
    const r = buildExposureReport(inv({ phpVersion: "8.3.10" }));
    expect(r.status).toBe("exposed");
    const php = r.findings.find((f) => f.product === "php")!;
    expect(php).toMatchObject({
      key: "php2shell:php",
      state: "exposed",
      installed: "8.3.10",
      fixedVersion: "8.3.36",
      flaw: "PHP2Shell, PHP server takeover",
      cves: ["CVE-2026-109618", "CVE-2026-109619"],
    });
    expect(php.summary).toBe("Your server runs PHP 8.3.10, which is open to PHP2Shell, PHP server takeover: a single crafted request can take over the server before WordPress or any plugin runs.");
    expect(php.howToFix).toContain("Ask them to move this site to PHP 8.3.36 or later");
    expect(exposureKeys(r)).toEqual(["php2shell:php"]);
  });

  it("an unsupported PHP says so in the fix line", () => {
    const php = buildExposureReport(inv({ phpVersion: "7.4.33" })).findings[0];
    expect(php.howToFix).toMatch(/^PHP 7\.4 no longer gets security fixes\. .*PHP 8\.2\.35 or later/);
  });

  it("current versions are up to date; WordPress core is checked too", () => {
    const r = buildExposureReport(inv());
    expect(r.status).toBe("ok");
    expect(r.findings.map((f) => [f.key, f.state])).toEqual([["php2shell:php", "ok"], ["wordpress:core", "ok"]]);
    expect(exposureKeys(r)).toEqual([]);
  });

  it("a could-not-check PHP makes the whole report could not check (never up to date)", () => {
    const r = buildExposureReport(inv({ phpVersion: "8.3.6-1ubuntu1" }));
    expect(r.status).toBe("unknown");
    expect(r.findings[0].summary).toMatch(/^Could not check PHP 8\.3\.6-1ubuntu1 for PHP2Shell/);
  });

  it("an unreadable WordPress version is could not check", () => {
    const r = buildExposureReport(inv({ wordpressVersion: null }));
    expect(r.status).toBe("unknown");
    expect(r.findings.find((f) => f.key === "wordpress:core")).toMatchObject({ state: "unknown", reason: "no_version" });
  });

  it("only tracked plugins get a row; the rest are counted", () => {
    const r = buildExposureReport(inv({
      plugins: [
        { slug: "akismet", version: "5.3" },
        { slug: "wp-file-manager", version: "6.8" },
        { slug: "duplicator", version: "1.5.10" },
        { slug: "contact-form-7", version: "5.9" },
      ],
    }));
    expect(r.status).toBe("exposed");
    expect(r.otherPlugins).toBe(2);
    expect(r.findings.filter((f) => f.product === "wordpress_plugin").map((f) => [f.key, f.state])).toEqual([
      ["wp_file_manager_rce:wp-file-manager", "exposed"],
      ["duplicator_file_download:duplicator", "ok"],
    ]);
    expect(r.findings.find((f) => f.key.startsWith("wp_file_manager"))!.howToFix).toContain("Update File Manager to 6.9 or later");
  });

  it("exposed wins over could not check", () => {
    const r = buildExposureReport(inv({ phpVersion: "8.2.10", wordpressVersion: "nope" }));
    expect(r.status).toBe("exposed");
  });

  it("reports the KEV catalog date and the PHP line for analytics", () => {
    expect(buildExposureReport(inv()).kevCatalogDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(phpLine({ phpVersion: "8.3.10" })).toBe("8.3");
    expect(phpLine({ phpVersion: null })).toBe("unknown");
  });
});
