# Greenclaw Agent

Manage your WordPress site by texting a Telegram bot. Write what you want in plain English, send a photo, or speak a voice note — the AI agent figures out the rest.

```
You: "Create a landing page that looks like stripe.com with a dark hero section"
Agent: 🌍 Fetching stripe.com layout...
       📝 Writing HTML with animations...
       🔌 Converting to Greenshift blocks...
       🖥 Inserting into WordPress...
       📸 Taking screenshot...
       ✅ Published "Landing Page" — here's how it looks:
       [screenshot]
```

## How It Works

Eight Docker containers on an isolated network. Only the proxy touches the internet.

```
Telegram → Bot → Agent → LiteLLM → Squid → AI APIs
                   │
                   ├── WP-CLI / REST API → WordPress
                   ├── SearXNG → Web search
                   ├── Browserless → Screenshots
                   ├── MCP Runner → GitHub, etc.
                   └── Custom skills (YAML/JS/Markdown)
```

| Container | What it does |
|-----------|-------------|
| **bot** | Telegram interface (grammY) — messages, photos, voice, progress streaming |
| **agent** | Express API — agentic LLM loop, tool execution, task scheduling |
| **litellm** | Model proxy — routes to any provider, budget caps, prompt caching |
| **squid** | Egress proxy — SSRF protection, blocks private IP ranges |
| **mcp-runner** | Sandboxed MCP tool servers (GitHub, etc.) |
| **searxng** | Self-hosted metasearch — no API keys needed |
| **browser** | Headless Chrome — screenshots and page rendering |
| **relay** | Socat bridge — connects internal network to host for WordPress bridge plugin |

## Install

```bash
git clone https://github.com/Illia-sanzh/greenclaw-agent.git
cd greenclaw-agent
sudo bash install.sh
```

The installer walks you through everything: API keys, Telegram bot, WordPress detection, Docker setup, firewall, and secrets. Takes about 5 minutes on a fresh Ubuntu VPS.

For manual setup, copy `.env.template` to `.env`, fill in your keys, and run `docker compose up -d`.

## Features

### Content & Site Management
Create posts, manage plugins, handle users, configure settings — anything you'd do in wp-admin.

### Web Design
Send a URL and the agent replicates its design as WordPress content. Supports Greenshift block conversion, CSS animations, dark/light sections, responsive layouts. Takes screenshots to verify the result.

### Plugin Development
Describe a plugin and the agent scaffolds, writes, and activates it. Checks code against WordPress security standards (sanitization, escaping, nonces, capabilities).

### Scheduling
"Update all plugins every Monday at 3am UTC" — the agent sets up persistent cron jobs that survive container restarts.

### Custom Skills
Extend the agent with YAML tools, markdown knowledge docs, or JS scripts. Install from GitHub repos or create interactively with `/skill`.

### Bug Fix Pipeline
Forum post marked as bug → Telegram notification with "Fix this" button → agent searches GitHub, creates a fix branch, opens a PR, replies on the forum.

### Web Search & Screenshots
SearXNG provides search without API keys. Browserless Chrome takes screenshots for visual verification and design reference.

### Voice & Photos
Send voice notes (transcribed via Whisper) or photos (uploaded to WordPress media library, or used as context for tasks). Multi-photo albums supported.

### Agent Memory
Tell the bot "remember to always use Greenshift blocks" and it saves to a persistent AGENT.md file. The agent reads this on every request so it learns from past mistakes and follows your preferences.

### MCP Tools
Install MCP servers on the fly with `/mcp install <package>`. GitHub MCP enables the bug fix pipeline. Any MCP-compatible tool server works.

## AI Models

Works with any combination of providers. The agent probes each model on startup and only uses ones with valid keys.

| Provider | Models | Env var |
|----------|--------|---------|
| Anthropic | Sonnet 4.6, Opus 4.6 | `ANTHROPIC_API_KEY` |
| OpenAI | GPT-5.4 Mini | `OPENAI_API_KEY` |
| DeepSeek | Chat, Reasoner | `DEEPSEEK_API_KEY` |
| Google | Gemini 2.5 Flash/Pro | `GEMINI_API_KEY` |
| OpenRouter | All of the above + Llama, Mistral, Qwen, etc. | `OPENROUTER_API_KEY` |

Smart routing (`/model auto`) picks the right model per task — cheap for simple lookups, capable for complex work. Cross-provider fallback means if one provider is down, the agent tries another automatically.

## Bot Commands

| Command | What it does |
|---------|-------------|
| `/model` | Show or switch AI model (`/model auto` for smart routing) |
| `/status` | Agent health, loaded skills, available models |
| `/tasks` | List/cancel scheduled tasks |
| `/skill` | Manage skills — list, create, delete, install from GitHub |
| `/mcp` | Install and manage MCP tool servers |
| `/stats` | Usage stats — tasks by profile, model, errors |
| `/stop` | Abort current request |
| `/cancel` | Clear conversation history and stop everything |

## Task Profiles

The agent automatically classifies each request and picks the right tool set:

| Profile | When | Tools |
|---------|------|-------|
| **wp_admin** | Plugin/user/settings management, small fixes | WP-CLI, REST API, file read/write |
| **web_design** | Page creation, layout design, CSS | All creative tools + screenshot + skills |
| **greenshift** | Greenshift/GreenLight block work | Block converter, design skills |
| **plugin_dev** | Building new plugins from scratch | Full dev toolset + security standards |
| **bug_fix** | GitHub bug investigation and PR creation | GitHub MCP + file tools |
| **scheduling** | Cron jobs, timed tasks | Scheduler + basics |
| **general** | Everything else | All tools |

## Security

- Network isolation — containers can't reach the internet directly, only through Squid
- SSRF protection — private IP ranges blocked at the proxy
- Admin lock — only your Telegram user ID can interact with the bot
- Budget cap — monthly AI spend limit enforced by LiteLLM
- Command blocklist — `db drop`, `eval`, `shell` and other dangerous WP-CLI commands rejected
- MCP sandboxing — read-only filesystem, dropped capabilities, no host bind mounts
- Webhook auth — inbound endpoints require a bearer token

## Config

All configuration lives in `.env`. See [.env.template](.env.template) for the full list.

**Minimum required:**
- One AI API key
- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ADMIN_USER_ID`
- `WP_URL` and WordPress credentials
- `LITELLM_MASTER_KEY` (generate: `openssl rand -hex 32`)

## Development

```bash
npm test          # run tests
npm run typecheck # type check agent + bot
npm run lint      # eslint
npm run format    # prettier
```

## License

MIT
