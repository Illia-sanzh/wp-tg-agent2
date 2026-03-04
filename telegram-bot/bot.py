"""
Telegram Bot — WordPress Agent Interface
────────────────────────────────────────
Receives messages from the authorized user and forwards them to the
WordPress AI agent. Streams back the result.

Features:
  • Text messages  → agent task
  • Voice messages → Whisper transcription → agent task
  • Photos         → asks what to do (upload, featured image, blog post, etc.)
  • GitHub .yaml URL in chat → auto-installs as a custom skill
  • /start         → welcome + feature list
  • /status        → agent health check
  • /model         → show or switch AI model
  • /stop          → abort the current AI request
  • /cancel        → clear conversation history (also cancels active flows)
  • /tasks         → list / cancel scheduled tasks
  • /skill         → list, create, install (GitHub), show, delete, reload skills
  • /mcp           → list, install, remove, reload MCP tool servers
"""

import asyncio
import json
import logging
import os
import re
import threading
import time

import requests
from telegram import Update, BotCommand
from telegram.constants import ParseMode, ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)

# ─── Config ───────────────────────────────────────────────────────────────────

TELEGRAM_BOT_TOKEN = os.environ["TELEGRAM_BOT_TOKEN"]
# Supports a single ID or a comma-separated list: "123456,789012"
ADMIN_USER_IDS = {
    int(uid.strip())
    for uid in os.environ["TELEGRAM_ADMIN_USER_ID"].split(",")
    if uid.strip()
}
AGENT_URL     = os.environ.get("AGENT_URL", "http://openclaw-agent:8080")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "claude-sonnet-4-6")

# ── Smart model routing ───────────────────────────────────────────────────────
AUTO_ROUTING = os.environ.get("AUTO_ROUTING", "false").lower() == "true"
FAST_MODEL   = os.environ.get("FAST_MODEL",  "claude-haiku-4-5")
SMART_MODEL  = os.environ.get("SMART_MODEL", DEFAULT_MODEL)

# ── Known model names (must match litellm/config.yaml entries) ────────────────
_KNOWN_MODELS = {
    "auto",
    "claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6",
    "gpt-4o", "gpt-4o-mini",
    "deepseek-chat", "deepseek-reasoner",
    "gemini-2.0-flash",
    "openrouter/claude-sonnet-4-6", "openrouter/claude-haiku-4-5", "openrouter/claude-opus-4-6",
    "openrouter/gpt-4o", "openrouter/gpt-4o-mini",
    "openrouter/gemini-2.0-flash",
    "openrouter/deepseek-chat", "openrouter/deepseek-r1",
    "openrouter/llama-3.3-70b", "openrouter/mistral-large",
    "openrouter/gemma-3-27b", "openrouter/qwq-32b",
}

def _is_valid_model(name: str) -> bool:
    return name in _KNOWN_MODELS or name.startswith("openrouter/")

# ── MCP Catalog ───────────────────────────────────────────────────────────────
# Curated list of installable MCP servers.  Each entry carries:
#   package     — exact npm package name
#   description — one-line description shown in /mcp list
#   category    — grouping for display
#   env         — list of env var dicts: {name, hint, required}
#
# The whitelist enforced by mcp-runner.js is derived from this catalog.
# Adding a new MCP requires a code change here AND in mcp-runner/mcp-runner.js.

_MCP_CATALOG: dict[str, dict] = {

    # ── Utility / No auth ─────────────────────────────────────────────────────
    "server-fetch": {
        "package":     "@modelcontextprotocol/server-fetch",
        "description": "Fetch any URL and convert to clean markdown",
        "category":    "Utility",
        "env": [],
    },
    "server-memory": {
        "package":     "@modelcontextprotocol/server-memory",
        "description": "Persistent key-value knowledge graph between sessions",
        "category":    "Utility",
        "env": [],
    },
    "server-filesystem": {
        "package":     "@modelcontextprotocol/server-filesystem",
        "description": "Read, write and search files in allowed directories",
        "category":    "Utility",
        "env": [],
    },
    "server-sequentialthinking": {
        "package":     "@modelcontextprotocol/server-sequentialthinking",
        "description": "Dynamic step-by-step reasoning with reflection",
        "category":    "Utility",
        "env": [],
    },
    "server-time": {
        "package":     "@modelcontextprotocol/server-time",
        "description": "Current time, timezone conversion",
        "category":    "Utility",
        "env": [],
    },
    "server-everything": {
        "package":     "@modelcontextprotocol/server-everything",
        "description": "Reference/test server — useful for debugging",
        "category":    "Utility",
        "env": [],
    },

    # ── Databases ─────────────────────────────────────────────────────────────
    "server-postgres": {
        "package":     "@modelcontextprotocol/server-postgres",
        "description": "Query and inspect PostgreSQL databases",
        "category":    "Database",
        "env": [
            {"name": "POSTGRES_URL",
             "hint": "Full connection string, e.g. postgresql://user:pass@host:5432/dbname",
             "required": True},
        ],
    },
    "server-sqlite": {
        "package":     "@modelcontextprotocol/server-sqlite",
        "description": "Read/write SQLite databases on the local filesystem",
        "category":    "Database",
        "env": [],
    },
    "supabase": {
        "package":     "@supabase/mcp-server-supabase",
        "description": "Manage Supabase projects, databases, storage and edge functions",
        "category":    "Database",
        "env": [
            {"name": "SUPABASE_ACCESS_TOKEN",
             "hint": "Personal access token from app.supabase.com/account/tokens",
             "required": True},
        ],
    },
    "qdrant": {
        "package":     "@qdrant/mcp-server-qdrant",
        "description": "Store and query vector embeddings for semantic memory",
        "category":    "Database",
        "env": [
            {"name": "QDRANT_URL",
             "hint": "Your Qdrant instance URL, e.g. http://localhost:6333 or cloud URL",
             "required": True},
            {"name": "QDRANT_API_KEY",
             "hint": "Qdrant Cloud API key (skip for local instances)",
             "required": False},
        ],
    },
    "duckdb": {
        "package":     "@motherduck/mcp-server-duckdb",
        "description": "Query DuckDB and MotherDuck cloud warehouse",
        "category":    "Database",
        "env": [
            {"name": "motherduck_token",
             "hint": "MotherDuck token from app.motherduck.com (optional for local DuckDB)",
             "required": False},
        ],
    },

    # ── Search ────────────────────────────────────────────────────────────────
    "brave-search": {
        "package":     "@brave/brave-search-mcp-server",
        "description": "Web, news, image and video search via Brave Search API",
        "category":    "Search",
        "env": [
            {"name": "BRAVE_API_KEY",
             "hint": "API key from brave.com/search/api — free tier available",
             "required": True},
        ],
    },
    "tavily": {
        "package":     "tavily-mcp",
        "description": "AI-optimised web search, extract, crawl (great for research)",
        "category":    "Search",
        "env": [
            {"name": "TAVILY_API_KEY",
             "hint": "API key from app.tavily.com — free tier includes 1 000 req/month",
             "required": True},
        ],
    },
    "exa": {
        "package":     "exa-mcp-server",
        "description": "Neural web search — academic papers, LinkedIn, real-time results",
        "category":    "Search",
        "env": [
            {"name": "EXA_API_KEY",
             "hint": "API key from exa.ai/api — free trial available",
             "required": True},
        ],
    },
    "firecrawl": {
        "package":     "@mendable/firecrawl-mcp",
        "description": "Advanced web scraping, crawling and structured data extraction",
        "category":    "Search",
        "env": [
            {"name": "FIRECRAWL_API_KEY",
             "hint": "API key from firecrawl.dev — free tier available",
             "required": True},
        ],
    },
    "server-google-maps": {
        "package":     "@modelcontextprotocol/server-google-maps",
        "description": "Geocoding, directions, place search via Google Maps",
        "category":    "Search",
        "env": [
            {"name": "GOOGLE_MAPS_API_KEY",
             "hint": "API key from console.cloud.google.com — enable Maps JavaScript API",
             "required": True},
        ],
    },

    # ── Developer tools ───────────────────────────────────────────────────────
    "server-github": {
        "package":     "@modelcontextprotocol/server-github",
        "description": "GitHub repos, issues, PRs, file search, code review",
        "category":    "Developer",
        "env": [
            {"name": "GITHUB_PERSONAL_ACCESS_TOKEN",
             "hint": "Classic token from github.com/settings/tokens — needs repo + read:org",
             "required": True},
        ],
    },
    "cloudflare": {
        "package":     "@cloudflare/mcp-server-cloudflare",
        "description": "Manage Cloudflare Workers, KV, R2, D1, DNS zones",
        "category":    "Developer",
        "env": [
            {"name": "CLOUDFLARE_API_TOKEN",
             "hint": "API token from dash.cloudflare.com/profile/api-tokens",
             "required": True},
            {"name": "CLOUDFLARE_ACCOUNT_ID",
             "hint": "Account ID from the right sidebar of your Cloudflare dashboard",
             "required": True},
        ],
    },
    "sentry": {
        "package":     "@sentry/mcp-server",
        "description": "Query Sentry errors, issues, releases and performance data",
        "category":    "Developer",
        "env": [
            {"name": "SENTRY_AUTH_TOKEN",
             "hint": "Auth token from sentry.io/settings/account/api/auth-tokens/",
             "required": True},
            {"name": "SENTRY_ORG",
             "hint": "Your Sentry organisation slug (shown in URL: sentry.io/organizations/<slug>)",
             "required": False},
        ],
    },
    "vercel": {
        "package":     "@open-mcp/vercel",
        "description": "Manage Vercel deployments, projects, domains and env vars",
        "category":    "Developer",
        "env": [
            {"name": "VERCEL_API_KEY",
             "hint": "Token from vercel.com/account/tokens",
             "required": True},
        ],
    },

    # ── Productivity / Project management ─────────────────────────────────────
    "notion": {
        "package":     "@notionhq/notion-mcp-server",
        "description": "Search, read and write Notion pages and databases",
        "category":    "Productivity",
        "env": [
            {"name": "NOTION_TOKEN",
             "hint": "Integration token from notion.so/profile/integrations — create an internal integration",
             "required": True},
        ],
    },
    "linear": {
        "package":     "linear-mcp-server",
        "description": "Create and manage Linear issues, projects and cycles",
        "category":    "Productivity",
        "env": [
            {"name": "LINEAR_API_KEY",
             "hint": "Personal API key from linear.app/settings/api",
             "required": True},
        ],
    },

    # ── Communication ─────────────────────────────────────────────────────────
    "server-slack": {
        "package":     "@modelcontextprotocol/server-slack",
        "description": "Read/write Slack messages, list channels, manage threads",
        "category":    "Communication",
        "env": [
            {"name": "SLACK_BOT_TOKEN",
             "hint": "Bot User OAuth token (xoxb-...) from api.slack.com/apps > OAuth & Permissions",
             "required": True},
            {"name": "SLACK_TEAM_ID",
             "hint": "Workspace ID starting with T — shown in workspace URL or admin panel",
             "required": True},
        ],
    },

    # ── Payments / E-commerce ─────────────────────────────────────────────────
    "stripe": {
        "package":     "@stripe/mcp",
        "description": "Query Stripe customers, payments, subscriptions and webhooks",
        "category":    "Payments",
        "env": [
            {"name": "STRIPE_SECRET_KEY",
             "hint": "Secret key from dashboard.stripe.com/apikeys — use test key (sk_test_...) first",
             "required": True},
        ],
    },
    "shopify": {
        "package":     "shopify-mcp-server",
        "description": "Manage Shopify products, orders, customers and collections",
        "category":    "Payments",
        "env": [
            {"name": "SHOPIFY_ACCESS_TOKEN",
             "hint": "Admin API access token from your Shopify app settings",
             "required": True},
            {"name": "MYSHOPIFY_DOMAIN",
             "hint": "Your store domain, e.g. mystore.myshopify.com",
             "required": True},
        ],
    },
}

