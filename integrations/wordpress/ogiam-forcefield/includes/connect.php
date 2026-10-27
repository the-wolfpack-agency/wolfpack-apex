<?php
/**
 * OGIAM Forcefield: one-click Connect.
 *
 * The site owner clicks Connect on Settings -> Forcefield. No key to copy, no DNS
 * record, no file upload:
 *
 *   1. The plugin generates a random secret and sends it, with this site's
 *      address and the alert email, to Forcefield. Forcefield answers with a
 *      challenge, which the plugin stores.
 *   2. The plugin asks Forcefield to check. Forcefield fetches the challenge from
 *      this site (the REST route below). The plugin running on this site and
 *      answering the challenge Forcefield issued is the ownership proof.
 *      Forcefield then emails a sign-in link to the address given.
 *   3. When the owner clicks that link, the plugin collects its site key (once)
 *      and protection starts, in watch mode. It checks on every Forcefield
 *      settings page load and once a minute through WP-Cron.
 *
 * The secret never leaves this site except to Forcefield over HTTPS, and is
 * stored in the options table with autoload off. The challenge route reveals
 * only the short-lived challenge, which is useless without the secret.
 */

if (!defined('ABSPATH')) { exit; } // No direct access.

/** How long a started connection stays valid before the owner must start over. */
define('OGIAM_FF_CONNECT_TTL', 2 * DAY_IN_SECONDS);

/** The Forcefield API base, derived from the engine URL (or OGIAM_FF_API_BASE). */
function ogiam_ff_api_base() {
    if (defined('OGIAM_FF_API_BASE')) { return untrailingslashit(OGIAM_FF_API_BASE); }
    $ingest = get_option('ogiam_ff_ingest_url', OGIAM_FF_DEFAULT_INGEST);
    $base = preg_replace('#/api/forcefield/observe/?$#', '', is_string($ingest) ? $ingest : '');
    if (!is_string($base) || $base === '' || $base === $ingest) {
        $base = preg_replace('#/api/forcefield/observe/?$#', '', OGIAM_FF_DEFAULT_INGEST);
    }
    return untrailingslashit((string) $base);
}

/** The pending connection, or an empty array. */
function ogiam_ff_connect_state() {
    $c = get_option('ogiam_ff_connect', array());
    if (!is_array($c) || empty($c['secret'])) { return array(); }
    if (!empty($c['started_at']) && (time() - (int) $c['started_at']) > OGIAM_FF_CONNECT_TTL) {
        delete_option('ogiam_ff_connect');
        return array();
    }
    return $c;
}

function ogiam_ff_save_connect_state($c) {
    update_option('ogiam_ff_connect', $c, false); // autoload off
}

/** POST JSON to the Forcefield API. Returns array(code, body) or array(0, error). */
function ogiam_ff_api_post($path, $payload, $timeout = 15) {
    $res = wp_remote_post(ogiam_ff_api_base() . $path, array(
        'timeout' => $timeout,
        'headers' => array('content-type' => 'application/json', 'accept' => 'application/json'),
        'body'    => wp_json_encode($payload),
    ));
    if (is_wp_error($res)) { return array(0, array('error' => $res->get_error_message())); }
    $body = json_decode(wp_remote_retrieve_body($res), true);
    return array((int) wp_remote_retrieve_response_code($res), is_array($body) ? $body : array());
}

/** The challenge route Forcefield fetches to prove the plugin runs on this site. */
function ogiam_ff_register_challenge_route() {
    register_rest_route('ogiam-forcefield/v1', '/challenge', array(
        'methods'             => 'GET',
        // Public on purpose: Forcefield's server calls it with no WordPress session.
        // It reveals only the pending challenge, which is useless without the secret.
        'permission_callback' => '__return_true',
        'callback'            => 'ogiam_ff_challenge_response',
    ));
}
add_action('rest_api_init', 'ogiam_ff_register_challenge_route');

function ogiam_ff_challenge_response() {
    $c = ogiam_ff_connect_state();
    if (empty($c['challenge']) || (isset($c['state']) && $c['state'] !== 'proving')) {
        return new WP_Error('ogiam_ff_no_challenge', 'No connection in progress.', array('status' => 404));
    }
    $response = rest_ensure_response(array('challenge' => (string) $c['challenge']));
    $response->header('Cache-Control', 'no-store');
    return $response;
}

