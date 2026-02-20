---
name: wordpress-manager
description: Manage WordPress sites via WP-CLI and REST API. Handles content creation, plugin/theme management, WooCommerce, users, settings, database operations, and site maintenance.
user-invocable: true
metadata: {"requires": {"bins": ["curl"]}}
---

## WordPress Manager

You have access to a dedicated WordPress execution agent running at `http://openclaw-agent:8080`.

When the user asks about **any WordPress task**, use the `exec` tool to call it:

```bash
curl -s -X POST http://openclaw-agent:8080/ask \
  -H "Content-Type: application/json" \
  --max-time 300 \
  -d "{\"message\": \"<USER_REQUEST_VERBATIM>\"}"
```

Replace `<USER_REQUEST_VERBATIM>` with the user's complete message, JSON-escaped.

The agent returns JSON:
```json
{"text": "...", "elapsed": 12.3, "model": "claude-sonnet-4-6"}
```

Relay the `text` field **verbatim** to the user. Do not summarize or rephrase it.

## What the WordPress agent handles

- **Content**: Create, edit, publish posts, pages, and custom post types
- **Plugins**: Search, install, activate, update, delete
- **Themes**: Install, activate, switch themes; modify theme.json
- **WooCommerce**: Products, orders, customers, coupons, store settings
- **Users**: Create, manage roles, application passwords
- **Media**: Import images, manage media library
- **Settings**: Site options, permalinks, reading/writing settings
- **Database**: Export, optimize, search-replace (with dry-run)
- **Maintenance**: Cache flush, cron management, transient cleanup
- **Health**: Core version check, plugin/theme update availability

## Safety

The agent enforces its own guardrails:
- Destructive operations require confirmation before executing
- Dangerous commands (db drop, eval, shell) are blocked
- Database backups are created before risky operations

You do not need to re-validate these — just relay the user's intent and the agent's response.
