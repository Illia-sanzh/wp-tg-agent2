# WordPress Telegram Agent — Usage Guide

## Quick Start

```bash
# On your Ubuntu 24.04 VPS:
git clone <repo> wp-tg-agent
cd wp-tg-agent
sudo bash install.sh
```

The installer asks a few questions and handles everything else automatically.

---

## How It Works

Send a message (or voice note) to your Telegram bot → the AI manages your WordPress site.

```
You (Telegram) ──text/voice──▶ Bot ──▶ AI Agent ──▶ WP-CLI / REST API ──▶ WordPress
                                            ↕
                                       LiteLLM proxy
                                       (budget limits, model routing)
                                            ↕
                                       Squid proxy
                                       (allowlist-only internet)
```

---

## Architecture

| Container | Role | RAM |
|---|---|---|
| `openclaw-bot` | Telegram bot — receives messages, sends replies | 256 MB |
| `openclaw-agent` | AI agent — LLM loop, tools, scheduler | 1152 MB |
| `openclaw-litellm` | LLM proxy — holds API keys, enforces budget | 896 MB |
| `openclaw-squid` | Egress filter — allowlist-only outbound | ~64 MB |

**Security design:** All containers are on an `internal` Docker network with no direct internet access. Only Squid has an internet route and only allows pre-approved domains.

---

## Telegram Commands

| Command | What it does |
|---|---|
| `/start` | Welcome message and feature overview |
| `/status` | Agent health, scheduler status, Whisper availability |
| `/model` | Show current model or switch to another |
| `/tasks` | List all scheduled tasks |
| `/tasks cancel <id>` | Cancel a scheduled task |
| `/skill` | List loaded custom skills |
| `/skill reload` | Hot-reload skills without restarting |
| `/cancel` | Clear conversation history |

---

## Example Tasks

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

# Scheduled tasks (see full section below)
Publish the draft post about summer sale at 5pm UTC today
Update all plugins every Monday at 3am UTC
```

---

## Voice Messages

Send a Telegram voice note — the bot transcribes it with OpenAI Whisper and treats
it as a normal text command.

**Setup:**
1. Add `OPENAI_API_KEY` to your `.env` file (the same key used for GPT-4o, if any).
2. Restart the agent: `docker compose restart openclaw-agent`

**Check it's working:**
```
/status
```
Look for `Voice (Whisper): available`. If it says `unavailable`, the key is missing.

**How it works:** Voice note → downloaded from Telegram as OGG Opus → sent to OpenAI
Whisper API via the Squid proxy → transcript returned → treated as a text command.

> Note: Whisper costs ~$0.006/minute. A 30-second voice note costs less than a cent.

---

## Scheduled Tasks

Tell the bot when to do something and it will remember — even across restarts.

**Examples:**
```
Publish the draft post ID 42 at 5pm UTC today
Update all plugins to their latest versions every Monday at 3am UTC
Generate and publish a weekly roundup post every Friday at noon UTC
Flush all WordPress caches every day at 2am UTC
```

The AI automatically calls the `schedule_task` tool when it detects scheduling intent.
It will ask you for a timezone offset if you give a local time (e.g. "5pm CET").

**Managing scheduled tasks:**

```
# In Telegram:
/tasks                        → list all scheduled tasks with their IDs and next run times
/tasks cancel oc_1234_5678    → cancel a specific task by its ID
```

**How it works:** Tasks are stored in a SQLite database inside a Docker volume
(`agent-data`). When a task fires, the full AI agent loop runs and the result is
pushed back to your Telegram chat automatically.

**Persistence:** Scheduled tasks survive container restarts and server reboots.

---

## Smart Model Routing

Enable automatic model selection so the bot uses a cheap fast model for simple
queries and upgrades to a smarter one for complex tasks — without you having to think about it.

**Setup in `.env`:**
```bash
AUTO_ROUTING=true
FAST_MODEL=claude-haiku-4-5      # simple lookups, status checks
# DEFAULT_MODEL is used for standard tasks (already set above)
SMART_MODEL=claude-sonnet-4-6    # complex analysis, debugging, multi-step tasks
# Or go bigger: SMART_MODEL=claude-opus-4-6 or SMART_MODEL=openrouter/deepseek-r1
```

Then restart the bot: `docker compose restart openclaw-bot`

**How it classifies:**

| Tier | Signals | Examples |
|---|---|---|
| ⚡ **Fast** | ≤15 words + lookup keyword | "Show all plugins", "What's the site title?", "List drafts" |
| **Standard** | Everything else | "Create a post about spring sale", "Install WooCommerce" |
| 🧠 **Smart** | Analysis keywords, long message, 4+ "and"s | "Debug why checkout fails and fix it", "Comprehensive SEO audit" |

The tier badge is shown in the "Thinking…" status so you always see which model was picked.

**Overriding:**
```
/model claude-opus-4-6    → lock every message to this model (bypasses routing)
/model auto               → go back to automatic routing
/model                    → show current routing mode and tier configuration
```

**Cost impact (rough example with Claude):**
- Fast (Haiku): ~$0.001 per query
- Standard (Sonnet): ~$0.01 per query
- Smart (Opus): ~$0.05 per query

With routing on, a mix of simple and complex tasks costs significantly less overall.

---

## AI Models

Switch models in Telegram with `/model <name>`.

### Built-in Models

| Model | Best For | Notes |
|---|---|---|
| `claude-sonnet-4-6` | Best quality (default) | Anthropic |
| `claude-haiku-4-5` | Fast, cheap tasks | Anthropic |
| `claude-opus-4-6` | Hardest reasoning tasks | Anthropic, slower |
| `gpt-4o` | OpenAI alternative | Requires `OPENAI_API_KEY` |
| `gpt-4o-mini` | Fast OpenAI | Requires `OPENAI_API_KEY` |
| `deepseek-chat` | Budget option | Requires `DEEPSEEK_API_KEY` |
| `deepseek-reasoner` | Deep reasoning | Requires `DEEPSEEK_API_KEY` |
| `gemini-2.0-flash` | Fast, multimodal | Requires `GEMINI_API_KEY` |

### OpenRouter Models (access to everything)

OpenRouter gives you one API key for every major LLM — Llama, Mistral, Gemma,
Qwen, DeepSeek-R1, and hundreds more. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys).

**Setup:**
1. Add `OPENROUTER_API_KEY=<your-key>` to `.env`
2. Restart LiteLLM: `docker compose restart openclaw-litellm`

**Pre-configured OpenRouter models:**

| Model | Usage |
|---|---|
| `openrouter/llama-3.3-70b` | Meta's Llama 3.3 70B — strong open-source model |
| `openrouter/mistral-large` | Mistral Large — European alternative |
| `openrouter/gemma-3-27b` | Google Gemma 3 27B |
| `openrouter/qwq-32b` | Qwen QwQ 32B — strong reasoning |
| `openrouter/deepseek-r1` | DeepSeek-R1 via OpenRouter |

**Any OpenRouter model:** Browse [openrouter.ai/models](https://openrouter.ai/models), copy the slug, then:
```
/model openrouter/anthropic/claude-3-haiku
/model openrouter/nvidia/llama-3.1-nemotron-70b-instruct
```

LiteLLM forwards any unrecognised `openrouter/` prefix directly to OpenRouter.

---

## Custom Skills

Skills are YAML files that add new tools to the AI agent — without touching any Python code.

### Adding a Skill

1. Create a `.yaml` file in `openclaw-config/skills/` on your server.
2. Send `/skill reload` in Telegram (no restart needed).
3. Ask the agent to use it naturally: _"Check the disk space"_

**Example — check server disk space** (included by default):

```yaml
# openclaw-config/skills/disk-space.yaml
name: check_server_disk
label: "Check Server Disk Space"
description: >
  Check disk space available on the server where WordPress runs.
  Use before large uploads, plugin installs, or when diagnosing storage issues.
