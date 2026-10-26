/**
 * Deterministic fingerprints for the public login / VPN-portal pages of common
 * edge devices (firewall + SSL-VPN appliances).
 *
 * PRECISION-FIRST (see [[platform-scan-precision-principle]]): every marker here
 * is a high-specificity, stable string that the vendor's portal ships and that
 * essentially never appears on an unrelated web app - a unique appliance URL path
 * (`/dana-na/`, `/global-protect/login.esp`, `/+CSCOE+/logon.html`) or a
 * vendor-specific session cookie name (`NSC_`, `svpncookie`, `DSID`). A fuzzy
 * keyword ("login", "vpn", "firewall") is deliberately NOT a marker: it would
 * train the operator to ignore the finding. A product matches only when a strong
 * body marker OR a vendor cookie marker is present; a title marker alone is never
 * enough (titles are trivially spoofable and generic).
 *
 * The matcher is a PURE function over an already-collected HTTP response. It does
 * NO network I/O - the response was captured upstream by the (gated, verified)
 * collector. Same response in, same match out.
 */

/** A header marker: a response header whose value contains a vendor signature. */
export interface HeaderMarker {
  /** Lower-cased header name, e.g. "set-cookie". */
  header: string;
  /** Lower-cased substring that must appear in the header value. */
  contains: string;
}

/** One edge-device product fingerprint. */
export interface EdgeDeviceFingerprint {
  /** Canonical product key; MUST match a key in KEV_BY_PRODUCT. */
  product: string;
  vendor: string;
  /** Human-readable product/portal name for findings. */
  displayName: string;
  /**
   * High-specificity body/URL markers (lower-cased). ANY one present in the
   * body excerpt or observed path is a strong match. These are unique appliance
   * paths/strings, never generic words.
   */
  strongMarkers: string[];
  /** Vendor-specific header markers (e.g. appliance session cookies). ANY one
   *  present is also a strong match, independent of the body. */
  headerMarkers?: HeaderMarker[];
  /** Supporting title substrings (lower-cased). NEVER sufficient alone; only
   *  recorded as corroborating evidence when a strong marker already matched. */
  titleMarkers?: string[];
}

export const EDGE_DEVICE_FINGERPRINTS: EdgeDeviceFingerprint[] = [
  {
    product: "fortinet_fortios_sslvpn",
    vendor: "Fortinet",
    displayName: "Fortinet FortiGate SSL-VPN portal",
    strongMarkers: ["/remote/login", "/sslvpn/portal", "fgt_lang", "/remote/fgt_lang"],
    headerMarkers: [{ header: "set-cookie", contains: "svpncookie" }],
    titleMarkers: ["fortinet", "fortigate"],
  },
  {
    product: "ivanti_connect_secure",
    vendor: "Ivanti",
    displayName: "Ivanti Connect Secure / Pulse Secure VPN portal",
    strongMarkers: ["/dana-na/", "/dana-cached/", "welcome.cgi?p=", "/dana/home/"],
    headerMarkers: [{ header: "set-cookie", contains: "dsid=" }],
    titleMarkers: ["ivanti", "pulse secure", "pulse connect secure"],
  },
  {
    product: "citrix_netscaler_gateway",
    vendor: "Citrix",
    displayName: "Citrix NetScaler Gateway portal",
    strongMarkers: ["/vpn/index.html", "/logon/logonpoint/", "ns_gui/vpn", "vpn/logout.html"],
    headerMarkers: [{ header: "set-cookie", contains: "nsc_" }],
    titleMarkers: ["citrix gateway", "netscaler", "citrix access gateway"],
  },
  {
    product: "paloalto_globalprotect",
    vendor: "Palo Alto Networks",
    displayName: "Palo Alto Networks GlobalProtect portal",
    strongMarkers: ["/global-protect/login.esp", "/global-protect/portal", "globalprotect portal"],
    titleMarkers: ["globalprotect"],
  },
  {
    product: "sonicwall_sslvpn",
    vendor: "SonicWall",
    displayName: "SonicWall SSL-VPN / SMA portal",
    strongMarkers: ["/cgi-bin/welcome", "/__api__/v1/logon", "sonicwall ssl-vpn", "usersslvpnlogin"],
    titleMarkers: ["sonicwall", "virtual office"],
  },
  {
    product: "cisco_asa_webvpn",
    vendor: "Cisco",
    displayName: "Cisco ASA / AnyConnect WebVPN portal",
    strongMarkers: ["/+cscoe+/logon.html", "/+webvpn+/", "/+cscou+/", "webvpnlogin"],
    titleMarkers: ["ssl vpn service", "anyconnect"],
  },
];
