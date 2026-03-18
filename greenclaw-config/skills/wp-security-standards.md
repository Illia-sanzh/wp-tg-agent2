# WordPress Plugin Security Standards

EVERY plugin you create or modify MUST follow these rules. Violations are unacceptable.

## 1. Direct File Access Prevention

Every PHP file MUST start with:
```php
<?php
defined('ABSPATH') || exit;
```

## 2. Input Sanitization

NEVER trust user input. Sanitize ALL data from `$_GET`, `$_POST`, `$_REQUEST`, `$_FILES`, and any external source.

| Data type | Function |
|-----------|----------|
| Plain text | `sanitize_text_field()` |
| Multiline text | `sanitize_textarea_field()` |
| Email | `sanitize_email()` |
| URL (for storage) | `esc_url_raw()` |
| Integer | `absint()` or `intval()` |
| Float | `floatval()` |
| File name | `sanitize_file_name()` |
| HTML key/slug | `sanitize_key()` |
| Title/slug | `sanitize_title()` |
| Rich HTML | `wp_kses_post()` |
| Custom HTML | `wp_kses($input, $allowed_tags)` |
| Hex color | `sanitize_hex_color()` |
| Array values | `array_map('sanitize_text_field', $array)` |

## 3. Output Escaping

EVERY piece of dynamic data rendered in HTML MUST be escaped. No exceptions.

| Context | Function |
|---------|----------|
| HTML element content | `esc_html()` |
| HTML attribute value | `esc_attr()` |
| URL in href/src | `esc_url()` |
| Inline JS string | `esc_js()` |
| Textarea content | `esc_textarea()` |
| Post HTML content | `wp_kses_post()` |
| Translation + escape | `esc_html__()`, `esc_html_e()`, `esc_attr__()`, `esc_attr_e()` |

Wrong:
```php
echo '<a href="' . $url . '">' . $title . '</a>';
```

Correct:
```php
echo '<a href="' . esc_url($url) . '">' . esc_html($title) . '</a>';
```

## 4. Nonce Verification (CSRF Protection)

ALL forms and state-changing requests MUST use nonces.

Forms:
```php
// In form:
wp_nonce_field('my_action', 'my_nonce');

// On submit:
if (!isset($_POST['my_nonce']) || !wp_verify_nonce($_POST['my_nonce'], 'my_action')) {
    wp_die('Security check failed.');
}
```

AJAX:
```php
// JS side:
jQuery.post(ajaxurl, { action: 'my_action', _ajax_nonce: myObj.nonce });

// PHP side:
check_ajax_referer('my_action', '_ajax_nonce');
```

Admin pages:
```php
check_admin_referer('my_action', 'my_nonce');
```

## 5. Capability Checks

ALWAYS verify the user has permission before performing any action.

```php
if (!current_user_can('manage_options')) {
    wp_die('Unauthorized.');
}
```

Common capabilities:
- `manage_options` — admin settings
- `edit_posts` — content editing
- `upload_files` — file uploads
- `delete_plugins` — plugin management
- `edit_theme_options` — theme/appearance

For REST endpoints:
```php
'permission_callback' => function() {
    return current_user_can('manage_options');
}
```
NEVER use `'permission_callback' => '__return_true'` for endpoints that modify data.

## 6. Database Security (SQL Injection Prevention)

ALWAYS use `$wpdb->prepare()` for queries with any variable data.

```php
$results = $wpdb->get_results(
    $wpdb->prepare("SELECT * FROM {$wpdb->prefix}my_table WHERE id = %d AND status = %s", $id, $status)
);
```

For LIKE queries:
```php
$like = '%' . $wpdb->esc_like($search) . '%';
$wpdb->prepare("SELECT * FROM {$wpdb->prefix}table WHERE name LIKE %s", $like);
```

Prefer WordPress helper methods when possible:
- `$wpdb->insert()` — INSERT
- `$wpdb->update()` — UPDATE
- `$wpdb->delete()` — DELETE
- `$wpdb->replace()` — INSERT or UPDATE

NEVER concatenate variables into SQL strings.

## 7. File Upload Security

```php
// Always validate file type
$allowed = array('jpg', 'jpeg', 'png', 'gif', 'pdf');
$file_type = wp_check_filetype($filename, null);
if (!in_array($file_type['ext'], $allowed)) {
    wp_die('File type not allowed.');
}

// Use WordPress upload handler
$upload = wp_handle_upload($_FILES['my_file'], array('test_form' => false));
if (isset($upload['error'])) {
    wp_die($upload['error']);
}
```

NEVER:
- Trust `$_FILES['name']` without sanitization
- Allow PHP/executable file uploads
- Store uploads outside `wp_upload_dir()` without good reason

## 8. AJAX Handler Security Pattern

```php
add_action('wp_ajax_my_action', 'handle_my_action');

function handle_my_action() {
    check_ajax_referer('my_nonce_action', 'nonce');

    if (!current_user_can('manage_options')) {
        wp_send_json_error('Unauthorized', 403);
    }

    $input = sanitize_text_field($_POST['data'] ?? '');
    // ... do work ...

    wp_send_json_success($result);
}
```

Every AJAX handler MUST: verify nonce, check capability, sanitize input, use `wp_send_json_*` for response.

## 9. REST API Endpoint Security Pattern

```php
register_rest_route('myplugin/v1', '/items', array(
    'methods'  => 'POST',
    'callback' => 'handle_create_item',
    'permission_callback' => function() {
        return current_user_can('edit_posts');
    },
    'args' => array(
        'title' => array(
            'required' => true,
            'sanitize_callback' => 'sanitize_text_field',
            'validate_callback' => function($value) {
                return !empty($value);
            },
        ),
    ),
));
```

## 10. Redirects

Use `wp_safe_redirect()` (not `wp_redirect()`) when the URL could come from user input.
Always call `exit;` after redirect.

```php
wp_safe_redirect(admin_url('options-general.php'));
exit;
```

## 11. Options and Transients

- Use `register_setting()` with a sanitize callback for settings
- `update_option()` / `get_option()` — NOT direct DB queries for options
- Delete options and transients on plugin uninstall

## 12. Forbidden Patterns

NEVER use:
- `eval()`, `assert()`, `create_function()`
- `preg_replace()` with the `e` modifier
- `extract()` on untrusted data
- `$_REQUEST` — use `$_GET` or `$_POST` explicitly
- `file_get_contents()` for remote URLs — use `wp_remote_get()`
- `curl_*` functions — use `wp_remote_*()` API
- `header('Location: ...')` — use `wp_safe_redirect()`
- Hardcoded table names — use `$wpdb->prefix`

## Self-Check Before Completion

Before reporting a plugin as done, verify:
1. Every PHP file has `defined('ABSPATH') || exit;`
2. Every `$_GET`/`$_POST`/`$_REQUEST` value is sanitized
3. Every `echo`/output of dynamic data is escaped
4. Every form has a nonce field and handler verifies it
5. Every admin action checks `current_user_can()`
6. Every SQL query with variables uses `$wpdb->prepare()`
7. No forbidden functions are used
8. REST endpoints have proper `permission_callback` and `sanitize_callback`
