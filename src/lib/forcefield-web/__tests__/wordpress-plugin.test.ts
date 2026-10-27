/** @jest-environment node */
/**
 * Safety invariants for the WordPress plugin (integrations/wordpress/).
 *
 * The plugin's SYNTAX is verified in CI by php -l (.github/workflows/php-lint.yml);
 * the apex repo has no PHP runtime. What this pins are the security properties that
 * a syntax check cannot: dark-until-configured, watch-first, fail-open, and
 * SHAPE-ONLY forwarding (no request body / PII). If a future edit weakens one of
 * these, this test fails before it ships.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const php = readFileSync(
  join(process.cwd(), "integrations", "wordpress", "ogiam-forcefield", "ogiam-forcefield.php"),
  "utf8",
);

describe("wordpress plugin safety invariants", () => {
  it("is a valid plugin header + blocks direct access", () => {
    expect(php).toMatch(/Plugin Name:\s*OGIAM Forcefield/);
    expect(php).toMatch(/if \(!defined\('ABSPATH'\)\) \{ exit; \}/);
  });

  it("is dark until a site key is configured", () => {
    expect(php).toMatch(/if \(empty\(\$token\).*\) \{ return; \}/);
  });

  it("authorizes with the site key as x-edge-token (its own credential)", () => {
    expect(php).toMatch(/'x-edge-token'\s*=>\s*\$token/);
    expect(php).toContain("get_option('ogiam_ff_token'");
  });

  it("is watch-first: watch mode is fire-and-forget, blocking is gated on the enforce option", () => {
    expect(php).toContain("get_option('ogiam_ff_enforce', '') === 'on'");
    expect(php).toMatch(/'blocking'\s*=>\s*false/); // watch = non-blocking best-effort
    expect(php).toMatch(/'timeout'\s*=>\s*0\.3/); // and a short timeout
    // the block path exists only after the watch / signed-in branch returns
    const watchIdx = php.indexOf("if (!$enforce || $authenticated)");
    const blockCallIdx = php.indexOf("ogiam_ff_block(ogiam_ff_request_context())");
    expect(watchIdx).toBeGreaterThan(-1);
    expect(blockCallIdx).toBeGreaterThan(watchIdx);
  });

  it("fails open on any engine error, a non-200, or an unreadable answer", () => {
    expect(php).toMatch(/if \(is_wp_error\(\$res\)\) \{ return; \}/);
    expect(php).toMatch(/wp_remote_retrieve_response_code\(\$res\) !== 200\) \{ return; \}/);
    // only an explicit block verdict blocks
    expect(php).toContain("$verdict['action'] === 'block'");
  });

  it("forwards SHAPE only - never the request body, $_POST or cookies", () => {
    expect(php).not.toContain("$_POST");
    expect(php).not.toContain("$_COOKIE");
    expect(php).not.toContain("php://input");
    expect(php).not.toContain("file_get_contents");
    expect(php).not.toContain("HTTP_COOKIE'");
    expect(php).not.toContain("HTTP_AUTHORIZATION'");
    for (const key of ["'site'", "'path'", "'method'", "'userAgent'", "'country'", "'headerNames'"]) {
      expect(php).toContain(key);
    }
  });

  it("forwards the new contract fields: platform, rawUrl, ip, accept, secFetchDest, authenticated", () => {
    expect(php).toMatch(/'platform'\s*=>\s*'wordpress'/);
    expect(php).toMatch(/'rawUrl'\s*=>/);
    expect(php).toMatch(/'ip'\s*=>\s*ogiam_ff_client_ip\(\)/);
    expect(php).toMatch(/'accept'\s*=>.*HTTP_ACCEPT/);
    expect(php).toMatch(/'secFetchDest'\s*=>.*HTTP_SEC_FETCH_DEST/);
    expect(php).toMatch(/'authenticated'\s*=>\s*\(bool\) \$authenticated/);
  });

  it("guards on init (priority 0), so wp-login, xmlrpc, admin-ajax, REST and wp-admin are seen", () => {
    expect(php).toMatch(/add_action\('init', 'ogiam_ff_guard', 0\);/);
    // the old front-end-only hook and the wp-admin blind spot are gone
    expect(php).not.toMatch(/add_action\('template_redirect'/);
    expect(php).not.toMatch(/if \(is_admin\(\)\) \{ return; \}/);
  });

  it("never blocks a signed-in user, and attests it from WordPress's own session check", () => {
    expect(php).toContain("$authenticated = is_user_logged_in();");
    // signed-in requests always take the non-blocking path and return before any block
    expect(php).toMatch(/if \(!\$enforce \|\| \$authenticated\) \{[\s\S]*?'blocking'\s*=>\s*false[\s\S]*?return;\s*\}/);
    // never inferred from a cookie or auth header being present
    expect(php).not.toMatch(/LOGGED_IN_COOKIE|wordpress_logged_in/);
  });

  it("stays out of the way of WP-CLI, cron, and saving its own settings", () => {
    expect(php).toMatch(/if \(defined\('WP_CLI'\) && WP_CLI\) \{ return; \}/);
    expect(php).toMatch(/if \(wp_doing_cron\(\)\) \{ return; \}/);
    expect(php).toMatch(/'\/wp-admin\/options\.php'[\s\S]{0,80}current_user_can\('manage_options'\)\) \{\s*return;/);
    // the exemptions run before any engine call
    const firstPost = php.indexOf("wp_remote_post(");
    expect(php.indexOf("defined('WP_CLI')")).toBeLessThan(firstPost);
    expect(php.indexOf("wp_doing_cron()")).toBeLessThan(firstPost);
  });

  it("uses REMOTE_ADDR unless the owner chose a proxy header, and validates the IP", () => {
    expect(php).toContain("ogiam_ff_server('REMOTE_ADDR')");
    expect(php).toContain("FILTER_VALIDATE_IP");
    // X-Forwarded-For only behind a chosen proxy, and then the LAST hop
    expect(php).toMatch(/\$source === 'x-forwarded-for'[\s\S]{0,160}end\(\$hops\)/);
    expect(php).toMatch(/'ogiam_ff_proxy_header'[\s\S]{0,120}'sanitize_callback' => 'ogiam_ff_sanitize_proxy_header'/);
  });

  it("answers a block with a context-appropriate 403 that leaks no internals", () => {
    const block = php.slice(php.indexOf("function ogiam_ff_block("), php.indexOf("function ogiam_ff_guard("));
    expect(block).toMatch(/wp_send_json\([\s\S]*?403\s*\)/); // REST + admin-ajax: JSON 403
    expect(block).toContain("<methodResponse><fault>"); // XML-RPC: fault
    expect(block).toMatch(/wp_die\([\s\S]*?'response' => 403/); // pages: HTML 403
    // fixed text only: the engine verdict / reason is never echoed to the requester
    expect(block).not.toContain("$verdict");
    expect(block).not.toMatch(/reason/i);
  });

  it("sanitizes every stored setting and escapes every output on the settings page", () => {
    for (const opt of ["ogiam_ff_site", "ogiam_ff_token", "ogiam_ff_ingest_url", "ogiam_ff_enforce", "ogiam_ff_proxy_header"]) {
      expect(php).toMatch(new RegExp(`register_setting\\('ogiam_ff', '${opt}', array\\([^)]*'sanitize_callback'`));
    }
    expect(php).toContain("esc_url_raw(");
    // no unescaped echo of an option value
    expect(php).not.toMatch(/echo get_option\(/);
  });

  it("is plain PHP 7.4 (no PHP 8-only helpers)", () => {
    for (const fn of ["str_starts_with(", "str_ends_with(", "str_contains(", "match ("]) {
      expect(php).not.toContain(fn);
    }
  });
});

describe("wordpress plugin one-click connect (includes/connect.php)", () => {
  const connect = readFileSync(
    join(process.cwd(), "integrations", "wordpress", "ogiam-forcefield", "includes", "connect.php"),
    "utf8",
  );

  it("is loaded by the main file, blocks direct access, and clears its cron on deactivation", () => {
    expect(php).toContain("require_once __DIR__ . '/includes/connect.php';");
    expect(php).toContain("register_deactivation_hook(__FILE__, 'ogiam_ff_deactivate');");
    expect(connect).toMatch(/if \(!defined\('ABSPATH'\)\) \{ exit; \}/);
    expect(connect).toMatch(/function ogiam_ff_deactivate\(\) \{\s*wp_clear_scheduled_hook\('ogiam_ff_claim_event'\);/);
  });

  it("every admin action checks the capability and a nonce first", () => {
    for (const fn of ["ogiam_ff_handle_connect", "ogiam_ff_handle_connect_action"]) {
      const body = connect.slice(connect.indexOf(`function ${fn}(`));
      const head = body.slice(0, 400);
      expect(head).toContain("current_user_can('manage_options')");
      expect(head).toMatch(/check_admin_referer\('ogiam_ff_connect(_action)?'\)/);
    }
    expect(connect).toContain("wp_nonce_field('ogiam_ff_connect')");
    expect(connect).toContain("wp_nonce_field('ogiam_ff_connect_action')");
  });

  it("the secret is CSPRNG-generated and stored with autoload off", () => {
    expect(connect).toContain("'ffp_' . bin2hex(random_bytes(24))");
    expect(connect).not.toMatch(/\b(rand|mt_rand|uniqid)\(/);
    expect(connect).toMatch(/update_option\('ogiam_ff_connect', \$c, false\)/);
  });

  it("stores the challenge BEFORE asking Forcefield to check it", () => {
    const handler = connect.slice(connect.indexOf("function ogiam_ff_handle_connect("));
    expect(handler.indexOf("ogiam_ff_save_connect_state($c);")).toBeGreaterThan(-1);
    expect(handler.indexOf("ogiam_ff_save_connect_state($c);")).toBeLessThan(handler.indexOf("ogiam_ff_prove($c);"));
  });

  it("the challenge route serves only a pending challenge, and only the challenge", () => {
    expect(connect).toContain("register_rest_route('ogiam-forcefield/v1', '/challenge'");
    const fn = connect.slice(connect.indexOf("function ogiam_ff_challenge_response("), connect.indexOf("function ogiam_ff_prove("));
    expect(fn).toMatch(/\$c\['state'\] !== 'proving'/);
    expect(fn).toContain("array('status' => 404)");
    expect(fn).toContain("array('challenge' => (string) $c['challenge'])");
    expect(fn).not.toContain("secret");
  });

  it("collects the site key only from the claim answer, then stops polling", () => {
    const fn = connect.slice(connect.indexOf("function ogiam_ff_try_claim("), connect.indexOf("function ogiam_ff_schedule_claim("));
    expect(fn).toContain("'/api/forcefield/wordpress/connect/claim'");
    expect(fn).toMatch(/\$code === 200 && !empty\(\$body\['token'\]\)/);
    expect(fn).toContain("update_option('ogiam_ff_token', sanitize_text_field($body['token']));");
    expect(fn).toContain("wp_clear_scheduled_hook('ogiam_ff_claim_event');");
  });

  it("forwards nothing about visitors and escapes every output", () => {
    expect(connect).not.toContain("$_COOKIE");
    expect(connect).not.toContain("php://input");
    expect(connect).not.toMatch(/echo \$_(GET|POST)/);
    expect(connect).not.toMatch(/echo get_option\(/);
    expect(connect).toContain("sanitize_email(wp_unslash($_POST['ogiam_ff_email']))");
  });

  it("is plain PHP 7.4 (no PHP 8-only helpers)", () => {
    for (const fn of ["str_starts_with(", "str_ends_with(", "str_contains(", "match ("]) {
      expect(connect).not.toContain(fn);
    }
  });
});
