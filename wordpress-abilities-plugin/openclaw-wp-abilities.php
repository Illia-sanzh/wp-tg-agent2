<?php
/**
 * Plugin Name: OpenClaw WP Abilities
 * Description: Custom WordPress Abilities for the OpenClaw AI agent, exposed
 *              as MCP tools via the WordPress MCP Adapter.
 * Version:     1.0.0
 * Requires at least: 7.0
 * Requires PHP: 8.0
 * Author:      OpenClaw
 * License:     GPL-2.0+
 */

if ( ! defined( 'ABSPATH' ) ) {
    exit;
}

add_action( 'wp_abilities_api_init', 'openclaw_register_abilities' );

function openclaw_register_abilities(): void {
    if ( ! function_exists( 'wp_register_ability' ) ) {
        return;
    }

    wp_register_ability(
        'openclaw/toggle-maintenance-mode',
        array(
            'label'       => __( 'Toggle Maintenance Mode', 'openclaw' ),
            'description' => __( 'Enable, disable, or check WordPress maintenance mode. When enabled, visitors see a "briefly unavailable for scheduled maintenance" message.', 'openclaw' ),
            'category'    => 'openclaw',
            'input_schema' => array(
                'type'       => 'object',
                'properties' => array(
                    'action' => array(
                        'type'        => 'string',
                        'enum'        => array( 'enable', 'disable', 'status' ),
                        'description' => 'Action to perform: enable, disable, or status',
                    ),
                ),
                'required' => array( 'action' ),
            ),
            'output_schema' => array(
                'type'       => 'object',
                'properties' => array(
                    'maintenance_mode' => array( 'type' => 'boolean' ),
                    'message'          => array( 'type' => 'string' ),
                ),
            ),
            'execute_callback'    => 'openclaw_toggle_maintenance',
            'permission_callback' => function () {
                return current_user_can( 'manage_options' );
            },
            'meta' => array(
                'mcp' => array( 'public' => true ),
            ),
        )
    );

    wp_register_ability(
        'openclaw/update-site-identity',
        array(
            'label'       => __( 'Update Site Identity', 'openclaw' ),
            'description' => __( 'Bulk update site title, tagline, and/or site icon in a single call. Pass any combination of fields.', 'openclaw' ),
            'category'    => 'openclaw',
            'input_schema' => array(
                'type'       => 'object',
                'properties' => array(
                    'title'        => array( 'type' => 'string', 'description' => 'New site title (blogname)' ),
                    'tagline'      => array( 'type' => 'string', 'description' => 'New site tagline (blogdescription)' ),
                    'site_icon_id' => array( 'type' => 'integer', 'description' => 'Attachment ID for the site icon' ),
                ),
            ),
            'output_schema' => array(
                'type'       => 'object',
                'properties' => array(
                    'updated' => array( 'type' => 'array' ),
                    'current' => array( 'type' => 'object' ),
                ),
            ),
            'execute_callback'    => 'openclaw_update_site_identity',
            'permission_callback' => function () {
                return current_user_can( 'manage_options' );
            },
            'meta' => array(
                'mcp' => array( 'public' => true ),
            ),
        )
    );
}


function openclaw_toggle_maintenance( array $input ): array {
    $file   = ABSPATH . '.maintenance';
    $action = $input['action'] ?? 'status';

    if ( $action === 'enable' ) {
        file_put_contents( $file, '<?php $upgrading = time(); ?>' );
        return array(
            'maintenance_mode' => true,
            'message'          => 'Maintenance mode enabled. Visitors will see "briefly unavailable" page.',
        );
    }

    if ( $action === 'disable' ) {
        if ( file_exists( $file ) ) {
            unlink( $file );
        }
        return array(
            'maintenance_mode' => false,
            'message'          => 'Maintenance mode disabled. Site is live.',
        );
    }

    return array(
        'maintenance_mode' => file_exists( $file ),
        'message'          => file_exists( $file )
            ? 'Maintenance mode is currently ON.'
            : 'Maintenance mode is currently OFF.',
    );
}


function openclaw_update_site_identity( array $input ): array {
    $updated = array();

    if ( isset( $input['title'] ) ) {
        update_option( 'blogname', sanitize_text_field( $input['title'] ) );
        $updated[] = 'title';
    }

    if ( isset( $input['tagline'] ) ) {
        update_option( 'blogdescription', sanitize_text_field( $input['tagline'] ) );
        $updated[] = 'tagline';
    }

    if ( isset( $input['site_icon_id'] ) ) {
        update_option( 'site_icon', absint( $input['site_icon_id'] ) );
        $updated[] = 'site_icon';
    }

    return array(
        'updated' => $updated,
        'current' => array(
            'title'     => get_option( 'blogname' ),
            'tagline'   => get_option( 'blogdescription' ),
            'site_icon' => (int) get_option( 'site_icon', 0 ),
        ),
    );
}
