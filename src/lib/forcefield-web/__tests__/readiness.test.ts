/**
 * @jest-environment node
 */
// Readiness gate: the synthetic-adversary battery, run offline against the bundled
// ruleset, so CI fails the moment any Forcefield defense stops firing (or starts
// false-positiving). The live-prod version is `npm run selftest:forcefield`.
import { classifyHosting, DATACENTER_SEED } from "../hosting";
import { detectPayload } from "../enforce";
import { classifyWebRequest } from "../classify";
import { classifyClient } from "../fingerprint";
import { DEFAULT_RULESET } from "../ruleset";
import { matchProbePath } from "@/lib/agent-probe-signatures";

describe("Forcefield readiness - every defense catches known-bad, holds on known-good", () => {
  it("hosting: cloud IP -> datacenter, residential -> residential", () => {
    // 34.64.0.0/10 is in the bundled seed; a residential IP is not.
    expect(classifyHosting("34.64.4.1", DATACENTER_SEED)).toBe("datacenter");
    expect(classifyHosting("24.60.1.1", DATACENTER_SEED)).toBe("residential");
    expect(classifyHosting("not-an-ip", DATACENTER_SEED)).toBe("unknown");
  });

  it("payload: injection attempts caught, benign not", () => {
    for (const p of ["/x?q=%27%20OR%201%3D1--", "/x?q=<script>alert(1)</script>", "/x?f=../../../../etc/passwd", "/x?url=http://169.254.169.254/", "/x?next=//evil.example.com"])
      expect(detectPayload("https://s" + p)).not.toBeNull();
    expect(detectPayload("https://s/search?q=hello+world")).toBeNull();
  });

  it("recon: sensitive-file probes recognized, normal path not", () => {
    for (const path of ["/.env", "/.git/config", "/wp-login.php", "/.aws/credentials"]) expect(matchProbePath(path)).not.toBeNull();
    expect(matchProbePath("/pricing")).toBeNull();
  });

  it("honeytoken: trap path -> trapped, normal path not", () => {
    const cfg = { trapPaths: DEFAULT_RULESET.trapPaths, knownAgents: DEFAULT_RULESET.knownAgents };
    expect(classifyWebRequest({ path: DEFAULT_RULESET.trapPaths[0], method: "GET", userAgent: "any" }, cfg).class).toBe("trapped");
    expect(classifyWebRequest({ path: "/pricing", method: "GET", userAgent: "Mozilla/5.0" }, cfg).class).not.toBe("trapped");
  });

  it("client: named scanners flagged, browser not", () => {
    expect(classifyClient("sqlmap/1.5.2", ["user-agent"], DEFAULT_RULESET.toolSignatures).clientType).toBe("scanner");
    expect(classifyClient("Nikto/2.1.6", ["user-agent"], DEFAULT_RULESET.toolSignatures).clientType).toBe("scanner");
    expect(classifyClient("Mozilla/5.0 (Macintosh) Chrome/120", ["user-agent", "accept", "accept-language", "sec-fetch-dest"], DEFAULT_RULESET.toolSignatures).clientType).not.toBe("scanner");
  });
});
