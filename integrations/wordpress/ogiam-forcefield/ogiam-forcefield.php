<?php
/**
 * Plugin Name: OGIAM Forcefield
 * Description: Protects your site from hostile AI agents and bots. Paste your site key and go. Watch-first and fail-open: it never takes your site down.
 * Version: 0.2.0
 * Requires at least: 6.0
 * Requires PHP: 7.4
 * License: Proprietary
 * Text Domain: ogiam-forcefield
 *
 * How it works: on each request WordPress handles (pages, wp-login.php,
 * xmlrpc.php, admin-ajax.php, the REST API and wp-admin) this forwards the
 * request SHAPE (path, method, header NAMES, user-agent, accept, sec-fetch-dest,
 * country, client IP) to the central OGIAM engine with your site key, and applies
 * the verdict. It sends NO request bodies, NO header values beyond those named
 * here, and no cookies. The client IP is classified by the engine (hosting
 * network or not) and then discarded, never stored. It is dark until you set a
 * site key, watch-only until you enable blocking, never blocks a signed-in user,
 * and fails open on any error.
 */

if (!defined('ABSPATH')) { exit; } // No direct access.

if (!defined('OGIAM_FF_DEFAULT_INGEST')) {
    define('OGIAM_FF_DEFAULT_INGEST', 'https://wolfpack-instinct.vercel.app/api/forcefield/observe');
}

/**
 * Proxy headers the site owner may choose to trust for the client IP. Anything
 * else is ignored. The default is none: REMOTE_ADDR only.
 */
function ogiam_ff_proxy_header_choices() {
    return array(
        ''                 => __('None: use the direct connection address (REMOTE_ADDR)', 'ogiam-forcefield'),
        'cf-connecting-ip' => __('Cloudflare (CF-Connecting-IP)', 'ogiam-forcefield'),
        'x-real-ip'        => __('Reverse proxy (X-Real-IP)', 'ogiam-forcefield'),
        'x-forwarded-for'  => __('Load balancer (X-Forwarded-For, last hop)', 'ogiam-forcefield'),
    );
}

/** Sanitizers for each stored setting (WordPress settings API callbacks). */
function ogiam_ff_sanitize_text($value) {
    return sanitize_text_field(is_string($value) ? $value : '');
}

function ogiam_ff_sanitize_ingest_url($value) {
    $url = esc_url_raw(is_string($value) ? trim($value) : '', array('https'));
    return $url !== '' ? $url : OGIAM_FF_DEFAULT_INGEST; // https only; empty falls back to the default engine
}

function ogiam_ff_sanitize_enforce($value) {
    return $value === 'on' ? 'on' : '';
}

function ogiam_ff_sanitize_proxy_header($value) {
    $value = is_string($value) ? $value : '';
    return array_key_exists($value, ogiam_ff_proxy_header_choices()) ? $value : '';
}

/** Register the settings: site label, site key, engine URL, blocking toggle, IP source. */
function ogiam_ff_register_settings() {
    register_setting('ogiam_ff', 'ogiam_ff_site', array('type' => 'string', 'sanitize_callback' => 'ogiam_ff_sanitize_text', 'default' => ''));
    register_setting('ogiam_ff', 'ogiam_ff_token', array('type' => 'string', 'sanitize_callback' => 'ogiam_ff_sanitize_text', 'default' => ''));
    register_setting('ogiam_ff', 'ogiam_ff_ingest_url', array('type' => 'string', 'sanitize_callback' => 'ogiam_ff_sanitize_ingest_url', 'default' => OGIAM_FF_DEFAULT_INGEST));
    register_setting('ogiam_ff', 'ogiam_ff_enforce', array('type' => 'string', 'sanitize_callback' => 'ogiam_ff_sanitize_enforce', 'default' => ''));
    register_setting('ogiam_ff', 'ogiam_ff_proxy_header', array('type' => 'string', 'sanitize_callback' => 'ogiam_ff_sanitize_proxy_header', 'default' => ''));
}
add_action('admin_init', 'ogiam_ff_register_settings');

function ogiam_ff_menu() {
    add_options_page('Forcefield', 'Forcefield', 'manage_options', 'ogiam-forcefield', 'ogiam_ff_settings_page');
}
add_action('admin_menu', 'ogiam_ff_menu');

