<?php
/**
 * Plugin Name: GreenClaw WP Bridge
 * Plugin URI:  https://github.com/Next-Kick/wp-tg-agent
 * Description: Secure bridge that lets the GreenClaw agent run WP-CLI commands
 *              on this site via a secret-authenticated REST endpoint.
 *              Install this on your WordPress site, then set BRIDGE_SECRET in
 *              your agent's .env to match the secret configured here.
 * Version:     1.0.0
 * Author:      GreenClaw
 * License:     GPL-2.0+
 * Requires at least: 6.0
 * Requires PHP: 8.0
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

// ─── Constants ────────────────────────────────────────────────────────────────

define( 'GREENCLAW_BRIDGE_VERSION', '1.0.0' );
define( 'GREENCLAW_BRIDGE_OPTION',  'greenclaw_bridge_secret' );

// ─── Admin settings page ──────────────────────────────────────────────────────

add_action( 'admin_menu', function () {
    add_options_page(
        'GreenClaw Bridge',
        'GreenClaw Bridge',
        'manage_options',
        'greenclaw-bridge',
        'greenclaw_bridge_settings_page'
    );
} );

add_action( 'admin_init', function () {
    register_setting( 'greenclaw_bridge', GREENCLAW_BRIDGE_OPTION, [
        'sanitize_callback' => 'sanitize_text_field',
        'default'           => '',
    ] );
} );

function greenclaw_bridge_settings_page() {
    $secret = get_option( GREENCLAW_BRIDGE_OPTION, '' );
    ?>
    <div class="wrap">
        <h1>GreenClaw WP Bridge</h1>
        <p>This plugin lets the GreenClaw Telegram agent manage your WordPress site remotely.</p>
        <p><strong>Security:</strong> Set a long random secret below, then put the same value
           as <code>BRIDGE_SECRET</code> in the agent's <code>.env</code> file.</p>
        <form method="post" action="options.php">
            <?php settings_fields( 'greenclaw_bridge' ); ?>
            <table class="form-table">
                <tr>
                    <th><label for="<?php echo GREENCLAW_BRIDGE_OPTION; ?>">Bridge Secret</label></th>
                    <td>
                        <input
                            type="text"
                            id="<?php echo GREENCLAW_BRIDGE_OPTION; ?>"
                            name="<?php echo GREENCLAW_BRIDGE_OPTION; ?>"
                            value="<?php echo esc_attr( $secret ); ?>"
                            class="regular-text"
                            placeholder="Paste secret from install.sh output"
                        />
                        <p class="description">
                            Generate with: <code>openssl rand -hex 32</code><br>
                            REST endpoint: <code><?php echo esc_url( rest_url( 'greenclaw/v1/cli' ) ); ?></code>
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>

        <hr>
        <h2>Test connection</h2>
        <p>From the agent server, run:</p>
        <pre style="background:#f0f0f0;padding:10px;">
curl -X POST <?php echo esc_url( rest_url( 'greenclaw/v1/cli' ) ); ?> \
  -H "X-GreenClaw-Secret: YOUR_BRIDGE_SECRET" \
  -H "Content-Type: application/json" \
  -d '{"command":"option get blogname"}'
        </pre>
    </div>
    <?php
}

// ─── REST API endpoint ────────────────────────────────────────────────────────

add_action( 'rest_api_init', function () {

    // Execute WP-CLI command
    register_rest_route( 'greenclaw/v1', '/cli', [
        'methods'             => 'POST',
        'callback'            => 'greenclaw_bridge_cli_handler',
        'permission_callback' => 'greenclaw_bridge_auth',
        'args'                => [
            'command' => [
                'required'          => true,
                'type'              => 'string',
                'sanitize_callback' => 'sanitize_text_field',
            ],
        ],
    ] );

    // List abilities (from WordPress Abilities API if available)
    register_rest_route( 'greenclaw/v1', '/abilities', [
        'methods'             => 'GET',
        'callback'            => 'greenclaw_bridge_abilities_handler',
        'permission_callback' => 'greenclaw_bridge_auth',
    ] );

    // Execute an ability
    register_rest_route( 'greenclaw/v1', '/ability', [
        'methods'             => 'POST',
        'callback'            => 'greenclaw_bridge_ability_execute',
        'permission_callback' => 'greenclaw_bridge_auth',
        'args'                => [
            'ability' => [ 'required' => true, 'type' => 'string' ],
            'input'   => [ 'type' => 'object', 'default' => [] ],
        ],
    ] );

    // Health check (no auth)
    register_rest_route( 'greenclaw/v1', '/health', [
        'methods'             => 'GET',
        'callback'            => function () {
            return rest_ensure_response( [
                'status'  => 'ok',
                'version' => GREENCLAW_BRIDGE_VERSION,
                'wp'      => get_bloginfo( 'version' ),
            ] );
        },
        'permission_callback' => '__return_true',
    ] );
} );


/**
 * Auth: validate X-GreenClaw-Secret header.
 */
function greenclaw_bridge_auth( WP_REST_Request $request ): bool|WP_Error {
    $stored = get_option( GREENCLAW_BRIDGE_OPTION, '' );
    if ( empty( $stored ) ) {
        return new WP_Error( 'not_configured', 'Bridge secret not configured in WP settings.', [ 'status' => 503 ] );
    }
    $provided = $request->get_header( 'x-greenclaw-secret' );
    if ( ! hash_equals( $stored, (string) $provided ) ) {
        return new WP_Error( 'forbidden', 'Invalid or missing secret.', [ 'status' => 403 ] );
    }
    return true;
}


