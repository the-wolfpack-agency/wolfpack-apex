/**
 * Forcefield for the Web - CVE probe rules for actively exploited vulnerabilities.
 *
 * Each rule names ONE CVE on the CISA Known Exploited Vulnerabilities (KEV)
 * catalog and the request shape its public exploits send. A match labels the
 * observation's probe (`kev_<rule>`), so the board can say which known-exploited
 * CVE a request was aimed at. Every CVE id here must exist in the bundled KEV
 * snapshot (src/lib/forcefield/kev/catalog.generated.ts); a jest test and
 * `npm run kev:check` both fail otherwise, so an id cannot be invented.
 *
 * WHAT A MATCH MEANS (precision first, the same stance as the rest of the core):
 *   - It is a PROBE: report-only, an intent signal (intent.ts kev_exploit_path),
 *     never a block on its own. Intent may step a session up to watch / tarpit;
 *     a hard block still needs proof (decoy, payload, attack tool, operator
 *     block) through decideEnforcement. A KEV probe is never proof, so it never
 *     feeds an automatic fingerprint block or the intent carryover list.
 *   - Only an ANONYMOUS request matches: an admin's own signed-in use of a
 *     plugin endpoint is not an exploit.
 *   - The edge-device rules describe what the REQUEST targeted. Forcefield does
 *     not sit in front of a firewall or VPN appliance and does not protect one.
 *
 * Rules are keyed on exploit-specific paths and parameters, never on a generic
 * word. Matchers are plain string tests (no backtracking regex on input).
 *
 * PURE + EDGE-SAFE: no I/O, no imports. Part of the vendored portable core.
 */

export interface KevProbeRule {
  /** Stable probe id stamped on the observation (props.probe). */
  id: string;
  /** The KEV CVE this request shape exploits. */
  cve: string;
  /** "wordpress" | "php" | "edge_device" - the family, for the board. */
  family: "wordpress" | "php" | "edge_device";
  test: (ctx: KevMatchContext) => boolean;
}

export interface KevMatchContext {
  /** Lowercased pathname. */
  path: string;
  /** Lowercased raw target (pathname + query), percent-decoded when possible. */
  raw: string;
  /** Query parameters (names lowercased), from the raw target. */
  params: URLSearchParams | null;
}

function param(ctx: KevMatchContext, name: string): string {
  return (ctx.params?.get(name) ?? "").toLowerCase();
}

/** A traversal sequence in a value, raw or encoded. */
function hasTraversal(v: string): boolean {
  return v.includes("../") || v.includes("..\\") || v.includes("%2e%2e") || v.includes("..%2f");
}

function endsWithSegment(path: string, suffix: string): boolean {
  return path === suffix || path.endsWith(suffix);
}

export const KEV_PROBE_RULES: readonly KevProbeRule[] = [
  // ---- WordPress plugins (CISA KEV) ----
  {
    // WP File Manager unauthenticated elFinder connector (upload + run PHP).
    id: "kev_wp_file_manager_connector",
    cve: "CVE-2020-25213",
    family: "wordpress",
    test: (c) => c.path.endsWith("/wp-content/plugins/wp-file-manager/lib/php/connector.minimal.php"),
  },
  {
    // Duplicator unauthenticated file download via admin-ajax.
    id: "kev_wp_duplicator_download",
    cve: "CVE-2020-11738",
    family: "wordpress",
    test: (c) => endsWithSegment(c.path, "/wp-admin/admin-ajax.php") && param(c, "action") === "duplicator_download",
  },
  {
    // Social Warfare swp_debug=load_options remote options load (RCE chain).
    id: "kev_wp_social_warfare_load_options",
    cve: "CVE-2019-9978",
    family: "wordpress",
    test: (c) => endsWithSegment(c.path, "/wp-admin/admin-post.php") && param(c, "swp_debug") === "load_options",
  },
  // ---- PHP (CISA KEV) ----
  {
    // PHPUnit eval-stdin.php left in a deployed vendor/ directory.
    id: "kev_phpunit_eval_stdin",
    cve: "CVE-2017-9841",
    family: "php",
    test: (c) => c.path.endsWith("/phpunit/src/util/php/eval-stdin.php"),
  },
  {
    // PHP-CGI argument injection through the Windows best-fit soft hyphen.
    id: "kev_php_cgi_soft_hyphen",
    cve: "CVE-2024-4577",
    family: "php",
    test: (c) => (c.raw.includes("?%add") || c.raw.includes("?­d")) && c.raw.includes("allow_url_include"),
  },
  {
    // PHP-CGI query-string -d switch (the original form the 2024 bug bypassed).
    id: "kev_php_cgi_query_switch",
    cve: "CVE-2012-1823",
    family: "php",
    test: (c) => {
      const q = c.raw.indexOf("?");
      if (q === -1) return false;
      const query = c.raw.slice(q + 1);
      return (query.startsWith("-d+") || query.startsWith("-d ") || query.startsWith("-d%20")) &&
        (query.includes("allow_url_include") || query.includes("auto_prepend_file"));
    },
  },
  // ---- Edge devices: the request targeted an appliance's known exploit path ----
  {
    // FortiOS SSL-VPN fgt_lang path traversal (session file read).
    id: "kev_fortios_fgt_lang_traversal",
    cve: "CVE-2018-13379",
    family: "edge_device",
    test: (c) => c.path === "/remote/fgt_lang" && hasTraversal(param(c, "lang")),
  },
  {
    // Pulse Connect Secure arbitrary file read via the html5acc guacamole path.
    id: "kev_pulse_html5acc_file_read",
    cve: "CVE-2019-11510",
    family: "edge_device",
    // The traversal is often normalized out of the path by the edge, but the
    // exploit repeats the html5acc marker in the query, so match either form.
    test: (c) => c.raw.includes("/dana/html5acc/guacamole/") && (hasTraversal(c.raw) || c.raw.includes("/etc/passwd")),
  },
  {
    // Citrix ADC / Gateway directory traversal into /vpns/.
    id: "kev_citrix_vpns_traversal",
    cve: "CVE-2019-19781",
    family: "edge_device",
    test: (c) => c.path.startsWith("/vpns/portal/scripts/") || c.path === "/vpns/cfg/smb.conf",
  },
  {
    // Cisco ASA / FTD web services read-only path traversal.
    id: "kev_cisco_asa_translation_traversal",
    cve: "CVE-2020-3452",
    family: "edge_device",
    test: (c) =>
      (c.path.startsWith("/+cscot+/translation-table") || c.path.startsWith("/+cscot+/oem-customization")) &&
      hasTraversal(c.raw.slice(c.raw.indexOf("?") + 1)),
  },
  {
    // F5 BIG-IP TMUI ..; traversal to fileRead/tmshCmd.
    id: "kev_f5_tmui_traversal",
    cve: "CVE-2020-5902",
    family: "edge_device",
    test: (c) => c.raw.includes("/tmui/login.jsp/..;"),
  },
  {
    // F5 BIG-IP iControl REST unauthenticated bash endpoint.
    id: "kev_f5_icontrol_bash",
    cve: "CVE-2022-1388",
    family: "edge_device",
    test: (c) => c.path === "/mgmt/tm/util/bash",
  },
  {
    // Ivanti Connect Secure auth bypass: traversal out of the totp endpoint.
    id: "kev_ivanti_totp_traversal",
    cve: "CVE-2023-46805",
    family: "edge_device",
    test: (c) => c.raw.startsWith("/api/v1/totp/user-backup-code/") && hasTraversal(c.raw),
  },
  {
    // Ivanti Connect Secure command injection endpoints reached after the bypass.
    id: "kev_ivanti_command_injection",
    cve: "CVE-2024-21887",
    family: "edge_device",
    test: (c) =>
      c.path === "/api/v1/system/maintenance/archiving/cloud-server-test-connection" ||
      c.path.startsWith("/api/v1/license/keys-status/"),
  },
];

