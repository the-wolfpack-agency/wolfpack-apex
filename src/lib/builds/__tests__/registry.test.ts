/**
 * The register cannot drift from what is actually deployed.
 *
 * A build listed but not routed is a broken link on a page whose job is
 * telling people where the work is. A route not listed is the original defect
 * back again: a client page in the shell with nothing saying so.
 */

import { existsSync } from "node:fs";
import { readdirSync } from "node:fs";
import path from "node:path";
import { CLIENT_BUILDS, buildFor } from "@/lib/builds/registry";

const DASHBOARD = path.join(process.cwd(), "src", "app", "(dashboard)");

describe("the client-build register", () => {
  it("routes every build it lists", () => {
    for (const b of CLIENT_BUILDS) {
      const dir = path.join(DASHBOARD, ...b.href.split("/").filter(Boolean));
      expect(existsSync(path.join(dir, "page.tsx"))).toBe(true);
    }
  });

  /* THE ORIGINAL DEFECT, ASSERTED. Every page under /builds must be in the
     register, because the register is what puts the banner on it. */
  it("lists every page under /builds", () => {
    const buildsDir = path.join(DASHBOARD, "builds");
    const children = readdirSync(buildsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("__"))
      .map((d) => `/builds/${d.name}`);
    for (const href of children) {
      expect(buildFor(href)).toBeDefined();
    }
  });

  /* The field that changes the conversation. A build without it produces a
     screenshot indistinguishable from a shipped product. */
  it("makes every build say what its numbers are", () => {
    for (const b of CLIENT_BUILDS) {
      expect(b.data.length).toBeGreaterThan(40);
      expect(b.client.trim()).not.toBe("");
      expect(b.what.length).toBeGreaterThan(40);
    }
  });

  it("has no duplicate paths", () => {
    const hrefs = CLIENT_BUILDS.map((b) => b.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it("finds nothing for a path that is not a build", () => {
    expect(buildFor("/assistant")).toBeUndefined();
  });
});