/**
 * Run a WP-CLI command.
 * Security: blocks dangerous commands.
 */
function greenclaw_bridge_cli_handler( WP_REST_Request $request ): WP_REST_Response|WP_Error {
    $command = $request->get_param( 'command' );

    // Safety blocklist
    $blocked = [
        'db drop', 'db reset', 'site empty', 'eval', 'eval-file',
        'shell', 'config delete',
    ];
    foreach ( $blocked as $b ) {
        if ( stripos( $command, $b ) !== false ) {
            return new WP_Error(
                'blocked',
                "Command '$b' is blocked for safety.",
                [ 'status' => 403 ]
            );
        }
    }

    $wp_path  = ABSPATH;
    $wp_cli   = greenclaw_find_wp_cli();

    if ( ! $wp_cli ) {
        return new WP_Error( 'no_wpcli', 'WP-CLI not found on this server.', [ 'status' => 503 ] );
    }

    $full_cmd = escapeshellcmd( $wp_cli )
        . ' --path=' . escapeshellarg( $wp_path )
        . ' --allow-root '
        . $command
        . ' 2>&1';

    $output = [];
    $exit   = 0;
    exec( $full_cmd, $output, $exit );

    return rest_ensure_response( [
        'command'   => $command,
        'output'    => implode( "\n", $output ),
        'exit_code' => $exit,
        'success'   => $exit === 0,
    ] );
}


/**
 * List available abilities (WordPress Abilities API).
 */
function greenclaw_bridge_abilities_handler( WP_REST_Request $request ): WP_REST_Response {
    // Try the WordPress Abilities API if available
    if ( function_exists( 'wp_get_registered_abilities' ) ) {
        return rest_ensure_response( wp_get_registered_abilities() );
    }

    // Fallback: return a list of standard abilities we support
    return rest_ensure_response( [
        'abilities' => [
            'greenclaw/create-post'    => 'Create a WordPress post or page',
            'greenclaw/update-post'    => 'Update an existing post',
            'greenclaw/delete-post'    => 'Delete a post',
            'greenclaw/list-posts'     => 'List posts with filters',
            'greenclaw/install-plugin' => 'Install and activate a plugin',
            'greenclaw/manage-theme'   => 'Switch or configure theme',
            'greenclaw/site-settings'  => 'Read/write site settings',
            'greenclaw/run-cli'        => 'Run a WP-CLI command',
        ],
    ] );
}


/**
 * Execute an ability.
 */
function greenclaw_bridge_ability_execute( WP_REST_Request $request ): WP_REST_Response|WP_Error {
    $ability = $request->get_param( 'ability' );
    $input   = $request->get_param( 'input' );

    // Route to built-in implementations
    switch ( $ability ) {
        case 'greenclaw/create-post':
            return greenclaw_ability_create_post( $input );
        case 'greenclaw/list-posts':
            return greenclaw_ability_list_posts( $input );
        case 'greenclaw/run-cli':
            $fake = new WP_REST_Request( 'POST' );
            $fake->set_param( 'command', $input['command'] ?? '' );
            return greenclaw_bridge_cli_handler( $fake );
        default:
            return new WP_Error( 'unknown_ability', "Unknown ability: $ability", [ 'status' => 400 ] );
    }
}

function greenclaw_ability_create_post( array $input ): WP_REST_Response|WP_Error {
    $args = [
        'post_title'   => sanitize_text_field( $input['title']   ?? 'Untitled' ),
        'post_content' => wp_kses_post( $input['content'] ?? '' ),
        'post_status'  => sanitize_text_field( $input['status']  ?? 'draft' ),
        'post_type'    => sanitize_text_field( $input['type']    ?? 'post' ),
    ];
    $id = wp_insert_post( $args, true );
    if ( is_wp_error( $id ) ) {
        return $id;
    }
    return rest_ensure_response( [ 'id' => $id, 'url' => get_permalink( $id ) ] );
}

function greenclaw_ability_list_posts( array $input ): WP_REST_Response {
    $query = new WP_Query( [
        'post_type'      => sanitize_text_field( $input['type']   ?? 'post' ),
        'post_status'    => sanitize_text_field( $input['status'] ?? 'any' ),
        'posts_per_page' => (int) ( $input['limit'] ?? 20 ),
    ] );
    $posts = array_map( fn( $p ) => [
        'id'     => $p->ID,
        'title'  => $p->post_title,
        'status' => $p->post_status,
        'date'   => $p->post_date,
        'url'    => get_permalink( $p->ID ),
    ], $query->posts );
    return rest_ensure_response( [ 'posts' => $posts, 'total' => $query->found_posts ] );
}


// ─── Helper: find WP-CLI ──────────────────────────────────────────────────────

function greenclaw_find_wp_cli(): string {
    $candidates = [
        '/usr/local/bin/wp',
        '/usr/bin/wp',
        trim( (string) shell_exec( 'which wp 2>/dev/null' ) ),
    ];
    foreach ( $candidates as $path ) {
        if ( $path && is_executable( $path ) ) {
            return $path;
        }
    }
    return '';
}
