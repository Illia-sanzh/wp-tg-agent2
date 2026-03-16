# Greenclaw Agent

AI-powered WordPress management via Telegram. Send a message in plain English — the agent executes it on your WordPress site using WP-CLI, REST API, and custom skills.

```
You: "Create a blog post about Python tips with a featured image"
Agent: ✅ Published "10 Python Tips" (ID: 142) with featured image
```

## Architecture

```
Telegram ──► Bot ──► Agent ──► LiteLLM ──► Squid Proxy ──► Internet
                        │                       │
                        ├── WP-CLI ──► WordPress │
                        ├── REST API ──► WordPress
                        ├── MCP Servers
                        └── Custom Skills
```

Five Docker containers on an isolated internal network:

| Container | Role |
|-----------|------|
| **bot** | Telegram interface (grammY) — receives messages, streams progress |
| **agent** | Express API — LLM agentic loop, tool execution, scheduling |
| **litellm** | API proxy — model routing, budget caps, key management |
| **squid** | Egress proxy — domain allowlist, SSRF protection |
| **mcp-runner** | MCP tool server host (GitHub, etc.) |

Only Squid has internet access. All other containers communicate through an internal Docker network.

## Quick Start

### Automated Install (Ubuntu/Debian)

```bash
git clone https://github.com/Illia-sanzh/greenclaw-agent.git
cd greenclaw-agent
chmod +x install.sh
./install.sh
```

The installer handles Docker, WordPress, firewall, and generates all secrets.

### Manual Setup

1. Copy the environment template:
   ```bash
   cp .env.template .env
   ```

2. Fill in required values in `.env`:
   - At least one AI API key (Anthropic, OpenAI, DeepSeek, Gemini, or OpenRouter)
   - Telegram bot token (from [@BotFather](https://t.me/BotFather))
   - Your Telegram user ID (from [@userinfobot](https://t.me/userinfobot))
   - WordPress URL and credentials
   - Generate secrets: `openssl rand -hex 32`

3. Start the stack:
   ```bash
   # Development (with hot reload, pretty logs)
   docker compose up -d

   # Production
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
   ```

4. Message your bot on Telegram — send `/start` to verify.

## What It Can Do

**Content management** — create, edit, publish, schedule posts and pages
```
"Write a blog post about Docker security best practices"
"Schedule the draft post to publish at 5pm UTC"
"Show me all draft posts"
```

**Plugin & theme management** — install, activate, update, configure
```
"Install WooCommerce and create 3 sample products"
"Update all plugins"
"Show me active plugins"
```

**Site administration** — users, settings, media, maintenance
```
"Create an editor user for john@example.com"
"Clear the object cache"
"Show me the site health status"
```

**Scheduling** — cron-based recurring tasks
```
"Update all plugins every Monday at 3am UTC"
"Check for broken links every day at noon"
```

**Custom skills** — extend with YAML tools, markdown knowledge, or JS scripts
```
/skill create → interactive wizard
/skill install → from GitHub URL
```

**Bug fix automation** — forum bug reports trigger automated PR creation
```
Forum post marked as bug → Telegram notification → "Fix this" button → Agent creates PR
```

**Voice messages** — speak your task, Whisper transcribes it

**Image upload** — send a photo, agent uploads to WordPress media library

## Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and feature overview |
| `/help` | Quick command reference |
| `/status` | Agent health, model info, loaded skills |
| `/model` | Show or switch AI model |
| `/model auto` | Enable smart routing (cheap/standard/smart) |
| `/tasks` | List scheduled tasks |
| `/tasks cancel <id>` | Cancel a scheduled task |
| `/skill` | Manage custom skills (list/create/delete/install) |
| `/mcp` | Manage MCP tool servers |
| `/stop` | Abort current request |
| `/cancel` | Clear history and cancel flows |

## Multi-Provider AI

Supports multiple AI providers simultaneously with automatic fallback:

| Provider | Models | Key |
|----------|--------|-----|
| Anthropic | Claude Sonnet/Opus/Haiku | `ANTHROPIC_API_KEY` |
| OpenAI | GPT-4o, GPT-4o-mini | `OPENAI_API_KEY` |
| DeepSeek | DeepSeek Chat/Reasoner | `DEEPSEEK_API_KEY` |
| Google | Gemini 2.0 Flash | `GEMINI_API_KEY` |
| OpenRouter | All of the above + Llama, Mistral, Qwen | `OPENROUTER_API_KEY` |

On startup, the agent probes each configured model to detect which API keys are valid. Failed models are excluded from routing.

Use `/model <name>` in Telegram to lock to a specific model, or `/model auto` for smart routing.

## Security

- **Network isolation** — only the Squid proxy can reach the internet
- **Domain allowlist** — Squid restricts outbound HTTP to approved domains
- **SSRF protection** — private IP ranges blocked at the proxy level
- **Admin restriction** — only your Telegram user ID can send commands
- **Budget cap** — monthly spend limit enforced by LiteLLM
- **Command blocklist** — dangerous WP-CLI commands (`db drop`, `eval`, `shell`) are rejected
- **API authentication** — all agent endpoints require a bearer token
- **Rate limiting** — per-endpoint request throttling prevents abuse

## Custom Skills

Three types of skills extend the agent's capabilities:

**YAML tools** — define a command, HTTP call, or webhook as a callable tool:
```yaml
name: check_seo
type: command
description: Run an SEO audit on a URL
command: "curl -s 'https://api.example.com/seo?url={url}'"
parameters:
  - name: url
    description: URL to audit
    type: string
    required: true
```

**Markdown knowledge** — inject domain knowledge into the agent's prompt:
```
/skill create → type: markdown → paste your content
```

**JS scripts** — Node.js scripts auto-wrapped as callable tools:
```
/skill create → type: script → paste your code
```

Skills are stored in `greenclaw-config/skills/` and persist across restarts.

## Environment Variables

See [.env.template](.env.template) for the full list with descriptions.

**Required:**
- One AI API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_ADMIN_USER_ID` — your Telegram user ID
- `WP_URL` — your WordPress site URL
- `LITELLM_MASTER_KEY` — internal auth key (generate with `openssl rand -hex 32`)

## Development

```bash
# Run tests
npm test

# Type checking
npm run typecheck

# Lint
npm run lint

# Format
npm run format
```

## License

MIT