/** Ask Forcefield to verify the challenge. Updates and returns the state. */
function ogiam_ff_prove($c) {
    list($code, $body) = ogiam_ff_api_post('/api/forcefield/wordpress/connect/prove', array('secret' => $c['secret']), 20);
    if ($code === 200 || $code === 409) {
        $c['state'] = 'awaiting_link';
        $c['email_masked'] = isset($body['emailMasked']) ? sanitize_text_field($body['emailMasked']) : '';
        $c['error'] = '';
        ogiam_ff_save_connect_state($c);
        ogiam_ff_schedule_claim();
    } else {
        $c['error'] = $code === 422 && isset($body['detail']) ? sanitize_key($body['detail']) : ($code === 429 ? 'rate_limited' : 'unreachable');
        ogiam_ff_save_connect_state($c);
    }
    return $c;
}

/** Collect the site key once the owner clicked the sign-in link. True when linked. */
function ogiam_ff_try_claim() {
    $c = ogiam_ff_connect_state();
    if (empty($c) || !isset($c['state']) || $c['state'] !== 'awaiting_link') { return false; }
    list($code, $body) = ogiam_ff_api_post('/api/forcefield/wordpress/connect/claim', array('secret' => $c['secret']), 10);
    if ($code === 200 && !empty($body['token']) && is_string($body['token'])) {
        update_option('ogiam_ff_token', sanitize_text_field($body['token']));
        if (!empty($body['site']) && is_string($body['site'])) {
            update_option('ogiam_ff_site', sanitize_text_field($body['site']));
        }
        update_option('ogiam_ff_linked_at', time(), false);
        delete_option('ogiam_ff_connect');
        wp_clear_scheduled_hook('ogiam_ff_claim_event');
        return true;
    }
    if ($code === 401 || $code === 409 || $code === 422) {
        // The connection is no longer valid (already linked elsewhere, or reset): start over.
        $c['state'] = 'failed';
        $c['error'] = $code === 409 ? 'already_linked' : 'expired';
        ogiam_ff_save_connect_state($c);
        wp_clear_scheduled_hook('ogiam_ff_claim_event');
    }
    return false;
}

function ogiam_ff_schedule_claim() {
    if (!wp_next_scheduled('ogiam_ff_claim_event')) {
        wp_schedule_single_event(time() + MINUTE_IN_SECONDS, 'ogiam_ff_claim_event');
    }
}

/** WP-Cron: check once a minute until linked or the connection expires. */
function ogiam_ff_claim_cron() {
    if (ogiam_ff_try_claim()) { return; }
    $c = ogiam_ff_connect_state();
    if (!empty($c) && isset($c['state']) && $c['state'] === 'awaiting_link') { ogiam_ff_schedule_claim(); }
}
add_action('ogiam_ff_claim_event', 'ogiam_ff_claim_cron');