type: command
command: "df -h / | tail -1 && du -sh /wordpress 2>/dev/null"
parameters: []
```

**Example — call an external API:**

```yaml
# openclaw-config/skills/exchange-rate.yaml
name: get_exchange_rate
label: "Currency Exchange Rate"
description: >
  Get the current exchange rate between two currencies.
  Useful for pricing WooCommerce products for international markets.
type: http
method: GET
url: "https://open.er-api.com/v6/latest/{base}"
parameters:
  - name: base
    description: "Base currency code (e.g. USD, EUR, GBP)"
    type: string
    required: true
```

> For HTTP skills that call external domains, add the domain to `squid/allowlist.txt`:
> ```bash
> echo ".open.er-api.com" >> squid/allowlist.txt
> docker exec openclaw-squid squid -k reconfigure
> ```

**Example — send a webhook:**

```yaml
# openclaw-config/skills/notify-slack.yaml
name: notify_slack
label: "Send Slack Notification"
description: >
  Post a message to Slack. Use when the user asks to notify the team
  about a published post, completed update, or any site change.
type: webhook
url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
method: POST
parameters:
  - name: message
    description: "Message to send to Slack"
    type: string
    required: true
```

### Skill Types

| Type | What it does |
|---|---|
| `command` | Runs a shell command on the agent container. `{param}` placeholders are substituted. |
| `http` | Makes an HTTP request to a URL. `{param}` placeholders work in the URL. |
| `webhook` | Like `http` but also sends all parameters as a JSON body (good for POST APIs). |

### Managing Skills

```
/skill                → list all loaded skills (custom + built-in)
/skill reload         → pick up new or changed YAML files without restarting
```

See `openclaw-config/skills/README.md` for the full YAML format reference.

### MCP Servers (Advanced)

For complex integrations you can run a [Model Context Protocol](https://modelcontextprotocol.io)
server as an additional Docker container on the `agent-internal` network, then expose its
endpoints via an `http` skill. Native MCP transport support is planned for a future release.

---

## Management Commands

```bash
# Status
docker compose ps
docker compose logs -f openclaw-agent
docker compose logs -f openclaw-bot

