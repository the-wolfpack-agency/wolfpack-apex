/** @jest-environment node */
/**
 * KEV probe rules (kev-rules.ts) and how the engine treats a match:
 *   - each rule fires on its exploit shape and NOT on a near-miss;
 *   - only anonymous requests match;
 *   - observe labels the event with the kev_ probe id, on a WordPress site too;
 *   - intent scores it (kev_exploit_path) up to watch / tarpit, never block
 *     without proof, and stays record-only (applied:false) under watch posture;
 *   - decideEnforcement never blocks a bare KEV probe (not proof).
 */
import { kevProbe, kevCveFor, KEV_PROBE_RULES, FORCEFIELD_KEV_CVES } from "@/lib/forcefield-web/kev-rules";
import { observeRequest, type ObserveInput } from "@/lib/forcefield-web/observe";
import { decideEnforcement } from "@/lib/forcefield-web/enforce";
import { evaluateRequestIntent } from "@/lib/forcefield-web/monitor";
import { IntentLedger } from "@/lib/forcefield-web/intent";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const split = (u: string): [string, string] => {
  const q = u.indexOf("?");
  return [q === -1 ? u : u.slice(0, q), u];
};
const match = (u: string, authenticated = false) => {
  const [p, raw] = split(u);
  return kevProbe(p, raw, authenticated)?.id ?? null;
};

