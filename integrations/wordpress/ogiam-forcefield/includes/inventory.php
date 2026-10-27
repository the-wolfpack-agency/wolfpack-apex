<?php
/**
 * OGIAM Forcefield: server check ("Is your server exposed?").
 *
 * Some flaws, PHP2Shell among them, trigger inside PHP itself before WordPress
 * or any plugin runs, so no plugin can block them. What this plugin can do is
 * tell you early: once the site is linked, it reports the server's software
 * versions to Forcefield, which compares them with the flaws attackers are
 * actively using and shows the result on your Forcefield dashboard (and emails
 * your confirmed alert address when a new one appears).
 *
 * What is sent, and nothing else:
 *   - the PHP version (PHP_VERSION),
 *   - the WordPress version,
 *   - the web server software name and version (SERVER_SOFTWARE),
 *   - the slug and version of each ACTIVE plugin,
 *   - this plugin's own version.
 * No content, no visitor data, no user accounts, no settings, no file paths.
 * Sent when the site is linked and then once a day through WP-Cron, with the
 * site key as the x-edge-token header. Only while a site key is set.
 */

if (!defined('ABSPATH')) { exit; } // No direct access.

define('OGIAM_FF_INVENTORY_HOOK', 'ogiam_ff_inventory_event');

/** The plugin's own version, read from its header. */
function ogiam_ff_plugin_version() {
    if (!function_exists('get_file_data')) { return ''; }
    $data = get_file_data(dirname(__DIR__) . '/ogiam-forcefield.php', array('Version' => 'Version'));
    return isset($data['Version']) ? (string) $data['Version'] : '';
}

/** A plugin's slug: its folder name, or the file name for a single-file plugin. */
function ogiam_ff_plugin_slug($plugin_file) {
    $dir = dirname((string) $plugin_file);
    $slug = ($dir === '.' || $dir === '') ? basename((string) $plugin_file, '.php') : $dir;
    return strtolower(substr(preg_replace('/[^A-Za-z0-9._-]/', '', $slug), 0, 100));
}

/** The software versions this server runs. Versions only. */
function ogiam_ff_inventory() {
    if (!function_exists('get_plugins')) {
        require_once ABSPATH . 'wp-admin/includes/plugin.php';
    }
    $all = function_exists('get_plugins') ? get_plugins() : array();
    $active = (array) get_option('active_plugins', array());
    if (is_multisite()) {
        $active = array_merge($active, array_keys((array) get_site_option('active_sitewide_plugins', array())));
    }
    $plugins = array();
    $seen = array();
    foreach (array_unique($active) as $file) {
        if (!is_string($file) || !isset($all[$file])) { continue; }
        $slug = ogiam_ff_plugin_slug($file);
        if ($slug === '' || isset($seen[$slug])) { continue; }
        $seen[$slug] = true;
        $version = isset($all[$file]['Version']) ? substr(sanitize_text_field((string) $all[$file]['Version']), 0, 40) : '';
        $plugins[] = array('slug' => $slug, 'version' => $version);
        if (count($plugins) >= 300) { break; }
    }
    $server = isset($_SERVER['SERVER_SOFTWARE']) && is_string($_SERVER['SERVER_SOFTWARE'])
        ? substr(sanitize_text_field(wp_unslash($_SERVER['SERVER_SOFTWARE'])), 0, 120)
        : '';
    return array(
        'phpVersion'       => substr((string) PHP_VERSION, 0, 40),
        'wordpressVersion' => substr((string) get_bloginfo('version'), 0, 40),
        'serverSoftware'   => $server,
        'plugins'          => $plugins,
        'pluginVersion'    => ogiam_ff_plugin_version(),
    );
}

/** Send the inventory to Forcefield. Returns the HTTP status (0 on a network error). */
function ogiam_ff_send_inventory() {
    $token = get_option('ogiam_ff_token', '');
    if (empty($token) || !is_string($token)) { return 0; } // dark until a key is set
    $res = wp_remote_post(ogiam_ff_api_base() . '/api/forcefield/wordpress/inventory', array(
        'timeout' => 10,
        'headers' => array('content-type' => 'application/json', 'accept' => 'application/json', 'x-edge-token' => $token),
        'body'    => wp_json_encode(ogiam_ff_inventory()),
    ));
    $code = is_wp_error($res) ? 0 : (int) wp_remote_retrieve_response_code($res);
    $status = '';
    if ($code === 200) {
        $body = json_decode(wp_remote_retrieve_body($res), true);
        $status = is_array($body) && isset($body['status']) ? sanitize_key($body['status']) : '';
    }
    update_option('ogiam_ff_inventory_last', array('at' => time(), 'code' => $code, 'status' => $status), false); // autoload off
    return $code;
}

/** Keep the daily check scheduled while a site key is set (covers a pasted key and upgrades). */
function ogiam_ff_schedule_inventory() {
    $token = get_option('ogiam_ff_token', '');
    if (empty($token)) {
        if (wp_next_scheduled(OGIAM_FF_INVENTORY_HOOK)) { wp_clear_scheduled_hook(OGIAM_FF_INVENTORY_HOOK); }
        return;
    }
    if (!wp_next_scheduled(OGIAM_FF_INVENTORY_HOOK)) {
        // First run soon (a minute out), then daily.
        wp_schedule_event(time() + MINUTE_IN_SECONDS, 'daily', OGIAM_FF_INVENTORY_HOOK);
    }
}
add_action('init', 'ogiam_ff_schedule_inventory', 20);
add_action(OGIAM_FF_INVENTORY_HOOK, 'ogiam_ff_send_inventory');

/** After WordPress updates core or a plugin, report the new versions soon. */
function ogiam_ff_inventory_after_upgrade() {
    if (empty(get_option('ogiam_ff_token', ''))) { return; }
    if (!wp_next_scheduled('ogiam_ff_inventory_once')) {
        wp_schedule_single_event(time() + MINUTE_IN_SECONDS, 'ogiam_ff_inventory_once');
    }
}
add_action('upgrader_process_complete', 'ogiam_ff_inventory_after_upgrade');
add_action('ogiam_ff_inventory_once', 'ogiam_ff_send_inventory');

/** One line on the settings page: the last server check, in plain words. */
function ogiam_ff_inventory_status_text() {
    $last = get_option('ogiam_ff_inventory_last', array());
    if (!is_array($last) || empty($last['at'])) {
        return __('Server check: not sent yet. It runs within a minute of connecting and then daily.', 'ogiam-forcefield');
    }
    $when = wp_date(get_option('date_format') . ' ' . get_option('time_format'), (int) $last['at']);
    if ((int) $last['code'] !== 200) {
        /* translators: %s: date and time */
        return sprintf(__('Server check: could not reach Forcefield on %s. It tries again daily.', 'ogiam-forcefield'), $when);
    }
    $map = array(
        'exposed' => __('Your server runs a version open to an actively exploited flaw. See your Forcefield dashboard for who fixes it.', 'ogiam-forcefield'),
        'ok'      => __('No actively exploited flaw on the list affects your server.', 'ogiam-forcefield'),
        'unknown' => __('Some versions could not be checked. See your Forcefield dashboard.', 'ogiam-forcefield'),
    );
    $text = isset($map[$last['status']]) ? $map[$last['status']] : __('Sent.', 'ogiam-forcefield');
    /* translators: 1: date and time, 2: result */
    return sprintf(__('Server check (%1$s): %2$s', 'ogiam-forcefield'), $when, $text);
}