/** An administrator opening the Forcefield settings page checks right away (throttled). */
function ogiam_ff_admin_claim_check() {
    if (!current_user_can('manage_options')) { return; }
    $page = isset($_GET['page']) ? sanitize_key(wp_unslash($_GET['page'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only page check.
    if ($page !== 'ogiam-forcefield') { return; }
    if (get_transient('ogiam_ff_claim_throttle')) { return; }
    set_transient('ogiam_ff_claim_throttle', 1, 10);
    ogiam_ff_try_claim();
}
add_action('admin_init', 'ogiam_ff_admin_claim_check');

function ogiam_ff_settings_url($args = array()) {
    return add_query_arg($args, admin_url('options-general.php?page=ogiam-forcefield'));
}

/** admin-post: the Connect button. */
function ogiam_ff_handle_connect() {
    if (!current_user_can('manage_options')) { wp_die(esc_html__('Not allowed.', 'ogiam-forcefield'), '', array('response' => 403)); }
    check_admin_referer('ogiam_ff_connect');
    $email = isset($_POST['ogiam_ff_email']) ? sanitize_email(wp_unslash($_POST['ogiam_ff_email'])) : '';
    if (!is_email($email)) {
        wp_safe_redirect(ogiam_ff_settings_url(array('ogiam_ff_notice' => 'invalid_email')));
        exit;
    }
    $secret = 'ffp_' . bin2hex(random_bytes(24));
    list($code, $body) = ogiam_ff_api_post('/api/forcefield/wordpress/connect', array(
        'site'   => home_url(),
        'email'  => $email,
        'secret' => $secret,
        'name'   => get_bloginfo('name'),
    ));
    if ($code === 202) {
        ogiam_ff_save_connect_state(array('secret' => $secret, 'state' => 'request', 'email' => $email, 'started_at' => time()));
        wp_safe_redirect(ogiam_ff_settings_url());
        exit;
    }
    if ($code !== 201 || empty($body['challenge']) || !is_string($body['challenge'])) {
        $notice = $code === 429 ? 'rate_limited' : ($code === 400 ? 'invalid' : 'unreachable');
        wp_safe_redirect(ogiam_ff_settings_url(array('ogiam_ff_notice' => $notice)));
        exit;
    }
    // Store the challenge BEFORE asking Forcefield to check it.
    $c = array(
        'secret'     => $secret,
        'challenge'  => sanitize_text_field($body['challenge']),
        'request_id' => isset($body['requestId']) ? sanitize_text_field($body['requestId']) : '',
        'email'      => $email,
        'state'      => 'proving',
        'started_at' => time(),
    );
    ogiam_ff_save_connect_state($c);
    ogiam_ff_prove($c);
    wp_safe_redirect(ogiam_ff_settings_url());
    exit;
}
add_action('admin_post_ogiam_ff_connect', 'ogiam_ff_handle_connect');

/** admin-post: retry the ownership check, check for the link now, or start over. */
function ogiam_ff_handle_connect_action() {
    if (!current_user_can('manage_options')) { wp_die(esc_html__('Not allowed.', 'ogiam-forcefield'), '', array('response' => 403)); }
    check_admin_referer('ogiam_ff_connect_action');
    $do = isset($_POST['ogiam_ff_do']) ? sanitize_key(wp_unslash($_POST['ogiam_ff_do'])) : '';
    $c = ogiam_ff_connect_state();
    if ($do === 'reset') {
        delete_option('ogiam_ff_connect');
        wp_clear_scheduled_hook('ogiam_ff_claim_event');
    } elseif ($do === 'retry' && !empty($c) && $c['state'] === 'proving') {
        ogiam_ff_prove($c);
    } elseif ($do === 'check') {
        ogiam_ff_try_claim();
    }
    wp_safe_redirect(ogiam_ff_settings_url());
    exit;
}
add_action('admin_post_ogiam_ff_connect_action', 'ogiam_ff_handle_connect_action');

function ogiam_ff_deactivate() {
    wp_clear_scheduled_hook('ogiam_ff_claim_event');
}

/** A plain-words reason for a failed ownership check. */
function ogiam_ff_connect_error_text($code) {
    $map = array(
        'ssrf_blocked'      => __('Forcefield could not reach this site at its public address.', 'ogiam-forcefield'),
        'fetch_failed'      => __('Forcefield could not reach this site. Check that it is online and public.', 'ogiam-forcefield'),
        'timeout'           => __('This site took too long to answer Forcefield.', 'ogiam-forcefield'),
        'token_mismatch'    => __('The answer from this site did not match. Start over to get a new check.', 'ogiam-forcefield'),
        'no_challenge'      => __('This site did not return the check. A caching plugin may be serving an old copy of the page.', 'ogiam-forcefield'),
        'redirect_off_site' => __('This site redirected Forcefield to a different address.', 'ogiam-forcefield'),
        'rate_limited'      => __('Too many attempts in a short time. Wait a few minutes and try again.', 'ogiam-forcefield'),
        'already_linked'    => __('This connection was already used. Start over to connect again.', 'ogiam-forcefield'),
        'expired'           => __('This connection expired. Start over.', 'ogiam-forcefield'),
        'invalid_email'     => __('Enter a valid email address.', 'ogiam-forcefield'),
        'invalid'           => __('Forcefield did not accept this site address or email.', 'ogiam-forcefield'),
        'unreachable'       => __('Forcefield could not be reached just now. Please try again in a moment.', 'ogiam-forcefield'),
    );
    if (isset($map[$code])) { return $map[$code]; }
    if (strpos((string) $code, 'http_') === 0) {
        /* translators: %s: HTTP status code */
        return sprintf(__('This site answered Forcefield with HTTP %s.', 'ogiam-forcefield'), substr((string) $code, 5));
    }
    return __('The check did not pass. Please try again.', 'ogiam-forcefield');
}

/** The Connect panel at the top of Settings -> Forcefield. */
function ogiam_ff_render_connect_panel() {
    $token = get_option('ogiam_ff_token', '');
    $dashboard = ogiam_ff_api_base() . '/forcefield/dashboard';
    echo '<div class="card" style="max-width:720px;padding:16px 20px;margin-top:16px;" id="ogiam-ff-connect">';
    if (!empty($token)) {
        echo '<h2>' . esc_html__('Connected', 'ogiam-forcefield') . '</h2>';
        echo '<p>' . esc_html__('Forcefield is watching this site. It starts in watch mode: it records and reports automated visitors and never blocks one until you turn blocking on below.', 'ogiam-forcefield') . '</p>';
        echo '<p><a class="button button-primary" target="_blank" rel="noopener" href="' . esc_url($dashboard) . '">' . esc_html__('Open your Forcefield dashboard', 'ogiam-forcefield') . '</a></p>';
        echo '</div>';
        return;
    }
    $c = ogiam_ff_connect_state();
    $state = isset($c['state']) ? $c['state'] : '';
    $notice = isset($_GET['ogiam_ff_notice']) ? sanitize_key(wp_unslash($_GET['ogiam_ff_notice'])) : ''; // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- display only.
    $action_form = function ($do, $label, $primary = false) {
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '" style="display:inline-block;margin-right:8px;">';
        wp_nonce_field('ogiam_ff_connect_action');
        echo '<input type="hidden" name="action" value="ogiam_ff_connect_action" />';
        echo '<input type="hidden" name="ogiam_ff_do" value="' . esc_attr($do) . '" />';
        submit_button($label, $primary ? 'primary' : 'secondary', 'submit', false, array('id' => 'ogiam-ff-' . $do));
        echo '</form>';
    };

    if ($state === 'awaiting_link') {
        echo '<h2>' . esc_html__('Check your email', 'ogiam-forcefield') . '</h2>';
        /* translators: %s: masked email address */
        echo '<p id="ogiam-ff-awaiting">' . esc_html(sprintf(__('This site is verified. We sent a sign-in link to %s. Click it to finish: the plugin then connects itself and protection starts in watch mode.', 'ogiam-forcefield'), !empty($c['email_masked']) ? $c['email_masked'] : $c['email'])) . '</p>';
        $action_form('check', __('I clicked the link', 'ogiam-forcefield'), true);
        $action_form('reset', __('Start over', 'ogiam-forcefield'));
    } elseif ($state === 'request') {
        echo '<h2>' . esc_html__('Request received', 'ogiam-forcefield') . '</h2>';
        echo '<p id="ogiam-ff-request">' . esc_html__('Self-serve setup is open to a limited group right now, so we will review your site and be in touch. Nothing changes on this site in the meantime.', 'ogiam-forcefield') . '</p>';
        $action_form('reset', __('Start over', 'ogiam-forcefield'));
    } elseif ($state === 'proving' || $state === 'failed') {
        echo '<h2>' . esc_html__('Almost there', 'ogiam-forcefield') . '</h2>';
        echo '<p id="ogiam-ff-error" style="color:#b32d2e;">' . esc_html(ogiam_ff_connect_error_text(isset($c['error']) ? $c['error'] : '')) . '</p>';
        if ($state === 'proving') { $action_form('retry', __('Try again', 'ogiam-forcefield'), true); }
        $action_form('reset', __('Start over', 'ogiam-forcefield'));
    } else {
        echo '<h2>' . esc_html__('Connect this site to Forcefield', 'ogiam-forcefield') . '</h2>';
        echo '<p>' . esc_html__('One click. Forcefield checks that this plugin is running on this site, then emails you a sign-in link. No key to copy and no DNS change.', 'ogiam-forcefield') . '</p>';
        if ($notice !== '') {
            echo '<p style="color:#b32d2e;">' . esc_html(ogiam_ff_connect_error_text($notice)) . '</p>';
        }
        echo '<form method="post" action="' . esc_url(admin_url('admin-post.php')) . '">';
        wp_nonce_field('ogiam_ff_connect');
        echo '<input type="hidden" name="action" value="ogiam_ff_connect" />';
        echo '<p><label for="ogiam_ff_email">' . esc_html__('Email for alerts and sign-in', 'ogiam-forcefield') . '</label><br />';
        echo '<input type="email" id="ogiam_ff_email" name="ogiam_ff_email" class="regular-text" required value="' . esc_attr(get_option('admin_email', '')) . '" /></p>';
        submit_button(__('Connect', 'ogiam-forcefield'), 'primary', 'submit', false, array('id' => 'ogiam-ff-connect-button'));
        echo '</form>';
    }
    echo '</div>';
}