const CASES: Array<[string, string, string]> = [
  ["kev_wp_file_manager_connector", "/wp-content/plugins/wp-file-manager/lib/php/connector.minimal.php", "/wp-content/plugins/wp-file-manager/readme.txt"],
  ["kev_wp_duplicator_download", "/wp-admin/admin-ajax.php?action=duplicator_download&file=x", "/wp-admin/admin-ajax.php?action=heartbeat"],
  ["kev_wp_social_warfare_load_options", "/wp-admin/admin-post.php?swp_debug=load_options&swp_url=x", "/wp-admin/admin-post.php?action=x"],
  ["kev_phpunit_eval_stdin", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/vendor/phpunit/phpunit/README.md"],
  ["kev_php_cgi_soft_hyphen", "/index.php?%ADd+allow_url_include%3d1", "/index.php?page=1"],
  ["kev_php_cgi_query_switch", "/index.php?-d+allow_url_include%3d1", "/index.php?-debug=1"],
  ["kev_fortios_fgt_lang_traversal", "/remote/fgt_lang?lang=/../../x", "/remote/fgt_lang?lang=en"],
  ["kev_pulse_html5acc_file_read", "/etc/passwd?/dana/html5acc/guacamole/", "/dana/html5acc/guacamole/"],
  ["kev_citrix_vpns_traversal", "/vpns/cfg/smb.conf", "/vpn/index.html"],
  ["kev_cisco_asa_translation_traversal", "/+CSCOT+/translation-table?type=mst&lang=../", "/+CSCOT+/translation-table?type=mst&lang=en"],
  ["kev_f5_tmui_traversal", "/tmui/login.jsp/..;/tmui/x.jsp", "/tmui/login.jsp"],
  ["kev_f5_icontrol_bash", "/mgmt/tm/util/bash", "/mgmt/tm/sys/version"],
  ["kev_ivanti_totp_traversal", "/api/v1/totp/user-backup-code/../../x", "/api/v1/totp/user-backup-code/abc"],
  ["kev_ivanti_command_injection", "/api/v1/system/maintenance/archiving/cloud-server-test-connection", "/api/v1/system/status"],
];

describe("each KEV rule: exploit shape matches, near-miss does not", () => {
  it("covers every rule exactly once", () => {
    expect(CASES.map((c) => c[0]).sort()).toEqual(KEV_PROBE_RULES.map((r) => r.id).sort());
  });
  it.each(CASES)("%s", (id, hit, miss) => {
    expect(match(hit)).toBe(id);
    expect(match(miss)).toBeNull();
  });
  it("never matches an authenticated request", () => {
    for (const [, hit] of CASES) expect(match(hit, true)).toBeNull();
  });
  it("ordinary site paths match nothing", () => {
    for (const p of ["/", "/pricing", "/blog/what-is-cve-2020-25213", "/wp-admin/", "/api/health", "/remote", "/vpns"]) expect(match(p)).toBeNull();
  });
});

describe("CVE mapping", () => {
  it("maps rule ids, React2Shell's server-action tell and log4shell to KEV CVEs", () => {
    expect(kevCveFor("kev_f5_icontrol_bash", undefined)).toBe("CVE-2022-1388");
    expect(kevCveFor("next_server_action", undefined)).toBe("CVE-2025-55182");
    expect(kevCveFor(undefined, "log4shell")).toBe("CVE-2021-44228");
    expect(kevCveFor("/.env", "xss")).toBeNull();
    expect(FORCEFIELD_KEV_CVES).toEqual([...FORCEFIELD_KEV_CVES].sort());
  });

  it("maps the body-marker attacks to their KEV CVEs and tracks both PHP CVEs", () => {
    expect(kevCveFor(undefined, "php2shell")).toBe("CVE-2026-109618");
    expect(kevCveFor(undefined, "react2shell")).toBe("CVE-2025-55182");
    // php2shell spans two CVEs; both ship in the tracked set so the snapshot
    // carries them even though the annotation records the primary.
    expect(FORCEFIELD_KEV_CVES).toContain("CVE-2026-109618");
    expect(FORCEFIELD_KEV_CVES).toContain("CVE-2026-109619");
  });
});

const NOW = Date.UTC(2026, 9, 26, 12);
function input(u: string, over: Partial<ObserveInput> = {}): ObserveInput {
  const [path, rawUrl] = split(u);
  return { site: "test-site", path, rawUrl, method: "GET", userAgent: "python-requests/2.31", country: "US", headerNames: ["user-agent", "accept"], ip: "192.0.2.10", nowMs: NOW, ...over };
}
const FM = "/wp-content/plugins/wp-file-manager/lib/php/connector.minimal.php";
const DUP = "/wp-admin/admin-ajax.php?action=duplicator_download&file=x";
const ALLOW = { block: false, reason: "" };

describe("engine treatment", () => {
  it("observe labels the probe on a WordPress site, where the plugin path is native", () => {
    const obs = observeRequest(input(FM, { platform: "wordpress" }), DEFAULT_RULESET);
    expect(obs?.type).toBe("site.agent_probed_sensitive");
    expect(obs?.props.probe).toBe("kev_wp_file_manager_connector");
  });

  it("decideEnforcement does not block a bare KEV probe (a probe is not proof)", () => {
    const i = input(FM, { platform: "wordpress" });
    expect(decideEnforcement({ path: i.path, rawUrl: i.rawUrl, method: "GET", userAgent: i.userAgent, headerNames: i.headerNames }, DEFAULT_RULESET).block).toBe(false);
  });

  it("intent: one KEV probe -> watch, two -> tarpit, never block without proof; record-only under watch", () => {
    const ledger = new IntentLedger();
    const run = (u: string) => {
      const i = input(u, { platform: "wordpress" });
      return evaluateRequestIntent(i, DEFAULT_RULESET, { ledger, obs: observeRequest(i, DEFAULT_RULESET), enforcement: ALLOW, posture: "watch", stack: ["wordpress"] });
    };
    const first = run(FM);
    expect(first?.decision.reasons).toContain("kev_exploit_path");
    expect(first?.decision.action).toBe("watch");
    const second = run(DUP);
    expect(second?.decision.action).toBe("tarpit");
    expect(second?.decision.applied).toBe(false);
    expect(second?.decision.details).toEqual(expect.arrayContaining(["kev_wp_file_manager_connector", "kev_wp_duplicator_download"]));
    for (let n = 0; n < 5; n++) expect(run(`${FM}?n=${n}`)?.decision.action).not.toBe("block");
  });

  it("an authenticated request scores nothing", () => {
    const i = input(FM, { platform: "wordpress", authenticated: true });
    const r = evaluateRequestIntent(i, DEFAULT_RULESET, { ledger: new IntentLedger(), obs: observeRequest(i, DEFAULT_RULESET), enforcement: ALLOW, posture: "enforce", stack: ["wordpress"] });
    expect(r?.decision.action).toBe("none");
  });
});
