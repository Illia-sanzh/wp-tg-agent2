# wp-tg-agent2 Project Notes

## What This Is
WordPress management bot: user texts Telegram → AI agent → WP-CLI/REST → WordPress changes.

## Branch Architecture
- `main` — custom Telegram bot (`telegram-bot/` using python-telegram-bot)
- `feature/greenclaw-gateway` — GreenClaw Gateway (multi-channel, web dashboard port 18789)

## Critical: The 401 Fix
Agent uses **OpenAI-compatible SDK** (`from openai import OpenAI`) pointing to LiteLLM.
NEVER call Anthropic SDK directly from the agent — causes 401 errors.
Model name: `claude-sonnet-4-6` → LiteLLM maps to `anthropic/claude-sonnet-4-6`.

## Key Files
| File | Role |
|------|------|
| `install.sh` | Single-command installer, asks 8 questions, generates tokens |
| `docker-compose.yml` | 4 containers: greenclaw-agent, greenclaw-litellm, greenclaw-squid, greenclaw-gateway |
| `agent/agent.py` | Flask API: `/ask`, `/task` (LLM loop), `/run` (WP-CLI executor), `/upload` |
| `litellm/config.yaml` | Model routing, budget limits, fallback chain |
| `squid/allowlist.txt` | Allowlist-only egress proxy |
| `wordpress-bridge-plugin/greenclaw-wp-bridge.php` | PHP plugin: runs WP-CLI via REST, auth via `X-GreenClaw-Secret` |
| `SKILL.md` | WP-CLI patterns loaded into Flask agent LLM context |
| `greenclaw-workspace/greenclaw.json` | GreenClaw gateway config (Telegram, LiteLLM, skills) |
| `greenclaw-workspace/skills/wordpress-manager/SKILL.md` | Level 3 skill — GreenClaw LLM = agent brain |

## /run Endpoint (feature/greenclaw-gateway)
```json
{"command": "wp plugin list --format=json"}
{"command": "wp post update 42 {content_file}", "content": "<!-- wp:paragraph -->..."}
```
- Auto-injects `--path` and `--allow-root` for `wp` commands
- `content` field writes HTML to `/tmp/wp-content.html`, replaces `{content_file}` in command
- No LLM — pure executor

## GreenClaw Frontmatter
Use `user-invokable: true` (NOT `user-invocable` — wrong spelling, will be rejected).

## Security
- Squid: allowlist-only outbound
- LiteLLM: monthly budget cap via `MONTHLY_BUDGET_USD`
- Bridge plugin: `X-GreenClaw-Secret` header auth
- Telegram: single user via `TELEGRAM_ADMIN_USER_ID`
- Blocked WP-CLI: `db drop`, `db reset`, `site empty`, `eval`, `shell`

## Memory Limits (4GB VPS)
- greenclaw-agent: 1536MB
- greenclaw-litellm: 512MB
- greenclaw-gateway: 512MB
- greenclaw-squid: ~64MB

## GREENCLAW_GATEWAY_TOKEN
Required for web dashboard login. Auto-generated in `install.sh` via `openssl rand -hex 32`.
Written to `.env`, passed to `greenclaw-gateway` container, displayed in install summary.

## AI Providers
Anthropic, OpenAI, DeepSeek, Gemini — all routed through LiteLLM with fallback chain.

## MCP Extensibility (not yet implemented on main)
Pattern for adding Gmail/etc: MCP server as Docker container → agent fetches tool definitions
at startup → adds to LLM's TOOLS list → dispatches calls when LLM requests them.
~50 lines in agent.py + new Docker container per MCP server.