function ogiam_ff_settings_page() {
    if (!current_user_can('manage_options')) { return; }
    $proxy_header = get_option('ogiam_ff_proxy_header', '');
    ?>
    <div class="wrap">
        <h1><?php echo esc_html__('Forcefield', 'ogiam-forcefield'); ?></h1>
        <p><?php echo esc_html__('Paste the site label and key from your OGIAM onboarding. Protection starts in watch mode; enable blocking when you are ready. Signed-in users are never blocked.', 'ogiam-forcefield'); ?></p>
        <form method="post" action="options.php">
            <?php settings_fields('ogiam_ff'); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="ogiam_ff_site"><?php echo esc_html__('Site label', 'ogiam-forcefield'); ?></label></th>
                    <td><input type="text" id="ogiam_ff_site" name="ogiam_ff_site" value="<?php echo esc_attr(get_option('ogiam_ff_site', '')); ?>" class="regular-text" /></td>
                </tr>
                <tr>
                    <th scope="row"><label for="ogiam_ff_token"><?php echo esc_html__('Site key', 'ogiam-forcefield'); ?></label></th>
                    <td><input type="password" id="ogiam_ff_token" name="ogiam_ff_token" value="<?php echo esc_attr(get_option('ogiam_ff_token', '')); ?>" class="regular-text" autocomplete="off" />
                        <p class="description"><?php echo esc_html__('Your credential. Stored in your WordPress options; sent only to the engine as an auth header.', 'ogiam-forcefield'); ?></p></td>
                </tr>
                <tr>
                    <th scope="row"><label for="ogiam_ff_ingest_url"><?php echo esc_html__('Engine URL', 'ogiam-forcefield'); ?></label></th>
                    <td><input type="url" id="ogiam_ff_ingest_url" name="ogiam_ff_ingest_url" value="<?php echo esc_attr(get_option('ogiam_ff_ingest_url', OGIAM_FF_DEFAULT_INGEST)); ?>" class="regular-text" /></td>
                </tr>
                <tr>
                    <th scope="row"><?php echo esc_html__('Blocking', 'ogiam-forcefield'); ?></th>
                    <td><label><input type="checkbox" name="ogiam_ff_enforce" value="on" <?php checked(get_option('ogiam_ff_enforce', ''), 'on'); ?> /> <?php echo esc_html__('Turn away proven-hostile requests (watch-only when unchecked)', 'ogiam-forcefield'); ?></label></td>
                </tr>
                <tr>
                    <th scope="row"><label for="ogiam_ff_proxy_header"><?php echo esc_html__('Client IP source', 'ogiam-forcefield'); ?></label></th>
                    <td><select id="ogiam_ff_proxy_header" name="ogiam_ff_proxy_header">
                        <?php foreach (ogiam_ff_proxy_header_choices() as $value => $label) : ?>
                            <option value="<?php echo esc_attr($value); ?>" <?php selected($proxy_header, $value); ?>><?php echo esc_html($label); ?></option>
                        <?php endforeach; ?>
                    </select>
                        <p class="description"><?php echo esc_html__('Leave on None unless every request reaches this server through that proxy. If visitors can reach the server directly, they can forge these headers.', 'ogiam-forcefield'); ?></p></td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

/** Read one $_SERVER entry as a trimmed string, or '' when absent. */
function ogiam_ff_server($key) {
    if (!isset($_SERVER[$key]) || !is_string($_SERVER[$key])) { return ''; }
    return trim(wp_unslash($_SERVER[$key])); // phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- each caller sanitizes or validates for its own field.
}

/**
 * The client IP, used by the engine ONLY to classify the network (hosting or
 * not) and then discarded.
 *
 * Default is REMOTE_ADDR, the address of the TCP connection, which the client
 * cannot forge. Headers such as X-Forwarded-For or CF-Connecting-IP are plain
 * request headers: on a server reachable directly, any client can send them with
 * any value, and a forged IP could pose as an allowlisted crawler's range or
 * hide a datacenter origin. So a proxy header is used only when the site owner
 * has said, in settings, that the site sits behind that proxy. For
 * X-Forwarded-For the LAST hop is taken: it is the one the trusted proxy
 * appended, while earlier hops are whatever the client claimed.
 */
function ogiam_ff_client_ip() {
    $remote = ogiam_ff_server('REMOTE_ADDR');
    $source = ogiam_ff_sanitize_proxy_header(get_option('ogiam_ff_proxy_header', ''));
    $candidate = '';
    if ($source === 'cf-connecting-ip') {
        $candidate = ogiam_ff_server('HTTP_CF_CONNECTING_IP');
    } elseif ($source === 'x-real-ip') {
        $candidate = ogiam_ff_server('HTTP_X_REAL_IP');
    } elseif ($source === 'x-forwarded-for') {
        $hops = explode(',', ogiam_ff_server('HTTP_X_FORWARDED_FOR'));
        $candidate = trim((string) end($hops));
    }
    if ($candidate !== '' && filter_var($candidate, FILTER_VALIDATE_IP)) { return $candidate; }
    return filter_var($remote, FILTER_VALIDATE_IP) ? $remote : '';
}

/** The request path (no query), always starting with "/". */
function ogiam_ff_request_path() {
    $path = wp_parse_url(ogiam_ff_server('REQUEST_URI'), PHP_URL_PATH);
    return (is_string($path) && $path !== '') ? $path : '/';
}

/**
 * Collect the request SHAPE only. No bodies, no cookies, no header values other
 * than the few named fields below.
 *
 * userAgent and rawUrl are forwarded as raw data inside a JSON body to the engine
 * (never echoed, never stored here): sanitizing them would erase exactly the
 * injection payload the engine is looking for. They are length-capped instead.
 */
function ogiam_ff_request_shape($authenticated) {
    $raw = ogiam_ff_server('REQUEST_URI');
    if ($raw === '') { $raw = '/'; }
    $header_names = array();
    foreach (array_keys($_SERVER) as $key) {
        if (strpos($key, 'HTTP_') === 0) {
            $header_names[] = strtolower(str_replace('_', '-', substr($key, 5)));
        }
    }
    // PHP lists these two without the HTTP_ prefix.
    if (isset($_SERVER['CONTENT_TYPE'])) { $header_names[] = 'content-type'; }
    if (isset($_SERVER['CONTENT_LENGTH'])) { $header_names[] = 'content-length'; }
    $method = sanitize_text_field(ogiam_ff_server('REQUEST_METHOD'));
    return array(
        'site'          => get_option('ogiam_ff_site', ''),
        'platform'      => 'wordpress',
        'path'          => ogiam_ff_request_path(),
        'rawUrl'        => substr($raw, 0, 2048),
        'method'        => $method !== '' ? strtoupper($method) : 'GET',
        'userAgent'     => substr(ogiam_ff_server('HTTP_USER_AGENT'), 0, 512),
        'accept'        => substr(sanitize_text_field(ogiam_ff_server('HTTP_ACCEPT')), 0, 256),
        'secFetchDest'  => sanitize_key(ogiam_ff_server('HTTP_SEC_FETCH_DEST')),
        'country'       => substr(sanitize_text_field(ogiam_ff_server('HTTP_CF_IPCOUNTRY')), 0, 8),
        'ip'            => ogiam_ff_client_ip(),
        'authenticated' => (bool) $authenticated,
        'headerNames'   => $header_names,
    );
}

/** Which kind of endpoint this request is, so a block answers in its own format. */
function ogiam_ff_request_context() {
    if (defined('XMLRPC_REQUEST') && XMLRPC_REQUEST) { return 'xmlrpc'; }
    if (wp_doing_ajax()) { return 'ajax'; }
    // REST_REQUEST is not defined yet at init, so detect the REST API by its URL:
    // the pretty /wp-json/ prefix or the plain-permalink ?rest_route= form.
    $prefix = '/' . trim(rest_get_url_prefix(), '/');
    $path = untrailingslashit(ogiam_ff_request_path());
    if (substr($path, -strlen($prefix)) === $prefix || strpos($path, $prefix . '/') !== false) { return 'rest'; }
    if (isset($_GET['rest_route'])) { return 'rest'; } // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- presence check only, value unused.
    return 'html';
}

/**
 * A clean 403 in the format the caller expects. The message is fixed text: no
 * reason, rule name or engine detail is ever shown to the requester.
 */
function ogiam_ff_block($context) {
    $message = __('Forbidden: this request was flagged as a hostile automated action.', 'ogiam-forcefield');
    if ($context === 'rest' || $context === 'ajax') {
        nocache_headers();
        wp_send_json(
            array('code' => 'forbidden', 'message' => $message, 'data' => array('status' => 403)),
            403
        );
    }
    if ($context === 'xmlrpc') {
        status_header(403);
        nocache_headers();
        header('Content-Type: text/xml; charset=UTF-8');
        echo '<?xml version="1.0" encoding="UTF-8"?>' . "\n"
            . '<methodResponse><fault><value><struct>'
            . '<member><name>faultCode</name><value><int>403</int></value></member>'
            . '<member><name>faultString</name><value><string>' . esc_html($message) . '</string></value></member>'
            . '</struct></value></fault></methodResponse>';
        exit;
    }
    status_header(403);
    nocache_headers();
    wp_die(
        esc_html($message),
        esc_html__('Forbidden', 'ogiam-forcefield'),
        array('response' => 403)
    );
}

/** The edge check. Dark until configured; watch-first; never blocks a signed-in user; fail-open. */
function ogiam_ff_guard() {
    // Never in the way of the site's own machinery: WP-CLI and scheduled cron runs.
    if (defined('WP_CLI') && WP_CLI) { return; }
    if (wp_doing_cron()) { return; }

    $token  = get_option('ogiam_ff_token', '');
    $ingest = get_option('ogiam_ff_ingest_url', OGIAM_FF_DEFAULT_INGEST);
    if (empty($token) || empty($ingest)) { return; } // dark until a key is set

    // Saving this plugin's own settings (options.php, by an administrator) is
    // never checked, so a bad engine URL or key can always be corrected.
    if (substr(ogiam_ff_request_path(), -strlen('/wp-admin/options.php')) === '/wp-admin/options.php' && current_user_can('manage_options')) {
        return;
    }

    // Site-attested: WordPress itself verified the signed-in session (a valid,
    // signed auth cookie). Never inferred from a cookie merely being present.
    $authenticated = is_user_logged_in();

    $body = wp_json_encode(ogiam_ff_request_shape($authenticated));
    $headers = array('content-type' => 'application/json', 'x-edge-token' => $token);
    $enforce = get_option('ogiam_ff_enforce', '') === 'on';

    if (!$enforce || $authenticated) {
        // Watch mode, and every signed-in request in any mode: fire-and-forget,
        // short timeout, never delay or block the page. A signed-in user is
        // reported (marked authenticated) but is NEVER blocked.
        wp_remote_post($ingest, array(
            'timeout'  => 0.3,
            'blocking' => false,
            'headers'  => $headers,
            'body'     => $body,
        ));
        return;
    }

    // Enforce mode, anonymous request: ask the engine, apply the verdict.
    // Fail-open on any error, timeout, non-200 or unreadable answer.
    $res = wp_remote_post($ingest, array(
        'timeout' => 2,
        'headers' => $headers,
        'body'    => $body,
    ));
    if (is_wp_error($res)) { return; } // fail-open: never take the site down
    if ((int) wp_remote_retrieve_response_code($res) !== 200) { return; } // fail-open
    $verdict = json_decode(wp_remote_retrieve_body($res), true);
    if (is_array($verdict) && isset($verdict['action']) && $verdict['action'] === 'block') {
        ogiam_ff_block(ogiam_ff_request_context());
    }
}

/*
 * Why `init` at priority 0.
 *
 * The old `template_redirect` hook fires only for front-end page renders, so the
 * plugin never saw wp-login.php, xmlrpc.php, admin-ajax.php, the REST API or
 * wp-admin: the paths attackers hit hardest. All of those load WordPress through
 * wp-settings.php, and `init` fires for every one of them.
 *
 * `init` is also the earliest hook where is_user_logged_in() is reliable:
 * WordPress sets up the current user in WP::init() immediately before firing
 * `init`. On `plugins_loaded` or `after_setup_theme` the user can be resolved
 * before other plugins have registered their `determine_current_user` filters,
 * so a signed-in user could be misread as anonymous, which would break the
 * never-block-a-signed-in-user guarantee. Priority 0 runs us ahead of most
 * plugin and theme `init` work, so a block is clean and cheap.
 *
 * Not covered: wp-admin/install.php and wp-admin/setup-config.php. WordPress
 * loads those in installing mode, where regular plugins are not loaded at all.
 * Use the Cloudflare Worker connector to cover them at the edge.
 */
add_action('init', 'ogiam_ff_guard', 0);
