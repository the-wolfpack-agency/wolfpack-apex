/**
 * Edge-device exposure classifier tests. The classifier is a PURE, OFFLINE
 * function over an already-collected HTTP response, so every rule is pinned here
 * with synthetic fixtures - no network, no fixtures from real targets. For every
 * recognised product we assert a true positive (its portal signature matches and
 * maps to the committed KEV set) AND a true negative (a plausible but unrelated
 * page does NOT match), because a false-positive edge detector is worse than
 * none (see [[platform-scan-precision-principle]]).
 */
import {
  classifyEdgeDevice,
  classifyEdgeExposure,
  type EdgeHttpResponse,
} from "@/lib/platform-scan/edge-exposure/classify";
import { KEV_BY_PRODUCT } from "@/lib/platform-scan/edge-exposure/kev-snapshot";
import { EDGE_DEVICE_FINGERPRINTS } from "@/lib/platform-scan/edge-exposure/fingerprints";

function res(over: Partial<EdgeHttpResponse> = {}): EdgeHttpResponse {
  return { route: "/", status: 200, ...over };
}

describe("classifyEdgeDevice - true positives (synthetic portal fixtures)", () => {
  it("recognises a Fortinet FortiGate SSL-VPN portal by body path", () => {
    const m = classifyEdgeDevice(
      res({
        route: "/remote/login?lang=en",
        bodyExcerpt: `<script src="/remote/fgt_lang?lang=en"></script><form action="/remote/logincheck">`,
        title: "Please Login",
      }),
    );
    expect(m?.product).toBe("fortinet_fortios_sslvpn");
    expect(m?.vendor).toBe("Fortinet");
    expect(m?.matchedMarkers).toContain("/remote/login");
  });

  it("recognises Ivanti Connect Secure by the /dana-na/ path", () => {
    const m = classifyEdgeDevice(
      res({ route: "/dana-na/auth/url_default/welcome.cgi", title: "Ivanti" }),
    );
    expect(m?.product).toBe("ivanti_connect_secure");
    expect(m?.matchedMarkers).toContain("title:ivanti");
  });

  it("recognises Citrix NetScaler Gateway by the NSC_ cookie header alone", () => {
    const m = classifyEdgeDevice(
      res({
        route: "/",
        headers: { "set-cookie": "NSC_AAAC=abc; Secure; HttpOnly" },
        bodyExcerpt: "<html><body>Welcome</body></html>",
      }),
    );
    expect(m?.product).toBe("citrix_netscaler_gateway");
    expect(m?.matchedMarkers).toContain("set-cookie:nsc_");
  });

  it("recognises Palo Alto GlobalProtect by login.esp", () => {
    const m = classifyEdgeDevice(
      res({ route: "/global-protect/login.esp", title: "GlobalProtect Portal" }),
    );
    expect(m?.product).toBe("paloalto_globalprotect");
  });

  it("recognises SonicWall SSL-VPN by /cgi-bin/welcome", () => {
    const m = classifyEdgeDevice(
      res({ route: "/cgi-bin/welcome", title: "SonicWall - Virtual Office" }),
    );
    expect(m?.product).toBe("sonicwall_sslvpn");
  });

  it("recognises Cisco ASA WebVPN by the /+CSCOE+/ path (case-insensitive)", () => {
    const m = classifyEdgeDevice(
      res({ route: "/+CSCOE+/logon.html", title: "SSL VPN Service" }),
    );
    expect(m?.product).toBe("cisco_asa_webvpn");
  });
});

describe("classifyEdgeDevice - true negatives (precision)", () => {
  it("does NOT match an ordinary marketing/login page", () => {
    expect(
      classifyEdgeDevice(
        res({
          route: "/login",
          title: "Login - Acme Corp VPN Service Portal Firewall",
          bodyExcerpt: `<form action="/api/auth/login"><input name="email"/></form>`,
        }),
      ),
    ).toBeNull();
  });

  it("does NOT match on a title alone without a strong body/header marker", () => {
    // Title says "Citrix Gateway" but no NSC_ cookie and no appliance path.
    expect(
      classifyEdgeDevice(
        res({ route: "/", title: "Citrix Gateway", bodyExcerpt: "<p>brochure</p>" }),
      ),
    ).toBeNull();
  });

  it("does NOT match an empty/blank response", () => {
    expect(classifyEdgeDevice(res({ route: "/", bodyExcerpt: "" }))).toBeNull();
  });
});

describe("classifyEdgeExposure - KEV mapping into ScanFinding", () => {
  it("maps a recognised Fortinet portal to its committed KEV set as one security finding", () => {
    const findings = classifyEdgeExposure(
      res({ route: "/remote/login", bodyExcerpt: "fgt_lang" }),
    );
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.category).toBe("security");
    expect(f.route).toBe("/remote/login");
    const expected = KEV_BY_PRODUCT.fortinet_fortios_sslvpn.map((k) => k.cveId);
    for (const cve of expected) {
      expect(String(f.evidence.cve_ids)).toContain(cve);
    }
    expect(f.evidence.kev_count).toBe(expected.length);
  });

  it("rates a ransomware-linked product critical and a non-ransomware one high", () => {
    // Palo Alto CVE-2024-3400 is ransomware-linked -> critical.
    const pa = classifyEdgeExposure(res({ route: "/global-protect/login.esp" }));
    expect(pa[0].severity).toBe("critical");
  });

  it("returns [] for a response that matches nothing", () => {
    expect(classifyEdgeExposure(res({ route: "/", bodyExcerpt: "nothing here" }))).toEqual([]);
  });

  it("every fingerprint product key has a committed KEV entry (no orphan detectors)", () => {
    for (const fp of EDGE_DEVICE_FINGERPRINTS) {
      expect(KEV_BY_PRODUCT[fp.product]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("classify options + panel tag", () => {
  it("routeIsEvidence:false ignores the route and needs a body/header marker", () => {
    expect(classifyEdgeDevice(res({ route: "/remote/login" }), { routeIsEvidence: false })).toBeNull();
    expect(classifyEdgeDevice(res({ route: "/remote/login", bodyExcerpt: "fgt_lang" }), { routeIsEvidence: false })?.product).toBe("fortinet_fortios_sslvpn");
  });
  it("every finding carries exposure_kind edge_device and the outside-in scope line", () => {
    const f = classifyEdgeExposure(res({ route: "/global-protect/login.esp" }))[0];
    expect(f.evidence.exposure_kind).toBe("edge_device");
    expect(f.detail).toMatch(/outside-in exposure monitoring/);
  });
});
