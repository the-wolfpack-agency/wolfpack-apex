<?php
/**
 * Plugin Name: OGIAM Forcefield
 * Description: Protects your site from hostile AI agents and bots. Paste your site key and go. Watch-first and fail-open: it never takes your site down.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * License: Proprietary
 *
 * How it works: on each front-end request this forwards the request SHAPE (path,
 * method, header NAMES, user-agent, country) to the central OGIAM engine with your
 * site key, and applies the verdict. It sends NO request bodies, header values, or
 * PII. It is dark until you set a site key, watch-only until you enable blocking,
 * and fails open on any error.
 */

if (!defined('ABSPATH')) { exit; } // No direct access.

if (!defined('OGIAM_FF_DEFAULT_INGEST')) {
    define('OGIAM_FF_DEFAULT_INGEST', 'https://wolfpack-instinct.vercel.app/api/forcefield/observe');
}

/** Register the settings: site label, site key, engine URL, blocking toggle. */
function ogiam_ff_register_settings() {
    register_setting('ogiam_ff', 'ogiam_ff_site');
    register_setting('ogiam_ff', 'ogiam_ff_token');
    register_setting('ogiam_ff', 'ogiam_ff_ingest_url');
    register_setting('ogiam_ff', 'ogiam_ff_enforce');
}
add_action('admin_init', 'ogiam_ff_register_settings');

function ogiam_ff_menu() {
    add_options_page('Forcefield', 'Forcefield', 'manage_options', 'ogiam-forcefield', 'ogiam_ff_settings_page');
}
add_action('admin_menu', 'ogiam_ff_menu');

function ogiam_ff_settings_page() {
    if (!current_user_can('manage_options')) { return; }
    ?>
    <div class="wrap">
        <h1>Forcefield</h1>
        <p>Paste the site label and key from your OGIAM <code>/admin/forcefield</code> onboarding. Protection starts in watch mode; enable blocking when you are ready.</p>
        <form method="post" action="options.php">
            <?php settings_fields('ogiam_ff'); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="ogiam_ff_site">Site label</label></th>
                    <td><input type="text" id="ogiam_ff_site" name="ogiam_ff_site" value="<?php echo esc_attr(get_option('ogiam_ff_site', '')); ?>" class="regular-text" /></td>
                </tr>
                <tr>
                    <th scope="row"><label for="ogiam_ff_token">Site key</label></th>
                    <td><input type="password" id="ogiam_ff_token" name="ogiam_ff_token" value="<?php echo esc_attr(get_option('ogiam_ff_token', '')); ?>" class="regular-text" autocomplete="off" />
                        <p class="description">Your credential. Stored in your WordPress options; sent only to the engine as an auth header.</p></td>
                </tr>
                <tr>
                    <th scope="row"><label for="ogiam_ff_ingest_url">Engine URL</label></th>
                    <td><input type="text" id="ogiam_ff_ingest_url" name="ogiam_ff_ingest_url" value="<?php echo esc_attr(get_option('ogiam_ff_ingest_url', OGIAM_FF_DEFAULT_INGEST)); ?>" class="regular-text" /></td>
                </tr>
                <tr>
                    <th scope="row">Blocking</th>
                    <td><label><input type="checkbox" name="ogiam_ff_enforce" value="on" <?php checked(get_option('ogiam_ff_enforce', ''), 'on'); ?> /> Turn away proven-hostile requests (watch-only when unchecked)</label></td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
    </div>
    <?php
}

/** Collect the request SHAPE only. No bodies, no header values, no PII. */
function ogiam_ff_request_shape() {
    $raw = isset($_SERVER['REQUEST_URI']) ? wp_unslash($_SERVER['REQUEST_URI']) : '/';
    $path = wp_parse_url($raw, PHP_URL_PATH);
    if (!is_string($path) || $path === '') { $path = '/'; }
    $header_names = array();
    foreach (array_keys($_SERVER) as $key) {
        if (strpos($key, 'HTTP_') === 0) {
            $header_names[] = strtolower(str_replace('_', '-', substr($key, 5)));
        }
    }
    return array(
        'site'        => get_option('ogiam_ff_site', ''),
        'path'        => $path,
        'rawUrl'      => $raw,
        'method'      => isset($_SERVER['REQUEST_METHOD']) ? sanitize_text_field(wp_unslash($_SERVER['REQUEST_METHOD'])) : 'GET',
        'userAgent'   => isset($_SERVER['HTTP_USER_AGENT']) ? wp_unslash($_SERVER['HTTP_USER_AGENT']) : '',
        'country'     => isset($_SERVER['HTTP_CF_IPCOUNTRY']) ? sanitize_text_field(wp_unslash($_SERVER['HTTP_CF_IPCOUNTRY'])) : '',
        'headerNames' => $header_names,
    );
}

/** The edge check. Dark until configured; watch-first; fail-open. */
function ogiam_ff_guard() {
    if (is_admin()) { return; } // never gate wp-admin

    $token  = get_option('ogiam_ff_token', '');
    $ingest = get_option('ogiam_ff_ingest_url', OGIAM_FF_DEFAULT_INGEST);
    if (empty($token) || empty($ingest)) { return; } // dark until a key is set

    $body = wp_json_encode(ogiam_ff_request_shape());
    $headers = array('content-type' => 'application/json', 'x-edge-token' => $token);
    $enforce = get_option('ogiam_ff_enforce', '') === 'on';

    if (!$enforce) {
        // Watch mode: fire-and-forget, short timeout, never delay or block the page.
        wp_remote_post($ingest, array(
            'timeout'  => 0.3,
            'blocking' => false,
            'headers'  => $headers,
            'body'     => $body,
        ));
        return;
    }

    // Enforce mode: ask the engine, apply the verdict. Fail-open on any error.
    $res = wp_remote_post($ingest, array(
        'timeout' => 2,
        'headers' => $headers,
        'body'    => $body,
    ));
    if (is_wp_error($res)) { return; } // fail-open: never take the site down
    $verdict = json_decode(wp_remote_retrieve_body($res), true);
    if (is_array($verdict) && isset($verdict['action']) && $verdict['action'] === 'block') {
        status_header(403);
        nocache_headers();
        wp_die(
            esc_html__('Forbidden: flagged as a hostile automated action.', 'ogiam-forcefield'),
            esc_html__('Forbidden', 'ogiam-forcefield'),
            array('response' => 403)
        );
    }
}
// Front-end requests only; runs before the template renders so a block is clean.
add_action('template_redirect', 'ogiam_ff_guard');
