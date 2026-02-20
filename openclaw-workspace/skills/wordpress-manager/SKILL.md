---
name: wordpress-manager
description: Manage WordPress sites via WP-CLI. Handles content creation, plugin/theme management, WooCommerce, users, settings, database operations, and site maintenance.
user-invokable: true
metadata: {"requires": {"bins": ["curl"]}}
---

## WordPress Manager

You manage WordPress by running WP-CLI commands through the execution agent at `http://openclaw-agent:8080/run`.

### Running a command

```bash
curl -s -X POST http://openclaw-agent:8080/run \
  -H "Content-Type: application/json" \
  -d '{"command": "wp plugin list --format=json"}'
```

Response: `{"output": "...command output..."}`.

**Never include `--path` or `--allow-root`** — the agent injects them automatically.

Run commands **one at a time**. Read the output before deciding the next step.

### Creating posts with complex content

Pass content separately to avoid JSON escaping issues:

```bash
curl -s -X POST http://openclaw-agent:8080/run \
  -H "Content-Type: application/json" \
  -d '{
    "command": "wp post update {POST_ID} {content_file}",
    "content": "<!-- wp:paragraph -->\n<p>Your text here.</p>\n<!-- /wp:paragraph -->"
  }'
```

`{content_file}` is replaced with the temp file path automatically.

---

## Blocked commands — never use these

`wp db drop` · `wp db reset` · `wp site empty` · `wp eval` · `wp eval-file` · `wp shell`

---

## Content Management

```bash
# List posts
wp post list --post_type=post --format=json

# Create draft (get ID first, then update content)
wp post create --post_title="My Title" --post_status=draft --porcelain

# Publish
wp post update {ID} --post_status=publish

# Delete (requires user confirmation first — ask before running)
wp post delete {ID} --force
```

### Blog post workflow

1. Create the draft:
   ```bash
   wp post create --post_title="Title" --post_status=draft --post_type=post --porcelain
   ```
2. Set content (via `content` field — always use Gutenberg block markup):
   ```json
   {
     "command": "wp post update {ID} {content_file}",
     "content": "<!-- wp:heading {\"level\":1} -->\n<h1 class=\"wp-block-heading\">Title</h1>\n<!-- /wp:heading -->\n<!-- wp:paragraph -->\n<p>First paragraph.</p>\n<!-- /wp:paragraph -->"
   }
   ```
3. Verify: `wp post get {ID} --field=content`
4. Set featured image (if URL provided): `wp media import https://example.com/img.jpg --post_id={ID}`
5. Publish when user says go live: `wp post update {ID} --post_status=publish`

**Always default to `draft` status unless the user explicitly says "publish it" or "make it live".**

---

## Plugin Management

```bash
# Search before installing (always do this for vague names)
wp plugin search "contact form" --per-page=5 --format=table

# Install + activate
wp plugin install contact-form-7 --activate

# List active plugins
wp plugin list --status=active --format=table

# Check for updates (dry-run first)
wp plugin update --all --dry-run

# Update one plugin
wp plugin update contact-form-7

# Deactivate/delete (requires confirmation — ask first)
wp plugin deactivate {slug}
wp plugin delete {slug}
```

**Search before installing** — if the name isn't an exact wp.org slug, search first and confirm the slug with the user.

**Premium plugins** — if `wp plugin install` returns 404 and the name suggests paid software ("Pro", "Premium", etc.), explain it's not on wp.org and ask for a zip file or license key.

---

## Theme Management

```bash
# List themes
wp theme list --format=table

# Install (does NOT activate)
wp theme install astra

# Activate
wp theme activate astra

# Check active theme
wp theme list --status=active --format=table
```

---

## WooCommerce

Before any `wp wc` command, verify WooCommerce is active:
```bash
wp plugin is-active woocommerce
```
If not active, ask the user whether to install it first.

**Always add `--user=admin`** to `wp wc` commands.

```bash
# Products
wp wc product list --user=admin --format=json
wp wc product create --name="Widget" --type=simple --regular_price=29.99 --status=publish --user=admin

# Orders
wp wc order list --user=admin --format=json

# Coupons
wp wc shop_coupon create --code="SAVE10" --discount_type=percent --amount=10 --user=admin

# Store settings
wp option update woocommerce_currency "USD"
wp option update woocommerce_default_country "US:CA"
```

---

## Settings & Users

```bash
# Site settings
wp option get blogname
wp option update blogdescription "My tagline"
wp option update blogname "New Site Name"

# Users
wp user list --format=table
wp user create john john@example.com --role=editor
wp user set-role 2 administrator

# Application password (for API access)
wp user application-password create 1 "OpenClaw Agent"

# Permalinks
wp rewrite structure "/%postname%/"
wp rewrite flush
```

---

## Maintenance & Health

```bash
# Status overview
wp core version
wp plugin list --update=available --format=table
wp core check-update

# Cache & cleanup
wp cache flush
wp transient delete --all
wp cron event list --format=table
wp cron event run --due-now

# Database maintenance
wp db optimize
wp db size

# Check error log
tail -50 /wordpress/wp-content/debug.log 2>/dev/null || echo "No debug log"
```

---

## Database Backup (before risky operations)

```bash
# Create backup
wp db export /tmp/wp-backup-$(date +%Y%m%d-%H%M%S).sql

# Verify
ls -lh /tmp/wp-backup-*.sql | tail -1
```

---

## Safe Search-Replace (domain migration)

```bash
# ALWAYS dry-run first — show user the count before proceeding
wp search-replace "http://old.com" "https://new.com" --dry-run --report-changed-only

# Run for real only after user confirms
wp search-replace "http://old.com" "https://new.com"
wp cache flush
wp rewrite flush
```

---

## Content Formatting Rules

WordPress uses **Gutenberg block markup**. All post/page content MUST use block comments.

```html
<!-- wp:paragraph -->
<p>This is a paragraph.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Section Title</h2>
<!-- /wp:heading -->

<!-- wp:list -->
<ul class="wp-block-list">
<li>Item one</li>
<li>Item two</li>
</ul>
<!-- /wp:list -->
```

**Do not use**: raw HTML without block wrappers · Markdown · `<br>` between paragraphs · inline styles (unless asked).

After creating content, always verify: `wp post get {ID} --field=content`

---

## Safety Rules

1. **Deletions always require confirmation.** Show item name + ID, ask "Are you sure?" before running any delete command.
2. **Destructive operations** (search-replace, bulk updates, plugin deactivation): warn and confirm first.
3. **Before risky operations**: run `wp db export /tmp/backup.sql` first.
4. **If WP-CLI returns a database error**: report it to the user. Do not investigate MySQL, read wp-config.php, run mysql client commands, or check service status.
5. **Never reveal secrets**: don't output env vars, API keys, or passwords.
6. **Never start system services**: if MySQL/nginx/php-fpm appears down, report it and stop.
7. **WordPress scope only**: decline unrelated requests (math, weather, coding help). Exception: fetching URLs or looking up documentation is fine via curl.
