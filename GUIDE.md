# WordPress Telegram Agent — Usage Guide

## Quick Start

```bash
# On your Ubuntu 24.04 VPS:
git clone <repo> wp-tg-agent
cd wp-tg-agent
sudo bash install.sh
```

The installer asks 8 questions and does everything else automatically.

---

## What It Does

You send a message to your Telegram bot → the AI agent manages your WordPress site.

```
You (Telegram) → Bot → AI Agent → WP-CLI / REST API → Your WordPress site
                          ↕
                      LiteLLM proxy
                      (budget limits)
                          ↕
                      Squid proxy
                      (allowlist-only internet)
```

---

## Architecture

| Container | Role | RAM |
|---|---|---|
| `openclaw-bot` | Telegram bot | 256 MB |
| `openclaw-agent` | WordPress AI agent | 1536 MB |
| `openclaw-litellm` | LLM proxy + budget | 512 MB |
| `openclaw-squid` | Egress filter | ~64 MB |

**The 401 fix:** The agent uses LiteLLM's OpenAI-compatible API, never calling
Anthropic directly. LiteLLM holds the real API key and handles provider auth.

---

## Example Commands

```
# Content
Create a blog post about the top 5 WordPress security plugins
Write a 500-word landing page for our summer sale
Update the "About Us" page to mention our new location

# Plugins & Themes
Install WooCommerce
Update all plugins (make a backup first)
Switch to the Astra theme

# WooCommerce
Create a product called "Blue Widget" at $29.99
Show me all orders from this week
Create a 15% discount coupon called LAUNCH15

# Settings
Change the site tagline to "Fast. Reliable. Yours."
Disable comments on all posts
Set the Blog page as my posts page

# Maintenance
Flush all caches
Show me which plugins need updates
Check my site's health
```

---

## Switching AI Models

In Telegram, send: `/model <name>`

| Model | Best For |
|---|---|
| `claude-sonnet-4-6` | Best results (default) |
| `claude-haiku-4-5` | Fast, cheap tasks |
| `gpt-4o` | Alternative to Claude |
| `deepseek-chat` | Budget option |
| `gemini-2.0-flash` | Fast, multimodal |

---

## Management Commands

```bash
# Status
docker compose ps
docker compose logs -f openclaw-agent

# Restart everything
docker compose restart

# Stop everything
docker compose down

# Update to latest images
docker compose pull && docker compose up -d

# Add a domain to Squid allowlist (e.g. for a new API)
echo ".newdomain.com" >> squid/allowlist.txt
docker exec openclaw-squid squid -k reconfigure

# Check monthly AI spend
# Visit your provider's dashboard (links in .env comments)
```

---

## WordPress Bridge Plugin

The bridge plugin (`wordpress-bridge-plugin/openclaw-wp-bridge.php`) lets the
agent run WP-CLI commands on remote WordPress sites.

**Manual install:**
1. Upload the plugin folder to `wp-content/plugins/`
2. Activate in WP Admin → Plugins
3. Go to Settings → OpenClaw Bridge
4. Paste the `BRIDGE_SECRET` from your `.env`

---

## Security Notes

- Only your Telegram user ID can send commands (set in `TELEGRAM_ADMIN_USER_ID`)
- All AI API calls go through LiteLLM → you control the monthly budget cap
- All outbound internet is filtered by Squid → only allowlisted domains work
- Dangerous WP-CLI commands are blocked (`wp db drop`, `wp eval`, etc.)
- The `.env` file has permissions 600 (only readable by root)

---

## Troubleshooting

**Bot doesn't respond:**
```bash
docker compose logs openclaw-bot
```

**AI returns errors:**
```bash
docker compose logs openclaw-litellm
# Check your API key and budget at the provider's dashboard
```

**WP-CLI commands fail:**
```bash
# Check that WordPress path is correct
docker exec openclaw-agent wp --path=/wordpress --allow-root core version

# If WordPress is remote, check bridge plugin
curl https://yoursite.com/wp-json/openclaw/v1/health
```

**Out of budget:**
Edit `.env`, increase `MONTHLY_BUDGET_USD`, then:
```bash
docker compose restart openclaw-litellm
```