# Derived whitelist — package names only (used for fast lookup)
_MCP_WHITELIST: dict[str, str] = {k: v["package"] for k, v in _MCP_CATALOG.items()}

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO,
)
logger = logging.getLogger(__name__)

# ─── Auth helper ──────────────────────────────────────────────────────────────

def is_admin(update: Update) -> bool:
    return update.effective_user.id in ADMIN_USER_IDS

# ─── Smart model routing ──────────────────────────────────────────────────────

_FAST_KEYWORDS = {
    "show", "list", "get", "fetch", "find", "check", "count", "display",
    "status", "health", "ping", "version", "info", "which", "who",
    "what is", "what are", "how many", "is there", "are there",
}
_SMART_KEYWORDS = {
    "analyze", "analyse", "audit", "debug", "diagnose", "investigate",
    "optimize", "optimise", "review", "evaluate", "compare",
    "migrate", "migration", "restructure", "refactor",
    "comprehensive", "thorough", "complete", "detailed", "full report",
    "performance", "security", "vulnerability", "why is", "why does",
    "figure out", "root cause", "step by step",
}

def _auto_select_model(message: str) -> tuple[str, str]:
    msg   = message.lower().strip()
    words = msg.split()
    n     = len(words)

    if n > 80:
        return SMART_MODEL, "smart"
    if msg.count(" and ") >= 3:
        return SMART_MODEL, "smart"
    if any(kw in msg for kw in _SMART_KEYWORDS):
        return SMART_MODEL, "smart"

    if n <= 15 and any(kw in msg for kw in _FAST_KEYWORDS):
        return FAST_MODEL, "fast"
    if n <= 5:
        return FAST_MODEL, "fast"

    return DEFAULT_MODEL, "standard"

# ─── Flow state helpers ────────────────────────────────────────────────────────
# Instead of ConversationHandler, we use user_data to track multi-step flows.
# This keeps all routing in one place and doesn't require restructuring handlers.