# Restart a single container
docker compose restart openclaw-agent
docker compose restart openclaw-litellm

# Restart everything
docker compose restart

# Stop everything
docker compose down

# Update to latest images
docker compose pull && docker compose up -d

# Add a domain to Squid allowlist (e.g. for a new skill's external API)
echo ".newdomain.com" >> squid/allowlist.txt
docker exec openclaw-squid squid -k reconfigure

# View scheduled tasks (JSON)
curl http://localhost:8080/schedules   # from inside the server

# Force-reload custom skills
curl -X POST http://localhost:8080/reload-skills
```

---

## WordPress Bridge Plugin

The bridge plugin (`wordpress-bridge-plugin/openclaw-wp-bridge.php`) lets the
agent run WP-CLI commands on remote WordPress sites via the REST API.

**Manual install:**
1. Upload the plugin folder to `wp-content/plugins/`
2. Activate in WP Admin → Plugins
3. Go to Settings → OpenClaw Bridge
4. Paste the `BRIDGE_SECRET` from your `.env`

---

## Environment Variables Reference

Key variables in `.env`:

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | Token from @BotFather |
| `TELEGRAM_ADMIN_USER_ID` | Yes | Your Telegram user ID (from @userinfobot). Comma-separate multiple IDs. |
| `ANTHROPIC_API_KEY` | One of these | Claude models |
| `OPENAI_API_KEY` | One of these | GPT models + Whisper voice transcription |
| `DEEPSEEK_API_KEY` | One of these | DeepSeek models |
| `GEMINI_API_KEY` | One of these | Google Gemini models |
| `OPENROUTER_API_KEY` | Optional | Access to ALL models via OpenRouter |
| `DEFAULT_MODEL` | Yes | Model used by default (e.g. `claude-sonnet-4-6`) |
| `FALLBACK_MODEL` | Yes | Auto-fallback if default fails (e.g. `deepseek-chat`) |
| `LITELLM_MASTER_KEY` | Yes | Internal auth between agent and LiteLLM (generate with `openssl rand -hex 32`) |
| `MONTHLY_BUDGET_USD` | Yes | Hard spend cap per month across all providers |
| `WP_URL` | Yes | Your WordPress site URL |
| `WP_ADMIN_USER` | Yes | WordPress admin username |
| `WP_APP_PASSWORD` | Recommended | WordPress Application Password (for REST API) |
| `WP_PATH` | Local only | Path to WordPress on the server (leave blank for remote-only) |
| `BRIDGE_SECRET` | Remote only | Auth token for the bridge plugin |

---

## Security Notes

- Only your Telegram user ID can send commands (`TELEGRAM_ADMIN_USER_ID`). Multiple IDs are supported (comma-separated).
- All AI API calls go through LiteLLM — you control the monthly budget cap.
- All outbound internet is filtered by Squid — only allowlisted domains reach the outside.
- Dangerous WP-CLI commands are blocked at the agent level (`wp db drop`, `wp eval`, `wp shell`, etc.).
- The `.env` file should have permissions `600` (only readable by root): `chmod 600 .env`
- Scheduled task results are pushed to your Telegram chat — no web dashboard exposed.

---

## Troubleshooting

**Bot doesn't respond:**
```bash
docker compose logs openclaw-bot
# Check that TELEGRAM_BOT_TOKEN and TELEGRAM_ADMIN_USER_ID are set correctly in .env
```

**Voice messages return "unavailable":**
```bash
# OPENAI_API_KEY must be set in .env
grep OPENAI_API_KEY .env
docker compose restart openclaw-agent
```

**Scheduled tasks don't fire:**
```bash
docker compose logs openclaw-agent | grep scheduler
# Check the agent-data volume exists
docker volume ls | grep agent-data
```

**AI returns errors:**
```bash
docker compose logs openclaw-litellm
# Check your API key and budget at the provider's dashboard
```

**Custom skill not showing up:**
```bash
# Check YAML syntax
cat openclaw-config/skills/my-skill.yaml
# Look for load errors in agent logs
docker compose logs openclaw-agent | grep -i skill
# Reload without restarting
curl -X POST http://localhost:8080/reload-skills
```

**WP-CLI commands fail:**
```bash
# Check that WordPress path is correct
docker exec openclaw-agent wp --path=/wordpress --allow-root core version

# If WordPress is remote, check bridge plugin
curl https://yoursite.com/wp-json/openclaw/v1/health
```

**HTTP skill can't reach its API:**
```bash
# The domain must be in the Squid allowlist
echo ".api.example.com" >> squid/allowlist.txt
docker exec openclaw-squid squid -k reconfigure
```

**Out of budget:**
```bash
# Edit .env and increase MONTHLY_BUDGET_USD, then:
docker compose restart openclaw-litellm
```