/** Existing probe ids and payload families whose request shape IS a KEV CVE's
 *  exploitation, so their events carry the same annotation. */
export const KEV_CVE_BY_PROBE: Readonly<Record<string, string>> = {
  ...Object.fromEntries(KEV_PROBE_RULES.map((r) => [r.id, r.cve])),
  // observe.ts: a Server Action call from a non-browser client (React2Shell).
  next_server_action: "CVE-2025-55182",
};

export const KEV_CVE_BY_ATTACK: Readonly<Record<string, string>> = {
  log4shell: "CVE-2021-44228",
  // body-inspect.ts body-marker attacks. php2shell spans TWO CVEs (memory
  // corruption + stale request state); the annotation records the primary, and
  // EXTRA_TRACKED_KEV below pins the second so both ship in the KEV snapshot.
  php2shell: "CVE-2026-109618",
  react2shell: "CVE-2025-55182",
};

/** CVE ids a single attack label maps to but that KEV_CVE_BY_ATTACK can only
 *  carry one of. Tracked so the snapshot includes them; never the annotation. */
const EXTRA_TRACKED_KEV: readonly string[] = ["CVE-2026-109619"];

/** Every CVE id this module references (the KEV refresh tracks these). */
export const FORCEFIELD_KEV_CVES: readonly string[] = [
  ...new Set([...Object.values(KEV_CVE_BY_PROBE), ...Object.values(KEV_CVE_BY_ATTACK), ...EXTRA_TRACKED_KEV]),
].sort();

function context(path: string, rawUrl: string | undefined): KevMatchContext {
  const rawIn = rawUrl ?? path;
  let raw = rawIn;
  try {
    raw = decodeURIComponent(rawIn);
  } catch {
    raw = rawIn;
  }
  raw = raw.toLowerCase();
  const rawLower = rawIn.toLowerCase();
  const q = rawIn.indexOf("?");
  let params: URLSearchParams | null = null;
  if (q !== -1) {
    try {
      params = new URLSearchParams(rawIn.slice(q + 1));
    } catch {
      params = null;
    }
  }
  // Keep the undecoded form visible too, so an encoded marker (%ad) is seen.
  return { path: (path ?? "").toLowerCase(), raw: raw === rawLower ? raw : `${rawLower}\n${raw}`, params };
}

/** The KEV probe rule this anonymous request matches, or null. Pure. */
export function kevProbe(path: string, rawUrl: string | undefined, authenticated: boolean): KevProbeRule | null {
  if (authenticated) return null;
  try {
    const ctx = context(path, rawUrl);
    for (const rule of KEV_PROBE_RULES) if (rule.test(ctx)) return rule;
  } catch {
    return null;
  }
  return null;
}

/** The KEV CVE an observation's probe / attack label maps to, or null. */
export function kevCveFor(probe: unknown, attack: unknown): string | null {
  if (typeof probe === "string" && KEV_CVE_BY_PROBE[probe]) return KEV_CVE_BY_PROBE[probe];
  if (typeof attack === "string" && KEV_CVE_BY_ATTACK[attack]) return KEV_CVE_BY_ATTACK[attack];
  return null;
}