def _clear_flows(ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Clear any active skill-create, skill-delete, MCP-install, media, or browse flow."""
    for key in ("skill_draft", "skill_step", "pending_skill_delete",
                "mcp_draft", "mcp_step", "pending_media", "media_step",
                "skill_browse_step", "skill_browse_files", "skill_browse_repo"):
        ctx.user_data.pop(key, None)

def _in_flow(ctx: ContextTypes.DEFAULT_TYPE) -> bool:
    return bool(
        ctx.user_data.get("skill_step")
        or ctx.user_data.get("pending_skill_delete")
        or ctx.user_data.get("mcp_step")
        or ctx.user_data.get("media_step")
        or ctx.user_data.get("skill_browse_step")
    )

# ─── Command handlers ─────────────────────────────────────────────────────────

async def cmd_start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return
    await update.message.reply_text(
        "👋 *WordPress Agent* is ready.\n\n"
        "Send a task in plain English:\n"
        "• _Create a blog post about Python tips_\n"
        "• _Install WooCommerce and create 3 products_\n"
        "• _Show me all active plugins_\n"
        "• _Publish the draft post at 5pm UTC_\n"
        "• _Update all plugins every Monday at 3am_\n\n"
        "🎙️ *Voice messages* are supported — just send a voice note!\n\n"
        "Commands:\n"
        "`/status`  — check agent health\n"
        "`/model`   — show or change AI model\n"
        "`/tasks`   — list or cancel scheduled tasks\n"
        "`/skill`   — manage custom skills\n"
        "`/mcp`     — manage MCP tool servers\n"
        "`/stop`    — abort current AI request\n"
        "`/cancel`  — clear history & cancel flows",
        parse_mode=ParseMode.MARKDOWN,
    )


async def cmd_status(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        return
    try:
        r = requests.get(f"{AGENT_URL}/health", timeout=5)
        d = r.json()
        whisper = d.get("whisper", "unknown")
        jobs    = d.get("scheduled_jobs", 0)
        skills  = d.get("custom_skills", 0)
        mcps    = d.get("mcp_tools", 0)
        routing_mode = "auto (smart routing on)" if AUTO_ROUTING else "manual"
        await update.message.reply_text(
            f"✅ Agent online\n"
            f"Default model: `{d.get('model', 'unknown')}`\n"
            f"Model routing: `{routing_mode}`\n"
            f"Scheduler: `{d.get('scheduler', 'unknown')}` ({jobs} job(s))\n"
            f"Custom skills: `{skills}`\n"
            f"MCP tools: `{mcps}`\n"
            f"Voice (Whisper): `{whisper}`",
            parse_mode=ParseMode.MARKDOWN,
        )
    except Exception as e:
        await update.message.reply_text(f"❌ Agent unreachable: {e}")


async def cmd_model(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        return
    args = ctx.args
    if not args:
        manual = ctx.user_data.get("model")
        if AUTO_ROUTING and not manual:
            current_line = (
                f"Current: *auto-routing* 🧠\n"
                f"  Fast  → `{FAST_MODEL}`\n"
                f"  Standard → `{DEFAULT_MODEL}`\n"
                f"  Smart → `{SMART_MODEL}`\n\n"
                "Use `/model auto` to keep routing on, or pick a model to lock it in."
            )
        else:
            current_line = f"Current model: `{manual or DEFAULT_MODEL}`"
            if AUTO_ROUTING:
                current_line += " _(auto-routing overridden)_\nUse `/model auto` to re-enable routing."
        await update.message.reply_text(
            f"{current_line}\n\n"
            "*Select a model:*\n"
            "• `auto` — smart routing ⚡/◆/🧠 (picks cheapest that fits)\n\n"
            "*Anthropic:*\n"
            "• `claude-sonnet-4-6` — default, best quality\n"
            "• `claude-haiku-4-5` — fast & cheap\n"
            "• `claude-opus-4-6` — hardest tasks\n\n"
            "*OpenAI:*\n"
            "• `gpt-4o` / `gpt-4o-mini`\n\n"
            "*DeepSeek:*\n"
            "• `deepseek-chat` / `deepseek-reasoner`\n\n"
            "*Google:*\n"
            "• `gemini-2.0-flash`\n\n"
            "*Via OpenRouter* (only OPENROUTER\\_API\\_KEY needed):\n"
            "• `openrouter/claude-sonnet-4-6` / `openrouter/claude-opus-4-6` / `openrouter/claude-haiku-4-5`\n"
            "• `openrouter/gpt-4o` / `openrouter/gpt-4o-mini`\n"
            "• `openrouter/gemini-2.0-flash`\n"
            "• `openrouter/deepseek-chat` / `openrouter/deepseek-r1`\n"
            "• `openrouter/llama-3.3-70b` · `openrouter/mistral-large` · `openrouter/qwq-32b`\n"
            "• Any slug from openrouter.ai — prefix with `openrouter/`\n\n"
            "Usage: `/model claude-opus-4-6` — lock to a model\n"
            "Usage: `/model auto` — enable smart routing",
            parse_mode=ParseMode.MARKDOWN,
        )
        return
    choice = args[0].strip()
    if choice == "auto":
        ctx.user_data.pop("model", None)
        status = "✅ Auto-routing re-enabled." if AUTO_ROUTING else (
            "ℹ️ Auto-routing is disabled in .env (AUTO_ROUTING=false). "
            "The default model will be used."
        )
        await update.message.reply_text(status)
    elif not _is_valid_model(choice):
        await update.message.reply_text(
            f"❌ Unknown model: `{choice}`\n\n"
            "Use `/model` to see the list of available models.\n"
            "For OpenRouter, prefix with `openrouter/` — e.g. `openrouter/llama-3.3-70b`",
            parse_mode=ParseMode.MARKDOWN,
        )
    else:
        ctx.user_data["model"] = choice
        await update.message.reply_text(f"✅ Locked to model: `{choice}`", parse_mode=ParseMode.MARKDOWN)


async def cmd_cancel(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        return
    in_flow = _in_flow(ctx)
    _clear_flows(ctx)
    # Also stop any running agent request
    stop_event: threading.Event | None = ctx.user_data.get("stop_event")
    if stop_event:
        stop_event.set()
    ctx.user_data.pop("stop_event", None)
    ctx.user_data.pop("history", None)
    if in_flow:
        await update.message.reply_text("🛑 Flow cancelled and conversation history cleared.")
    else:
        await update.message.reply_text("🛑 Task cancelled and conversation history cleared.")


async def cmd_stop(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """Abort the current AI request without clearing history."""
    if not is_admin(update):
        return
    stop_event: threading.Event | None = ctx.user_data.get("stop_event")
    if stop_event and not stop_event.is_set():
        stop_event.set()
        await update.message.reply_text("🛑 Stopping current request…")
    else:
        await update.message.reply_text("ℹ️ Nothing is running right now.")


async def cmd_tasks(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """List all scheduled tasks or cancel one by ID."""
    if not is_admin(update):
        return

    args = ctx.args or []

    if args and args[0].lower() == "cancel":
        if len(args) < 2:
            await update.message.reply_text("Usage: `/tasks cancel <job_id>`", parse_mode=ParseMode.MARKDOWN)
            return
        job_id = args[1]
        try:
            r = requests.delete(f"{AGENT_URL}/schedules/{job_id}", timeout=10)
            data = r.json()
            if "error" in data:
                await update.message.reply_text(f"❌ {data['error']}")
            else:
                await update.message.reply_text(
                    f"✅ Scheduled task `{job_id}` cancelled.",
                    parse_mode=ParseMode.MARKDOWN,
                )
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {e}")
        return

    try:
        r = requests.get(f"{AGENT_URL}/schedules", timeout=10)
        data = r.json()
    except Exception as e:
        await update.message.reply_text(f"❌ Error fetching schedules: {e}")
        return

    jobs = data.get("jobs", [])
    if not jobs:
        await update.message.reply_text(
            "📅 No scheduled tasks.\n\n"
            "Schedule one by telling the bot:\n"
            "_\"Update all plugins every Monday at 3am UTC\"_",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    lines = ["📅 *Scheduled Tasks:*\n"]
    for job in jobs:
        lines.append(f"*{job['name']}*")
        lines.append(f"  Next run: `{job['next_run']}`")
        lines.append(f"  Trigger: `{job['trigger']}`")
        lines.append(f"  ID: `{job['id']}`")
        lines.append("")
    lines.append("To cancel: `/tasks cancel <ID>`")

    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


# ─── GitHub skill helpers ─────────────────────────────────────────────────────

def _github_to_raw(url: str) -> str:
    """Convert a GitHub blob URL to raw.githubusercontent.com URL."""
    m = re.match(
        r"https://github\.com/([^/]+)/([^/]+)/blob/([^/]+)/(.+)",
        url.strip()
    )
    if m:
        user, repo, branch, path = m.groups()
        return f"https://raw.githubusercontent.com/{user}/{repo}/{branch}/{path}"
    return url.strip()


def _is_github_yaml_url(text: str) -> bool:
    """Return True if text is solely a GitHub URL pointing to a YAML file."""
    text = text.strip()
    if " " in text or "\n" in text:
        return False
    return bool(re.match(
        r"https://(?:github\.com/[^/]+/[^/]+/blob/|raw\.githubusercontent\.com/[^/]+/[^/]+/)[^\s]+\.ya?ml$",
        text
    ))


async def _install_skill_from_url(update: Update, url: str) -> None:
    """Download a YAML skill from a GitHub URL and install it via the agent."""
    raw_url = _github_to_raw(url)
    status_msg = await update.message.reply_text("⬇️ Downloading skill from GitHub…")
    try:
        r = requests.get(raw_url, timeout=30)
        if r.status_code != 200:
            await status_msg.edit_text(
                f"❌ Failed to download skill: HTTP {r.status_code}\n`{raw_url}`",
                parse_mode=ParseMode.MARKDOWN,
            )
            return
        yaml_content = r.text
    except Exception as e:
        await status_msg.edit_text(f"❌ Download failed: {e}")
        return

    try:
        r2 = requests.post(
            f"{AGENT_URL}/skills",
            json={"yaml": yaml_content},
            timeout=15,
        )
        data = r2.json()
    except Exception as e:
        await status_msg.edit_text(f"❌ Error installing skill: {e}")
        return

    if "error" in data:
        await status_msg.edit_text(
            f"❌ Invalid skill YAML:\n`{data['error']}`",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    name = data.get("name", "?")
    tool_name = data.get("tool_name", f"skill_{name}")
    await status_msg.edit_text(
        f"✅ Skill `{name}` installed from GitHub!\n"
        f"Tool: `{tool_name}`\n\n"
        f"Use `/skill show {name}` to inspect it.",
        parse_mode=ParseMode.MARKDOWN,
    )


# ─── GitHub repo/directory browsing ──────────────────────────────────────────

def _parse_github_repo_url(url: str) -> dict | None:
    """
    Parse a GitHub repo or tree URL.
    Returns {"owner", "repo", "branch", "path"} or None if it doesn't match.
    Does NOT match direct file URLs (/blob/ or raw.githubusercontent.com).
    """
    url = url.strip().rstrip("/")
    # Bare repo root: https://github.com/owner/repo
    m = re.match(r"https://github\.com/([^/]+)/([^/?#]+)$", url)
    if m:
        return {"owner": m.group(1), "repo": m.group(2), "branch": "", "path": ""}
    # Tree URL: https://github.com/owner/repo/tree/branch[/path]
    m = re.match(r"https://github\.com/([^/]+)/([^/]+)/tree/([^/]+)(?:/(.+))?$", url)
    if m:
        return {"owner": m.group(1), "repo": m.group(2),
                "branch": m.group(3), "path": m.group(4) or ""}
    return None


def _is_github_repo_url(text: str) -> bool:
    """Return True if text is solely a GitHub repo or tree URL (not a direct file)."""
    text = text.strip()
    if " " in text or "\n" in text:
        return False
    return _parse_github_repo_url(text) is not None


def _list_github_yaml_files(owner: str, repo: str, branch: str,
                             path_prefix: str) -> tuple[list[str], str, str]:
    """
    Return (yaml_paths, warning_message, resolved_branch) for all .yaml/.yml
    files in the repo under path_prefix, using the GitHub recursive trees API.
    """
    headers = {
        "Accept": "application/vnd.github.v3+json",
        "User-Agent": "openclaw-bot/1.0",
    }

    # Resolve default branch if caller didn't supply one
    if not branch:
        r = requests.get(
            f"https://api.github.com/repos/{owner}/{repo}",
            headers=headers, timeout=15,
        )
        if r.status_code != 200:
            raise RuntimeError(f"HTTP {r.status_code} fetching repo info")
        branch = r.json().get("default_branch", "main")

    r = requests.get(
        f"https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1",
        headers=headers, timeout=25,
    )
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} from GitHub API")

    data      = r.json()
    tree      = data.get("tree", [])
    truncated = data.get("truncated", False)

    prefix = (path_prefix.rstrip("/") + "/") if path_prefix else ""
    yaml_files = sorted(
        item["path"] for item in tree
        if item.get("type") == "blob"
        and item["path"].lower().endswith((".yaml", ".yml"))
        and (not prefix or item["path"].startswith(prefix))
    )

    warn = ("_(Note: repo has too many files; list may be incomplete)_"
            if truncated else "")
    return yaml_files, warn, branch


async def _browse_github_skills(update: Update, ctx: ContextTypes.DEFAULT_TYPE,
                                 repo_info: dict) -> None:
    """Fetch YAML file list from a GitHub repo and show a numbered menu."""
    owner  = repo_info["owner"]
    repo   = repo_info["repo"]
    branch = repo_info["branch"]
    path   = repo_info["path"]

    loc = f"`{owner}/{repo}`" + (f"`/{path}`" if path else "")
    status = await update.message.reply_text(
        f"🔍 Scanning {loc} for skill files…", parse_mode=ParseMode.MARKDOWN
    )

    try:
        files, warn, branch = _list_github_yaml_files(owner, repo, branch, path)
    except Exception as e:
        await status.edit_text(f"❌ GitHub API error: {e}")
        return

    if not files:
        await status.edit_text(
            f"❌ No `.yaml`/`.yml` files found in {loc}.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # Store browse state (branch is now fully resolved)
    _clear_flows(ctx)
    ctx.user_data["skill_browse_repo"]  = {
        "owner": owner, "repo": repo, "branch": branch,
    }
    ctx.user_data["skill_browse_files"] = files
    ctx.user_data["skill_browse_step"]  = "waiting"

    MAX_SHOWN = 40
    shown = files[:MAX_SHOWN]
    lines = [f"📦 Found *{len(files)}* skill file(s) in `{owner}/{repo}`:\n"]
    for i, f in enumerate(shown, 1):
        lines.append(f"`{i}.` `{f}`")
    if len(files) > MAX_SHOWN:
        lines.append(f"\n_…and {len(files) - MAX_SHOWN} more (first {MAX_SHOWN} shown)_")
    if warn:
        lines.append(f"\n{warn}")
    lines.append(
        "\nReply with:\n"
        "• A number — e.g. `3`\n"
        "• Multiple numbers — e.g. `1 3 5`\n"
        "• A range — e.g. `2-5`\n"
        "• `all` — install everything\n"
        "• `/cancel` to abort"
    )
    await status.edit_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


async def handle_skill_browse_step(update: Update,
                                    ctx: ContextTypes.DEFAULT_TYPE) -> bool:
    """Handle the user's skill-selection reply in the GitHub browse flow."""
    if ctx.user_data.get("skill_browse_step") != "waiting":
        return False

    text = (update.message.text or "").strip()
    if not text:
        return False

    files      = ctx.user_data.get("skill_browse_files", [])
    repo_meta  = ctx.user_data.get("skill_browse_repo", {})
    owner      = repo_meta.get("owner", "")
    repo_name  = repo_meta.get("repo", "")
    branch     = repo_meta.get("branch", "main")

    # Parse selection
    selected: set[int] = set()
    if text.lower() == "all":
        selected = set(range(len(files)))
    else:
        for token in re.split(r"[\s,]+", text):
            token = token.strip()
            if not token:
                continue
            m = re.match(r"^(\d+)-(\d+)$", token)
            if m:
                lo, hi = int(m.group(1)), int(m.group(2))
                for i in range(lo, min(hi, len(files)) + 1):
                    if 1 <= i:
                        selected.add(i - 1)
            elif token.isdigit():
                i = int(token)
                if 1 <= i <= len(files):
                    selected.add(i - 1)

    if not selected:
        await update.message.reply_text(
            "❓ Please reply with a number, range, or `all`.\n"
            "Example: `3`, `1 2 5`, `2-4`, `all`",
            parse_mode=ParseMode.MARKDOWN,
        )
        return True  # still in flow

    # Clear browse state
    for k in ("skill_browse_step", "skill_browse_files", "skill_browse_repo"):
        ctx.user_data.pop(k, None)

    chosen = [files[i] for i in sorted(selected)]

    if len(chosen) == 1:
        status = await update.message.reply_text(
            f"⬇️ Installing `{chosen[0]}`…", parse_mode=ParseMode.MARKDOWN
        )
    else:
        status = await update.message.reply_text(
            f"⬇️ Installing {len(chosen)} skill(s)…"
        )

    results = []
    for fpath in chosen:
        raw_url = (
            f"https://raw.githubusercontent.com/{owner}/{repo_name}/{branch}/{fpath}"
        )
        try:
            r = requests.get(raw_url, timeout=20)
            if r.status_code != 200:
                results.append(f"❌ `{fpath}` — HTTP {r.status_code}")
                continue
            r2 = requests.post(
                f"{AGENT_URL}/skills", json={"yaml": r.text}, timeout=15
            )
            d = r2.json()
            if "error" in d:
                results.append(f"❌ `{fpath}` — {d['error']}")
            else:
                name = d.get("name", fpath)
                results.append(f"✅ `{name}`")
        except Exception as e:
            results.append(f"❌ `{fpath}` — {e}")

    await status.edit_text(
        "📦 Install results:\n\n" + "\n".join(results),
        parse_mode=ParseMode.MARKDOWN,
    )
    return True


# ─── /skill command ───────────────────────────────────────────────────────────

async def cmd_skill(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """
    /skill              — list custom skills + built-ins
    /skill reload       — hot-reload YAML files from disk
    /skill show <name>  — show raw YAML for a skill
    /skill delete <name>— delete skill (asks for confirmation)
    /skill create       — guided multi-step skill creation flow
    """
    if not is_admin(update):
        return

    args = ctx.args or []
    sub  = args[0].lower() if args else ""

    # ── reload ────────────────────────────────────────────────────────────────
    if sub == "reload":
        try:
            r = requests.post(f"{AGENT_URL}/reload-skills", timeout=15)
            data = r.json()
            loaded = data.get("loaded", 0)
            names  = data.get("skills", [])
            skills_text = "\n".join(f"• `{n}`" for n in names) if names else "_(none)_"
            await update.message.reply_text(
                f"🔄 Skills reloaded — {loaded} custom skill(s) active:\n\n{skills_text}",
                parse_mode=ParseMode.MARKDOWN,
            )
        except Exception as e:
            await update.message.reply_text(f"❌ Reload failed: {e}")
        return

    # ── show <name> ────────────────────────────────────────────────────────────
    if sub == "show":
        if len(args) < 2:
            await update.message.reply_text("Usage: `/skill show <name>`", parse_mode=ParseMode.MARKDOWN)
            return
        name = args[1]
        try:
            r = requests.get(f"{AGENT_URL}/skills/{name}", timeout=10)
            if r.status_code == 404:
                await update.message.reply_text(f"❌ Skill `{name}` not found.", parse_mode=ParseMode.MARKDOWN)
                return
            data = r.json()
            raw_yaml = data.get("yaml", "(empty)")
            await update.message.reply_text(
                f"📄 *Skill:* `{name}`\n\n```\n{raw_yaml}\n```",
                parse_mode=ParseMode.MARKDOWN,
            )
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {e}")
        return

    # ── delete <name> ──────────────────────────────────────────────────────────
    if sub == "delete":
        if len(args) < 2:
            await update.message.reply_text("Usage: `/skill delete <name>`", parse_mode=ParseMode.MARKDOWN)
            return
        name = args[1]
        ctx.user_data["pending_skill_delete"] = name
        await update.message.reply_text(
            f"⚠️ Are you sure you want to delete skill `{name}`?\n\nType `yes` to confirm or `/cancel` to abort.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # ── install <url> ─────────────────────────────────────────────────────────
    if sub == "install":
        if len(args) < 2:
            await update.message.reply_text(
                "📦 *Install a skill from GitHub*\n\n"
                "Usage: `/skill install <github-url>`\n\n"
                "Supports:\n"
                "• Direct file: `.../blob/main/skill.yaml`\n"
                "• Whole repo: `https://github.com/user/repo`\n"
                "• Subdirectory: `.../tree/main/subdir`\n\n"
                "_Tip: paste any GitHub URL directly in chat — the bot detects it automatically!_",
                parse_mode=ParseMode.MARKDOWN,
            )
            return
        url = args[1]
        if _is_github_yaml_url(url):
            await _install_skill_from_url(update, url)
        elif _is_github_repo_url(url):
            repo_info = _parse_github_repo_url(url)
            await _browse_github_skills(update, ctx, repo_info)
        else:
            await update.message.reply_text(
                "❌ Unrecognised URL. Please provide a GitHub `.yaml` file link or a repo/directory URL.",
                parse_mode=ParseMode.MARKDOWN,
            )
        return

    # ── create ─────────────────────────────────────────────────────────────────
    if sub == "create":
        _clear_flows(ctx)
        ctx.user_data["skill_draft"] = {}
        ctx.user_data["skill_step"]  = "name"
        await update.message.reply_text(
            "🛠️ *Create a new skill* — Step 1/5\n\n"
            "What is the skill *name*?\n"
            "_(alphanumeric + underscores only, e.g. `check_ssl`)_\n\n"
            "Type `/cancel` at any time to abort.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # ── list (default) ─────────────────────────────────────────────────────────
    try:
        r = requests.get(f"{AGENT_URL}/skills", timeout=10)
        data = r.json()
    except Exception as e:
        await update.message.reply_text(f"❌ Error fetching skills: {e}")
        return

    builtin = data.get("builtin", [])
    custom  = data.get("custom", [])

    builtin_text = "\n".join(f"• `{n}`" for n in builtin)
    custom_text  = "\n".join(f"• `{n}`" for n in custom) if custom else "_(none)_"

    await update.message.reply_text(
        f"🔌 *Custom Skills:*\n{custom_text}\n\n"
        f"⚙️ *Built-in Tools:*\n{builtin_text}\n\n"
        "Sub-commands:\n"
        "• `/skill create` — guided skill creation\n"
        "• `/skill install <github-url>` — install from GitHub\n"
        "• `/skill show <name>` — view skill YAML\n"
        "• `/skill delete <name>` — remove a skill\n"
        "• `/skill reload` — reload from disk\n\n"
        "_Tip: paste a GitHub `.yaml` URL directly in chat to auto-install._",
        parse_mode=ParseMode.MARKDOWN,
    )


async def handle_skill_create_step(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> bool:
    """
    Handle one step of the multi-step skill creation flow.
    Returns True if message was consumed by this flow.
    """
    step  = ctx.user_data.get("skill_step")
    draft = ctx.user_data.get("skill_draft", {})
    text  = update.message.text.strip()

    if not step:
        return False

    # ── Step 1: name ──────────────────────────────────────────────────────────
    if step == "name":
        if not re.match(r"^[a-zA-Z0-9_]+$", text):
            await update.message.reply_text(
                "❌ Invalid name. Use only letters, numbers, and underscores.\n\nTry again:"
            )
            return True
        draft["name"] = text
        ctx.user_data["skill_draft"] = draft
        ctx.user_data["skill_step"]  = "type"
        await update.message.reply_text(
            "🛠️ *Create a new skill* — Step 2/5\n\n"
            f"Name: `{text}`\n\n"
            "What *type* of skill?\n"
            "• `command` — runs a shell command on the server\n"
            "• `http` — calls an external HTTP API\n"
            "• `webhook` — sends a POST to a URL",
            parse_mode=ParseMode.MARKDOWN,
        )
        return True

    # ── Step 2: type ──────────────────────────────────────────────────────────
    if step == "type":
        if text.lower() not in ("command", "http", "webhook"):
            await update.message.reply_text("❌ Please reply with: `command`, `http`, or `webhook`", parse_mode=ParseMode.MARKDOWN)
            return True
        draft["type"] = text.lower()
        ctx.user_data["skill_draft"] = draft
        ctx.user_data["skill_step"]  = "cmd_or_url"
        if draft["type"] == "command":
            await update.message.reply_text(
                "🛠️ *Create a new skill* — Step 3/5\n\n"
                "Enter the *shell command* to run.\n"
                "Use `{param_name}` for parameters, e.g.:\n"
                "`df -h {path}`",
                parse_mode=ParseMode.MARKDOWN,
            )
        else:
            await update.message.reply_text(
                "🛠️ *Create a new skill* — Step 3/5\n\n"
                "Enter the *URL* for the API endpoint.\n"
                "Use `{param_name}` for URL path variables, e.g.:\n"
                "`https://api.example.com/check/{domain}`",
                parse_mode=ParseMode.MARKDOWN,
            )
        return True

    # ── Step 3: command or URL ────────────────────────────────────────────────
    if step == "cmd_or_url":
        if draft["type"] == "command":
            draft["command"] = text
        else:
            draft["url"] = text
        ctx.user_data["skill_draft"] = draft
        ctx.user_data["skill_step"]  = "description"
        await update.message.reply_text(
            "🛠️ *Create a new skill* — Step 4/5\n\n"
            "Enter a *description* the AI will use to decide when to call this skill.\n"
            "Be specific! Or type `skip` for a default description.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return True

    # ── Step 4: description ───────────────────────────────────────────────────
    if step == "description":
        if text.lower() != "skip":
            draft["description"] = text
        ctx.user_data["skill_draft"] = draft
        ctx.user_data["skill_step"]  = "params"
        await update.message.reply_text(
            "🛠️ *Create a new skill* — Step 5/5\n\n"
            "Add *parameters*? Enter one per line:\n"
            "`name|description|type|required`\n\n"
            "Example:\n"
            "`query|The search query|string|true`\n"
            "`limit|Max results|integer|false`\n\n"
            "Or type `none` for no parameters.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return True

    # ── Step 5: parameters → preview ─────────────────────────────────────────
    if step == "params":
        params = []
        if text.lower() != "none":
            for line in text.splitlines():
                parts = [p.strip() for p in line.split("|")]
                if len(parts) >= 2:
                    params.append({
                        "name":        parts[0],
                        "description": parts[1] if len(parts) > 1 else "",
                        "type":        parts[2] if len(parts) > 2 else "string",
                        "required":    parts[3].lower() == "true" if len(parts) > 3 else False,
                    })
        draft["parameters"] = params
        ctx.user_data["skill_draft"] = draft
        ctx.user_data["skill_step"]  = "confirm"

        # Build YAML preview
        import yaml as _yaml
        preview = _yaml.dump(draft, default_flow_style=False, allow_unicode=True).strip()
        await update.message.reply_text(
            "🛠️ *Preview your skill:*\n\n"
            f"```\n{preview}\n```\n\n"
            "Type `save` to create it, or `/cancel` to abort.",
            parse_mode=ParseMode.MARKDOWN,
        )
        return True

    # ── Step 6: confirm ────────────────────────────────────────────────────────
    if step == "confirm":
        if text.lower() != "save":
            await update.message.reply_text("Type `save` to confirm, or `/cancel` to abort.", parse_mode=ParseMode.MARKDOWN)
            return True
        import yaml as _yaml
        raw_yaml = _yaml.dump(draft, default_flow_style=False, allow_unicode=True)
        try:
            r = requests.post(f"{AGENT_URL}/skills", json={"yaml": raw_yaml}, timeout=15)
            data = r.json()
            if "error" in data:
                await update.message.reply_text(f"❌ Failed to create skill:\n{data['error']}")
            else:
                name = data.get("name", draft.get("name", "?"))
                _clear_flows(ctx)
                await update.message.reply_text(
                    f"✅ Skill `{name}` created! The agent can now use it immediately.",
                    parse_mode=ParseMode.MARKDOWN,
                )
        except Exception as e:
            await update.message.reply_text(f"❌ Error saving skill: {e}")
        return True

    return False


async def handle_skill_delete_confirm(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> bool:
    """Handle the 'yes' confirmation for /skill delete."""
    pending = ctx.user_data.get("pending_skill_delete")
    if not pending:
        return False

    text = update.message.text.strip().lower()
    if text == "yes":
        try:
            r = requests.delete(f"{AGENT_URL}/skills/{pending}", timeout=10)
            data = r.json()
            ctx.user_data.pop("pending_skill_delete", None)
            if "error" in data:
                await update.message.reply_text(f"❌ {data['error']}")
            else:
                await update.message.reply_text(f"✅ Skill `{pending}` deleted.", parse_mode=ParseMode.MARKDOWN)
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {e}")
    else:
        await update.message.reply_text(
            f"Type `yes` to confirm deletion of `{pending}`, or `/cancel` to abort.",
            parse_mode=ParseMode.MARKDOWN,
        )
    return True


# ─── /mcp command ─────────────────────────────────────────────────────────────

async def cmd_mcp(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """
    /mcp                    — list installed MCPs + tool counts
    /mcp install <name>     — install a whitelisted MCP (guided)
    /mcp remove <name>      — remove an installed MCP
    /mcp tools <name>       — list tools from a specific MCP
    /mcp reload             — reload MCP tools into the agent
    """
    if not is_admin(update):
        return

    args = ctx.args or []
    sub  = args[0].lower() if args else ""

    # ── reload ────────────────────────────────────────────────────────────────
    if sub == "reload":
        try:
            r = requests.post(f"{AGENT_URL}/reload-mcps", timeout=15)
            data = r.json()
            loaded = data.get("loaded", 0)
            tools  = data.get("tools", [])
            tools_text = "\n".join(f"• `{t}`" for t in tools) if tools else "_(none)_"
            await update.message.reply_text(
                f"🔄 MCP tools reloaded — {loaded} tool(s) active:\n\n{tools_text}",
                parse_mode=ParseMode.MARKDOWN,
            )
        except Exception as e:
            await update.message.reply_text(f"❌ Reload failed: {e}")
        return

    # ── tools <name> ──────────────────────────────────────────────────────────
    if sub == "tools":
        if len(args) < 2:
            await update.message.reply_text("Usage: `/mcp tools <name>`", parse_mode=ParseMode.MARKDOWN)
            return
        mcp_name = args[1]
        try:
            r = requests.get(f"{AGENT_URL}/mcps/{mcp_name}/tools", timeout=10)
            if r.status_code == 404:
                await update.message.reply_text(f"❌ MCP `{mcp_name}` not found.", parse_mode=ParseMode.MARKDOWN)
                return
            data = r.json()
            tools = data.get("tools", [])
            if not tools:
                await update.message.reply_text(f"MCP `{mcp_name}` has no tools.", parse_mode=ParseMode.MARKDOWN)
                return
            lines = [f"🔧 *Tools in `{mcp_name}`:*\n"]
            for t in tools:
                lines.append(f"• `{t['name']}` — {t.get('description', '')[:80]}")
            await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {e}")
        return

    # ── remove <name> ─────────────────────────────────────────────────────────
    if sub == "remove":
        if len(args) < 2:
            await update.message.reply_text("Usage: `/mcp remove <name>`", parse_mode=ParseMode.MARKDOWN)
            return
        mcp_name = args[1]
        try:
            r = requests.delete(f"{AGENT_URL}/mcps/{mcp_name}", timeout=15)
            data = r.json()
            if "error" in data:
                await update.message.reply_text(f"❌ {data['error']}")
            else:
                await update.message.reply_text(
                    f"✅ MCP `{mcp_name}` removed. Use `/mcp reload` to update the agent's tool list.",
                    parse_mode=ParseMode.MARKDOWN,
                )
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {e}")
        return

    # ── available — show full catalog grouped by category ─────────────────────
    if sub == "available":
        cats: dict[str, list] = {}
        for slug, info in _MCP_CATALOG.items():
            cat = info["category"]
            cats.setdefault(cat, []).append((slug, info))
        lines = ["📦 *Available MCPs* — install with `/mcp install <name>`\n"]
        for cat, entries in cats.items():
            lines.append(f"*{cat}:*")
            for slug, info in entries:
                env_req = [e["name"] for e in info["env"] if e.get("required")]
                env_hint = f" _(needs: {', '.join(env_req)})_" if env_req else " _(no auth)_"
                lines.append(f"  • `{slug}` — {info['description']}{env_hint}")
        lines.append("\nUse `/mcp info <name>` to see setup details.")
        # Split if too long
        full = "\n".join(lines)
        for i in range(0, len(full), 4000):
            await update.message.reply_text(full[i:i+4000], parse_mode=ParseMode.MARKDOWN)
        return

    # ── info <name> — show env vars and hints for one MCP ─────────────────────
    if sub == "info":
        if len(args) < 2:
            await update.message.reply_text("Usage: `/mcp info <name>`", parse_mode=ParseMode.MARKDOWN)
            return
        slug = args[1].lower()
        info = _MCP_CATALOG.get(slug)
        if not info:
            await update.message.reply_text(f"❌ `{slug}` not in catalog. Use `/mcp available` to browse.", parse_mode=ParseMode.MARKDOWN)
            return
        lines = [f"📦 *{slug}*", f"`{info['package']}`", f"_{info['description']}_\n"]
        if info["env"]:
            lines.append("*Required environment variables:*")
            for e in info["env"]:
                req = "required" if e.get("required") else "optional"
                lines.append(f"• `{e['name']}` _({req})_")
                lines.append(f"  {e['hint']}")
        else:
            lines.append("✅ No API keys required.")
        lines.append(f"\nInstall: `/mcp install {slug}`")
        await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)
        return

    # ── install <name> ────────────────────────────────────────────────────────
    if sub == "install":
        if len(args) < 2:
            await update.message.reply_text(
                "Usage: `/mcp install <name>`\n\nBrowse available MCPs with `/mcp available`",
                parse_mode=ParseMode.MARKDOWN,
            )
            return
        short_name = args[1].lower()
        if short_name not in _MCP_CATALOG:
            await update.message.reply_text(
                f"❌ `{short_name}` is not in the catalog.\n\nUse `/mcp available` to see all options.",
                parse_mode=ParseMode.MARKDOWN,
            )
            return
        info = _MCP_CATALOG[short_name]
        _clear_flows(ctx)
        ctx.user_data["mcp_draft"] = {
            "short_name": short_name,
            "package":    info["package"],
            "env":        {},
            "env_defs":   info["env"],   # env var definitions from catalog
        }

        required_vars = [e for e in info["env"] if e.get("required")]
        if required_vars:
            # Show exactly what's needed before asking
            lines = [
                f"📦 *{short_name}* — {info['description']}\n",
                "*This MCP needs the following environment variables:*\n",
            ]
            for e in info["env"]:
                req = "required" if e.get("required") else "optional"
                lines.append(f"• `{e['name']}` _({req})_")
                lines.append(f"  _{e['hint']}_\n")
            lines.append("Do you have these credentials? Reply `yes` to enter them, `no` to cancel, or `skip` to install without them (it may not work).")
            ctx.user_data["mcp_step"] = "env_choice"
            await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)
        else:
            # No env vars needed — go straight to install
            ctx.user_data["mcp_step"] = "installing"
            await _do_mcp_install(update, ctx)
        return

    # ── list (default) — installed MCPs ───────────────────────────────────────
    try:
        r = requests.get(f"{AGENT_URL}/mcps", timeout=10)
        data = r.json()
        mcps = data.get("mcps", [])
    except Exception as e:
        await update.message.reply_text(f"❌ Error fetching MCPs: {e}")
        return

    if not mcps:
        await update.message.reply_text(
            "🔧 *No MCPs installed.*\n\n"
            "• `/mcp available` — browse all available MCPs\n"
            "• `/mcp install <name>` — install one\n"
            "• `/mcp info <name>` — see env vars and setup details",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    lines = ["🔧 *Installed MCPs:*\n"]
    for mcp in mcps:
        tool_count = len(mcp.get("tools", []))
        lines.append(f"• `{mcp['name']}` — {tool_count} tool(s)")
    lines.append("\n*Commands:*")
    lines.append("• `/mcp available` — browse catalog")
    lines.append("• `/mcp info <name>` — setup details + env vars")
    lines.append("• `/mcp install <name>` — install")
    lines.append("• `/mcp tools <name>` — list tools")
    lines.append("• `/mcp remove <name>` — uninstall")
    lines.append("• `/mcp reload` — sync tools to agent")
    await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)


async def handle_mcp_install_step(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> bool:
    """Handle one step of the MCP install flow. Returns True if consumed."""
    step  = ctx.user_data.get("mcp_step")
    draft = ctx.user_data.get("mcp_draft", {})
    text  = update.message.text.strip()

    if not step:
        return False

    # ── env choice ────────────────────────────────────────────────────────────
    if step == "env_choice":
        choice = text.lower()
        if choice == "yes":
            ctx.user_data["mcp_step"] = "env_vars"
            env_defs = draft.get("env_defs", [])
            lines = ["Enter environment variables, one per line as `KEY=VALUE`\n"]
            for e in env_defs:
                req = "required" if e.get("required") else "optional"
                lines.append(f"• `{e['name']}` _({req})_ — {e['hint']}")
            lines.append("\nType `done` when finished.")
            await update.message.reply_text("\n".join(lines), parse_mode=ParseMode.MARKDOWN)
        elif choice in ("no", "skip"):
            ctx.user_data["mcp_step"] = "installing"
            await _do_mcp_install(update, ctx)
        else:
            await update.message.reply_text("Please reply `yes`, `no`, or `skip`.", parse_mode=ParseMode.MARKDOWN)
        return True

    # ── env vars collection ────────────────────────────────────────────────────
    if step == "env_vars":
        if text.lower() == "done":
            # Warn if required vars are missing
            env      = draft.get("env", {})
            env_defs = draft.get("env_defs", [])
            missing  = [e["name"] for e in env_defs if e.get("required") and e["name"] not in env]
            if missing:
                await update.message.reply_text(
                    f"⚠️ Still missing required variables: {', '.join(f'`{m}`' for m in missing)}\n"
                    "Add them or type `done` again to install anyway.",
                    parse_mode=ParseMode.MARKDOWN,
                )
                draft["_missing_warned"] = True
                ctx.user_data["mcp_draft"] = draft
            else:
                ctx.user_data["mcp_step"] = "installing"
                await _do_mcp_install(update, ctx)
        else:
            env = draft.get("env", {})
            for line in text.splitlines():
                if "=" in line:
                    k, _, v = line.partition("=")
                    env[k.strip()] = v.strip()
            draft["env"] = env
            ctx.user_data["mcp_draft"] = draft
            # If warned about missing and user sends more vars, clear warning
            draft.pop("_missing_warned", None)
            env_defs = draft.get("env_defs", [])
            missing  = [e["name"] for e in env_defs if e.get("required") and e["name"] not in env]
            saved_names = ", ".join(f"`{k}`" for k in env)
            if missing:
                await update.message.reply_text(
                    f"✅ Saved: {saved_names}\nStill needed: {', '.join(f'`{m}`' for m in missing)}\nType `done` when finished.",
                    parse_mode=ParseMode.MARKDOWN,
                )
            else:
                await update.message.reply_text(
                    f"✅ All variables set: {saved_names}\nType `done` to install.",
                    parse_mode=ParseMode.MARKDOWN,
                )
        return True

    return False


async def _do_mcp_install(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Call the agent's MCP install endpoint and report results."""
    draft = ctx.user_data.get("mcp_draft", {})
    package    = draft.get("package", "")
    short_name = draft.get("short_name", "")
    env        = draft.get("env", {})

    status_msg = await update.message.reply_text(f"⏳ Installing `{package}`… this may take a minute.", parse_mode=ParseMode.MARKDOWN)
    try:
        r = requests.post(
            f"{AGENT_URL}/mcps/install",
            json={"package": package, "name": short_name, "env": env},
            timeout=120,
        )
        data = r.json()
        _clear_flows(ctx)
        if "error" in data:
            await status_msg.edit_text(f"❌ Install failed:\n{data['error']}")
            return
        tools = data.get("tools", [])
        tools_text = "\n".join(f"• `{t['name']}` — {t.get('description','')[:60]}" for t in tools) if tools else "_(none discovered)_"
        await status_msg.edit_text(
            f"✅ `{package}` installed!\n\n"
            f"Tools discovered:\n{tools_text}\n\n"
            "Use `/mcp reload` to make them available to the agent.",
            parse_mode=ParseMode.MARKDOWN,
        )
    except Exception as e:
        _clear_flows(ctx)
        await status_msg.edit_text(f"❌ Install error: {e}")


# ─── Agent streaming helper ───────────────────────────────────────────────────

async def _run_agent_task(update: Update, ctx: ContextTypes.DEFAULT_TYPE, task_text: str):
    """Stream task_text to the agent and send the result back to the user."""
    manual_model = ctx.user_data.get("model")
    history      = ctx.user_data.get("history", [])

    if manual_model:
        model      = manual_model
        model_hint = f"`{model}`"
    elif AUTO_ROUTING:
        model, tier = _auto_select_model(task_text)
        tier_badge  = {"fast": " · ⚡ fast", "smart": " · 🧠 smart", "standard": ""}.get(tier, "")
        model_hint  = f"`{model}`{tier_badge}"
    else:
        model      = DEFAULT_MODEL
        model_hint = f"`{model}`"

    status_msg = await update.message.reply_text(f"🤔 Thinking… ({model_hint})", parse_mode=ParseMode.MARKDOWN)

    # Cancellation event — /stop or /cancel sets this to abort the request
    stop_event = threading.Event()
    ctx.user_data["stop_event"] = stop_event

    loop: asyncio.AbstractEventLoop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def stream_from_agent():
        try:
            with requests.post(
                f"{AGENT_URL}/task",
                json={"message": task_text, "model": model, "history": history},
                stream=True,
                timeout=310,
            ) as r:
                r.raise_for_status()
                for raw in r.iter_lines(decode_unicode=True):
                    if stop_event.is_set():
                        break
                    if raw:
                        try:
                            asyncio.run_coroutine_threadsafe(queue.put(json.loads(raw)), loop)
                        except Exception:
                            pass
        except requests.exceptions.Timeout:
            if not stop_event.is_set():
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "result", "text": "⏱️ Timed out after 5 minutes.", "elapsed": 300, "model": model}), loop
                )
        except requests.exceptions.ConnectionError:
            if not stop_event.is_set():
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "result", "text": "❌ Agent is unreachable.", "elapsed": 0, "model": model}), loop
                )
        except Exception as e:
            if not stop_event.is_set():
                asyncio.run_coroutine_threadsafe(
                    queue.put({"type": "result", "text": f"❌ Error: {e}", "elapsed": 0, "model": model}), loop
                )
        finally:
            asyncio.run_coroutine_threadsafe(queue.put(None), loop)

    loop.run_in_executor(None, stream_from_agent)

    result     = "(no result)"
    elapsed    = 0
    model_used = model
    steps: list[str] = []
    stopped    = False

    def build_status() -> str:
        lines = ["🤔 Thinking…"]
        if steps:
            lines.append("")
            for i, s in enumerate(steps, 1):
                lines.append(f"{i}. {s}")
        return "\n".join(lines)

    while True:
        event = await queue.get()
        if event is None:
            break
        if stop_event.is_set():
            stopped = True
            break
        etype = event.get("type")
        if etype == "progress":
            steps.append(event.get("text", "⚙️ Working…"))
            try:
                await status_msg.edit_text(build_status())
            except Exception:
                pass
        elif etype == "thinking":
            try:
                await status_msg.edit_text(build_status())
            except Exception:
                pass
        elif etype == "result":
            result     = event.get("text", "(no result)")
            elapsed    = event.get("elapsed", 0)
            model_used = event.get("model", model)

    # Clean up stop event
    ctx.user_data.pop("stop_event", None)

    if stopped:
        try:
            await status_msg.edit_text("🛑 Stopped.")
        except Exception:
            pass
        return

    history = ctx.user_data.get("history", [])
    history.append({"role": "user",      "content": task_text})
    history.append({"role": "assistant", "content": result})
    ctx.user_data["history"] = history[-10:]

    try:
        await status_msg.delete()
    except Exception:
        pass

    MAX_LEN = 4000
    chunks = [result[i:i + MAX_LEN] for i in range(0, max(len(result), 1), MAX_LEN)]
    footer = f"\n\n_⏱ {elapsed}s • {model_used}_"
    for i, chunk in enumerate(chunks):
        text = chunk + (footer if i == len(chunks) - 1 else "")
        try:
            await update.message.reply_text(text, parse_mode=ParseMode.MARKDOWN)
        except Exception:
            try:
                await update.message.reply_text(text)
            except Exception as e2:
                logger.error(f"Failed to send chunk: {e2}")


# ─── Media flow helpers ───────────────────────────────────────────────────────

async def _process_pending_media(
    update: Update,
    ctx: ContextTypes.DEFAULT_TYPE,
    task_description: str,
) -> None:
    """Upload the pending photo to the agent, then execute the user's task."""
    media = ctx.user_data.pop("pending_media", None)
    ctx.user_data.pop("media_step", None)
    if not media:
        return

    status_msg = await update.message.reply_text("📤 Uploading image…")
    try:
        r = requests.post(
            f"{AGENT_URL}/upload",
            files={"file": (media["filename"], media["bytes"], media["content_type"])},
            timeout=60,
        )
        data = r.json()
    except Exception as e:
        await status_msg.edit_text(f"❌ Upload failed: {e}")
        return

    if "error" in data:
        await status_msg.edit_text(f"❌ {data['error']}")
        return

    media_url = data.get("url", "")
    media_id  = data.get("id", "")
    await status_msg.delete()

    # Pure "just save it" requests — confirm and stop
    task_lower = task_description.lower().strip()
    if task_lower in {
        "upload", "save", "store", "media library",
        "upload to wordpress", "save to wordpress",
        "upload to wordpress media library", "save to library",
    }:
        await update.message.reply_text(
            f"✅ Uploaded to WordPress media library!\n"
            f"🆔 ID: `{media_id}`\n"
            f"🔗 {media_url}",
            parse_mode=ParseMode.MARKDOWN,
        )
        return

    # Pass to the agent with full media context
    await update.message.chat.send_action(ChatAction.TYPING)
    task_text = (
        f"The user shared an image that was uploaded to WordPress "
        f"(Media ID: {media_id}, URL: {media_url}). "
        f"Task: {task_description}"
    )
    await _run_agent_task(update, ctx, task_text)


async def handle_pending_media(update: Update, ctx: ContextTypes.DEFAULT_TYPE) -> bool:
    """
    If the user is in the media-waiting state (sent a photo and we asked what to do),
    consume their text reply and process the pending media.  Returns True if handled.
    """
    if ctx.user_data.get("media_step") != "waiting":
        return False
    task_description = (update.message.text or "").strip()
    if not task_description:
        return False
    await _process_pending_media(update, ctx, task_description)
    return True


# ─── Message handler ──────────────────────────────────────────────────────────

async def handle_message(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return

    # Route to active multi-step flows before hitting the agent
    if await handle_skill_delete_confirm(update, ctx):
        return
    if await handle_skill_create_step(update, ctx):
        return
    if await handle_mcp_install_step(update, ctx):
        return
    if await handle_skill_browse_step(update, ctx):
        return
    if await handle_pending_media(update, ctx):
        return

    user_text = (update.message.text or "").strip()
    if not user_text:
        return

    # Auto-detect GitHub URLs and handle them without hitting the agent
    if _is_github_yaml_url(user_text):
        await _install_skill_from_url(update, user_text)
        return
    if _is_github_repo_url(user_text):
        repo_info = _parse_github_repo_url(user_text)
        await _browse_github_skills(update, ctx, repo_info)
        return

    await update.message.chat.send_action(ChatAction.TYPING)
    await _run_agent_task(update, ctx, user_text)


# ─── Voice message handler ────────────────────────────────────────────────────

async def handle_voice(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """
    Download a Telegram voice note (OGG Opus), send it to the agent's /transcribe
    endpoint (OpenAI Whisper), then run the transcript as a normal agent task.
    """
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return

    voice = update.message.voice
    status_msg = await update.message.reply_text("🎙️ Transcribing voice message…")

    try:
        tg_file     = await voice.get_file()
        audio_bytes = bytes(await tg_file.download_as_bytearray())
    except Exception as e:
        await status_msg.edit_text(f"❌ Failed to download voice message: {e}")
        return

    try:
        r = requests.post(
            f"{AGENT_URL}/transcribe",
            files={"file": ("voice.ogg", audio_bytes, "audio/ogg")},
            timeout=60,
        )
        data = r.json()
    except Exception as e:
        await status_msg.edit_text(f"❌ Transcription request failed: {e}")
        return

    if "error" in data:
        await status_msg.edit_text(f"❌ {data['error']}")
        return

    transcript = (data.get("text") or "").strip()
    if not transcript:
        await status_msg.edit_text("❌ Could not transcribe audio (empty result).")
        return

    await status_msg.edit_text(
        f"🎙️ *Heard:* _{transcript}_",
        parse_mode=ParseMode.MARKDOWN,
    )
    await update.message.chat.send_action(ChatAction.TYPING)
    await _run_agent_task(update, ctx, transcript)


# ─── Photo handler ────────────────────────────────────────────────────────────

async def handle_photo(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    """
    Receive a photo.  Downloads it and holds it in user_data, then asks the
    user what to do — rather than blindly uploading to WordPress.
    If the photo has a caption, the caption is used as the task immediately.
    """
    if not is_admin(update):
        await update.message.reply_text("⛔ Unauthorized.")
        return

    photo   = update.message.photo[-1]
    caption = (update.message.caption or "").strip()

    status_msg = await update.message.reply_text("📥 Receiving image…")
    try:
        tg_file     = await photo.get_file()
        photo_bytes = bytes(await tg_file.download_as_bytearray())
    except Exception as e:
        await status_msg.edit_text(f"❌ Failed to download image: {e}")
        return
    await status_msg.delete()

    # Hold the image in user_data until the user tells us what to do with it
    ctx.user_data["pending_media"] = {
        "bytes":        photo_bytes,
        "filename":     f"telegram_{photo.file_id}.jpg",
        "content_type": "image/jpeg",
    }
    ctx.user_data["media_step"] = "waiting"

    if caption:
        # Caption = instant instructions — process right away
        await _process_pending_media(update, ctx, caption)
        return

    await update.message.reply_text(
        "📸 Got your image! What would you like to do with it?\n\n"
        "• _Upload to WordPress media library_\n"
        "• _Set as featured image for a new post_\n"
        "• _Use in a blog post about..._\n"
        "• _Analyse and describe it_\n"
        "• _Any other task_\n\n"
        "Just describe what you want, or type `/cancel` to discard.",
        parse_mode=ParseMode.MARKDOWN,
    )


# ─── Main ─────────────────────────────────────────────────────────────────────

async def post_init(app: Application) -> None:
    await app.bot.set_my_commands([
        BotCommand("start",  "Welcome message & feature list"),
        BotCommand("status", "Check agent health"),
        BotCommand("model",  "Show or switch AI model"),
        BotCommand("stop",   "Abort current AI request"),
        BotCommand("cancel", "Clear history / cancel active flow"),
        BotCommand("tasks",  "List or cancel scheduled tasks"),
        BotCommand("skill",  "List, create, install (GitHub), delete custom skills"),
        BotCommand("mcp",    "Install, list, remove MCP tool servers"),
    ])
    logger.info("Bot commands registered with Telegram.")


def main():
    logger.info(f"Starting bot (admin users: {ADMIN_USER_IDS})")

    app = (
        Application.builder()
        .token(TELEGRAM_BOT_TOKEN)
        .post_init(post_init)
        .build()
    )

    app.add_handler(CommandHandler("start",  cmd_start))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("model",  cmd_model))
    app.add_handler(CommandHandler("stop",   cmd_stop))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CommandHandler("tasks",  cmd_tasks))
    app.add_handler(CommandHandler("skill",  cmd_skill))
    app.add_handler(CommandHandler("skills", cmd_skill))   # common alias
    app.add_handler(CommandHandler("mcp",    cmd_mcp))

    app.add_handler(MessageHandler(filters.TEXT  & ~filters.COMMAND, handle_message))
    app.add_handler(MessageHandler(filters.VOICE & ~filters.COMMAND, handle_voice))
    app.add_handler(MessageHandler(filters.PHOTO & ~filters.COMMAND, handle_photo))

    logger.info("Bot is polling…")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
