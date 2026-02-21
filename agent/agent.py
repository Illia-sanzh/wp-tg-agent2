"""
WordPress AI Agent
──────────────────
Receives a task message, runs an agentic loop using the LLM (via LiteLLM),
executes WP-CLI commands or REST API calls, and returns the result.

KEY DESIGN DECISION — Avoids the 401 Anthropic error:
  We use the OpenAI-compatible SDK pointing to LiteLLM, NOT the Anthropic SDK.
  LiteLLM handles the real API key and speaks to Anthropic/OpenAI/etc internally.
  The agent never touches the real API key at all.

NEW FEATURES:
  • /transcribe     — Whisper voice transcription (requires OPENAI_API_KEY)
  • /schedules      — List / cancel scheduled tasks (GET, DELETE /<id>)
  • /skills         — List built-in + custom skill tools
  • /reload-skills  — Hot-reload YAML skills without restart
  • schedule_task   — LLM tool to schedule future/recurring WordPress tasks
  • Custom skills   — Drop YAML files in openclaw-config/skills/ to add tools
"""

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx
import requests
import yaml
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger
from apscheduler.triggers.date import DateTrigger
from flask import Flask, Response, jsonify, request, stream_with_context
from openai import OpenAI

# ─── Configuration ────────────────────────────────────────────────────────────

LITELLM_BASE_URL   = os.environ.get("LITELLM_BASE_URL", "http://openclaw-litellm:4000/v1")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-1234")
DEFAULT_MODEL      = os.environ.get("DEFAULT_MODEL", "claude-sonnet-4-6")
FALLBACK_MODEL     = os.environ.get("FALLBACK_MODEL", "deepseek-chat")

# Needed for Whisper transcription (calls OpenAI directly via Squid proxy)
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
HTTPS_PROXY    = os.environ.get("HTTPS_PROXY", "")

WP_PATH           = os.environ.get("WP_PATH", "/wordpress")
WP_URL            = os.environ.get("WP_URL", "")
WP_ADMIN_USER     = os.environ.get("WP_ADMIN_USER", "admin")
WP_APP_PASSWORD   = os.environ.get("WP_APP_PASSWORD", "")
WP_ADMIN_PASSWORD = os.environ.get("WP_ADMIN_PASSWORD", "")
BRIDGE_SECRET     = os.environ.get("BRIDGE_SECRET", "")
SKILL_FILE        = os.environ.get("SKILL_FILE", "/app/SKILL.md")

# Telegram credentials — used by the scheduler to push results back to the user.
# These come from .env (env_file: .env in docker-compose), same values the bot uses.
TELEGRAM_BOT_TOKEN     = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_ADMIN_USER_ID = os.environ.get("TELEGRAM_ADMIN_USER_ID", "")

# Custom skills dir (host: ./openclaw-config/skills/  →  container: /app/config/skills/)
SKILLS_DIR = Path("/app/config/skills")

# Writable data dir for scheduler's SQLite job store (Docker named volume: agent-data)
DATA_DIR    = Path("/app/data")
SCHEDULE_DB = DATA_DIR / "schedules.db"

# Max tool calls per task (prevents infinite loops)
MAX_STEPS = 25
# Max chars of command output fed back to the LLM
MAX_OUTPUT_CHARS = 8000

app = Flask(__name__)

# ─── Ensure writable data dir exists ─────────────────────────────────────────
try:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
except Exception as _dir_err:
    sys.stderr.write(f"[WARN] Cannot create data dir {DATA_DIR}: {_dir_err}\n")

# ─── LiteLLM client (OpenAI-compatible) ──────────────────────────────────────
# This is the fix for the 401 issue: we never call Anthropic directly.
#
# Explicit http_client bypasses the openai SDK's env-var proxy injection.
# Without this, the SDK reads HTTP_PROXY/HTTPS_PROXY and calls
# httpx.Client(proxies=...), which was removed in httpx 0.28+ causing a
# TypeError on startup. Providing our own client avoids that code path entirely.
client = OpenAI(
    api_key=LITELLM_MASTER_KEY,
    base_url=LITELLM_BASE_URL,
    timeout=120.0,
    http_client=httpx.Client(timeout=httpx.Timeout(120.0)),
)

# ─── Whisper client (OpenAI direct, via Squid proxy) ─────────────────────────
# Separate from the LiteLLM client — audio transcription goes to OpenAI's
# Whisper API directly (LiteLLM audio proxy is not reliable for binary uploads).
# Traffic path: agent container → Squid → api.openai.com (on allowlist).
_whisper_client = None
if OPENAI_API_KEY:
    # httpx 0.27.x: proxies= still supported (removed in 0.28+, which we pin against)
    _whisper_http = httpx.Client(
        timeout=httpx.Timeout(90.0),
        proxies={"https://": HTTPS_PROXY} if HTTPS_PROXY else None,
    )
    _whisper_client = OpenAI(
        api_key=OPENAI_API_KEY,
        http_client=_whisper_http,
    )

# ─── APScheduler (persistent SQLite job store) ───────────────────────────────
# NOTE: gunicorn is launched with --workers 1.  Multiple worker processes would
# each start their own BackgroundScheduler and double-fire every job.
# If you ever scale workers, run the scheduler as a separate container instead.
try:
    _jobstores = {"default": SQLAlchemyJobStore(url=f"sqlite:///{SCHEDULE_DB}")}
    scheduler = BackgroundScheduler(jobstores=_jobstores, timezone=timezone.utc)
except Exception as _sched_err:
    sys.stderr.write(f"[WARN] SQLite job store failed ({_sched_err}). Scheduled jobs won't survive restarts.\n")
    scheduler = BackgroundScheduler(timezone=timezone.utc)

# ─── Load skill / system prompt ───────────────────────────────────────────────

def load_system_prompt() -> str:
    skill = ""
    if Path(SKILL_FILE).exists():
        skill = Path(SKILL_FILE).read_text()

    wp_mode = "local" if Path(WP_PATH).exists() and os.listdir(WP_PATH) else "remote"

    return f"""You are a WordPress management AI agent.

{skill}

## Current Configuration
- WordPress mode: {wp_mode}
- WordPress path (local): {WP_PATH}
- WordPress URL: {WP_URL}
- WP admin user: {WP_ADMIN_USER}

## Execution Rules
1. Think step-by-step before taking any action.
2. Use the `run_command` tool to run WP-CLI or bash commands.
3. Use the `wp_rest` tool to call the WordPress REST API.
4. Use the `wp_cli_remote` tool to run WP-CLI via the bridge plugin (remote mode).
5. After each command, check the output before proceeding.
6. When done, give a concise human-readable summary of what was accomplished.
7. If something fails, explain why and what the user should do.
8. Always set the `reason` field on every tool call with a short plain-English description of what you are doing (e.g. "Installing Elementor plugin", "Fetching list of published posts").
9. NEVER run: wp db drop, wp db reset, wp site empty, wp eval, wp shell.
10. ALWAYS use --allow-root when running wp commands.
11. For destructive operations, always ask for confirmation first (respond without running).
12. If WP-CLI fails with a database error, switch to wp_rest immediately — do NOT investigate MySQL, read wp-config.php, run mysql commands, or check service status.
13. NEVER run: nmap, nc, netstat, ss, mysqladmin, mysqld, service mysql, systemctl mysql, mysql -u, mysqld_safe, ps aux | grep mysql.

## WordPress Mode: {wp_mode.upper()}
{"You have direct WP-CLI access. Use: wp --path=" + WP_PATH + " --allow-root" if wp_mode == "local" else "WordPress is remote. Use wp_rest or wp_cli_remote tools."}

## Scheduling Tasks
Use the `schedule_task` tool when the user asks to do something at a specific time or on a recurring basis.
- For one-time tasks: set `run_at` to an ISO 8601 UTC datetime (e.g. "2024-01-15T17:00:00")
- For recurring tasks: set `cron` to a 5-part expression: minute hour day month weekday
  Examples: "0 17 * * *" = every day at 5 pm UTC | "0 3 * * 1" = every Monday at 3 am UTC
- When the user gives a local time, ask for their UTC offset (e.g. +05:30) before scheduling.
- Always tell the user the job ID returned so they can cancel it later with /tasks cancel <ID>.

## Custom Skills
Additional tool functions may be available below if YAML skill files are present in
openclaw-config/skills/. Use any loaded skill the same way as built-in tools.
"""

SYSTEM_PROMPT = load_system_prompt()

# ─── Built-in tools definition ────────────────────────────────────────────────

TOOLS: list[dict] = [
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": (
                "Run a bash command on the agent server. "
                "Use this for WP-CLI commands (wp --path=/wordpress --allow-root ...), "
                "file operations, and server-side tasks. "
                "Output is limited to 8000 characters."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "One short sentence describing what this step does in plain English, shown to the user.",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "wp_rest",
            "description": (
                "Call the WordPress REST API. "
                "Use for reading/writing posts, pages, media, users, settings, plugins, etc. "
                "Works for both local and remote WordPress installations."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "method": {
                        "type": "string",
                        "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"],
                        "description": "HTTP method.",
                    },
                    "endpoint": {
                        "type": "string",
                        "description": "REST API endpoint path, e.g. /wp/v2/posts or /wc/v3/products",
                    },
                    "body": {
                        "type": "object",
                        "description": "Request body as JSON object (for POST/PUT/PATCH).",
                    },
                    "params": {
                        "type": "object",
                        "description": "Query string parameters as key-value pairs.",
                    },
                    "reason": {
                        "type": "string",
                        "description": "One short sentence describing what this step does in plain English, shown to the user.",
                    },
                },
                "required": ["method", "endpoint"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "wp_cli_remote",
            "description": (
                "Run a WP-CLI command on a remote WordPress site via the OpenClaw bridge plugin. "
                "Use when WordPress is hosted on a different server. "
                "Provide the WP-CLI command WITHOUT the 'wp' prefix."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "WP-CLI command without the 'wp' prefix. E.g.: 'plugin list --format=json'",
                    },
                    "reason": {
                        "type": "string",
                        "description": "One short sentence describing what this step does in plain English, shown to the user.",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "schedule_task",
            "description": (
                "Schedule a WordPress management task to run at a specific future time or on a "
                "recurring schedule. Use this when the user says things like 'at 5pm', "
                "'every Monday', 'publish tomorrow', 'weekly backup', etc. "
                "The task runs through the full AI agent and the result is sent back via Telegram."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "Full plain-English description of what to do (e.g. 'Update all plugins to latest versions', 'Publish draft post ID 42').",
                    },
                    "run_at": {
                        "type": "string",
                        "description": "ISO 8601 UTC datetime for a one-time task (e.g. '2024-06-01T17:00:00'). Omit if using cron.",
                    },
                    "cron": {
                        "type": "string",
                        "description": "5-part cron for recurring tasks: 'minute hour day month weekday'. E.g. '0 3 * * 1' = Mondays at 3am UTC. Omit if using run_at.",
                    },
                    "label": {
                        "type": "string",
                        "description": "Short human-readable name shown in /tasks list (e.g. 'Weekly plugin update').",
                    },
                    "reason": {
                        "type": "string",
                        "description": "One short sentence describing what this step does in plain English, shown to the user.",
                    },
                },
                "required": ["task"],
            },
        },
    },
]

# ─── Custom skills loader ─────────────────────────────────────────────────────

def load_custom_skills() -> list[dict]:
    """
    Read YAML skill definitions from openclaw-config/skills/*.yaml and convert
    each to an OpenAI-compatible tool definition.

    Skill YAML format (see openclaw-config/skills/README.md for full docs):
        name: tool_name           # alphanumeric + underscores, no spaces
        label: "Display Name"
        description: "When and how to use this tool (seen by the LLM)"
        type: command | http | webhook
        command: "shell cmd {param}"          # type: command
        url: "https://api.example.com/{param}"  # type: http / webhook
        method: GET                           # type: http (default GET)
        disabled: true                        # set to skip loading
        parameters:
          - name: param_name
            description: "What this is"
            type: string | integer | boolean
            required: true
    """
    if not SKILLS_DIR.exists():
        return []

    tools = []
    for skill_file in sorted(SKILLS_DIR.glob("*.yaml")):
        try:
            skill = yaml.safe_load(skill_file.read_text())
            if not skill or not isinstance(skill, dict):
                continue
            if skill.get("disabled"):
                continue

            name = skill.get("name", "").strip()
            if not name or not re.match(r"^[a-zA-Z0-9_]+$", name):
                app.logger.warning(f"Skill {skill_file.name}: invalid/missing name, skipping.")
                continue

            props: dict = {}
            required: list = []
            for p in skill.get("parameters", []):
                p_name = p.get("name", "").strip()
                if not p_name:
                    continue
                props[p_name] = {
                    "type": p.get("type", "string"),
                    "description": p.get("description", ""),
                }
                if p.get("required", False):
                    required.append(p_name)

            tools.append({
                "type": "function",
                "function": {
                    "name": f"skill_{name}",
                    "description": skill.get("description", f"Custom skill: {name}"),
                    "parameters": {
                        "type": "object",
                        "properties": props,
                        "required": required,
                    },
                },
            })
            app.logger.info(f"Loaded custom skill: skill_{name} ({skill_file.name})")
        except Exception as e:
            app.logger.warning(f"Failed to load skill {skill_file.name}: {e}")

    return tools


# Cached list of custom skill tool defs — refreshed by POST /reload-skills
_cached_custom_tools: list[dict] = []


def _get_all_tools() -> list[dict]:
    """Return built-in tools + any currently loaded custom skills."""
    return TOOLS + _cached_custom_tools


# ─── Tool implementations ─────────────────────────────────────────────────────

def run_command(command: str) -> str:
    """Execute a bash command safely."""
    forbidden = [
        "wp db drop", "wp db reset", "wp site empty",
        "wp eval", "wp eval-file", "wp shell",
        "rm -rf /", "mkfs", "dd if=",
        "> /dev/sda", "chmod 777 /",
    ]
    cmd_lower = command.lower()
    for f in forbidden:
        if f in cmd_lower:
            return f"ERROR: Command '{f}' is blocked for safety reasons."

    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "HOME": "/root"},
        )
        output = result.stdout + result.stderr
        if len(output) > MAX_OUTPUT_CHARS:
            output = output[:MAX_OUTPUT_CHARS] + f"\n... [truncated, {len(output)} total chars]"
        return output if output.strip() else "(command completed with no output)"
    except subprocess.TimeoutExpired:
        return "ERROR: Command timed out after 120 seconds."
    except Exception as e:
        return f"ERROR: {e}"


def wp_rest(method: str, endpoint: str, body: dict = None, params: dict = None) -> str:
    """Call the WordPress REST API."""
    if not WP_URL:
        return "ERROR: WP_URL not configured. Set it in .env"

    auth = None
    headers = {"Content-Type": "application/json"}
    if WP_APP_PASSWORD:
        import base64
        creds = base64.b64encode(f"{WP_ADMIN_USER}:{WP_APP_PASSWORD}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
    elif WP_ADMIN_PASSWORD:
        auth = (WP_ADMIN_USER, WP_ADMIN_PASSWORD)

    url = WP_URL.rstrip("/") + "/wp-json" + endpoint
    try:
        resp = requests.request(
            method=method,
            url=url,
            json=body,
            params=params,
            headers=headers,
            auth=auth,
            timeout=30,
        )
        text = resp.text
        if len(text) > MAX_OUTPUT_CHARS:
            text = text[:MAX_OUTPUT_CHARS] + "... [truncated]"
        return f"HTTP {resp.status_code}\n{text}"
    except Exception as e:
        return f"ERROR: {e}"


def wp_cli_remote(command: str) -> str:
    """Run WP-CLI via the bridge plugin on a remote WordPress site."""
    if not WP_URL or not BRIDGE_SECRET:
        return "ERROR: WP_URL or BRIDGE_SECRET not configured."

    url = WP_URL.rstrip("/") + "/wp-json/openclaw/v1/cli"
    try:
        resp = requests.post(
            url,
            json={"command": command},
            headers={
                "X-OpenClaw-Secret": BRIDGE_SECRET,
                "Content-Type": "application/json",
            },
            timeout=60,
        )
        data = resp.json()
        return data.get("output", str(data))
    except Exception as e:
        return f"ERROR: {e}"


def schedule_task_fn(
    task: str,
    run_at: str = None,
    cron: str = None,
    label: str = None,
) -> str:
    """Register a future or recurring task with APScheduler."""
    if not run_at and not cron:
        return "ERROR: Provide either run_at (ISO datetime) or cron (5-part expression)."

    label = (label or task[:60]).strip()
    job_id = f"oc_{int(time.time())}_{abs(hash(task)) % 9999:04d}"

    try:
        if cron:
            parts = cron.strip().split()
            if len(parts) != 5:
                return (
                    f"ERROR: cron must have exactly 5 fields (minute hour day month weekday). "
                    f"Got {len(parts)}: '{cron}'"
                )
            minute, hour, day, month, dow = parts
            trigger = CronTrigger(
                minute=minute, hour=hour, day=day, month=month, day_of_week=dow,
                timezone=timezone.utc,
            )
        else:
            dt = datetime.fromisoformat(run_at)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            trigger = DateTrigger(run_date=dt)

        scheduler.add_job(
            func=execute_scheduled_task,
            trigger=trigger,
            args=[label, task],
            id=job_id,
            name=label,
            replace_existing=False,
            misfire_grace_time=300,   # 5-min grace if server was briefly down
        )

        job = scheduler.get_job(job_id)
        next_run = (
            job.next_run_time.strftime("%Y-%m-%d %H:%M UTC")
            if job and job.next_run_time else "N/A"
        )

        if cron:
            return (
                f"✅ Recurring task scheduled!\n"
                f"Label: {label}\nID: `{job_id}`\n"
                f"Cron: `{cron}`\nNext run: {next_run}\n\n"
                f"Cancel any time with: /tasks cancel {job_id}"
            )
        return (
            f"✅ One-time task scheduled!\n"
            f"Label: {label}\nID: `{job_id}`\n"
            f"Runs at: {next_run} UTC\n\n"
            f"Cancel with: /tasks cancel {job_id}"
        )
    except Exception as e:
        return f"ERROR scheduling task: {e}"


def dispatch_skill(tool_name: str, args: dict) -> str:
    """
    Execute a custom YAML skill.
    tool_name is 'skill_<name>' where <name> matches the `name:` field in the YAML.
    """
    raw_name = tool_name.removeprefix("skill_")
    skill_data = None

    for skill_file in SKILLS_DIR.glob("*.yaml"):
        try:
            s = yaml.safe_load(skill_file.read_text())
            if s and s.get("name") == raw_name:
                skill_data = s
                break
        except Exception:
            continue

    if not skill_data:
        return f"ERROR: Custom skill '{raw_name}' not found. Try /skill reload."

    skill_type = skill_data.get("type", "command")

    if skill_type == "command":
        cmd = skill_data.get("command", "")
        for k, v in args.items():
            if k != "reason":
                cmd = cmd.replace(f"{{{k}}}", str(v))
        return run_command(cmd)

    elif skill_type in ("http", "webhook"):
        url = skill_data.get("url", "")
        method = skill_data.get("method", "GET").upper()
        for k, v in args.items():
            if k != "reason":
                url = url.replace(f"{{{k}}}", str(v))
        body = {k: v for k, v in args.items() if k != "reason"} if skill_type == "webhook" else None
        try:
            resp = requests.request(method, url, json=body, timeout=30)
            text = resp.text
            if len(text) > MAX_OUTPUT_CHARS:
                text = text[:MAX_OUTPUT_CHARS] + "... [truncated]"
            return f"HTTP {resp.status_code}\n{text}"
        except Exception as e:
            return f"ERROR in skill {raw_name}: {e}"

    return f"ERROR: Unknown skill type '{skill_type}' in {raw_name}.yaml"


def _upload_media_to_wp(file_bytes: bytes, filename: str, mime_type: str) -> dict:
    """Upload raw bytes to the WordPress media library."""
    import uuid

    # ── Local mode: WP-CLI ────────────────────────────────────────────────────
    if Path(WP_PATH).exists() and os.listdir(WP_PATH):
        safe_name = re.sub(r"[^\w.\-]", "_", filename)
        tmp_path = f"/tmp/openclaw-upload-{uuid.uuid4().hex[:8]}-{safe_name}"
        try:
            with open(tmp_path, "wb") as fh:
                fh.write(file_bytes)
            result = subprocess.run(
                f"wp media import {tmp_path} --porcelain --path={WP_PATH} --allow-root",
                shell=True,
                capture_output=True,
                text=True,
                timeout=60,
                env={**os.environ, "HOME": "/root"},
            )
            output = (result.stdout + result.stderr).strip()
            attachment_id = None
            for token in output.split():
                if token.isdigit():
                    attachment_id = int(token)
                    break
            if result.returncode != 0 or attachment_id is None:
                return {"error": f"WP-CLI media import failed: {output[:300]}"}
            url_result = subprocess.run(
                f"wp post get {attachment_id} --field=guid --path={WP_PATH} --allow-root",
                shell=True,
                capture_output=True,
                text=True,
                timeout=30,
                env={**os.environ, "HOME": "/root"},
            )
            media_url = url_result.stdout.strip()
            return {"id": attachment_id, "url": media_url}
        except Exception as e:
            return {"error": str(e)}
        finally:
            try:
                os.unlink(tmp_path)
            except Exception:
                pass

    # ── Remote mode: REST API ─────────────────────────────────────────────────
    if not WP_URL:
        return {"error": "WP_URL not configured."}
    if not WP_APP_PASSWORD and not WP_ADMIN_PASSWORD:
        return {"error": (
            "No WordPress credentials configured for remote upload. "
            "Set WP_APP_PASSWORD (Application Password) in .env"
        )}

    headers = {
        "Content-Disposition": f'attachment; filename="{filename}"',
        "Content-Type": mime_type,
    }
    auth = None
    if WP_APP_PASSWORD:
        import base64
        creds = base64.b64encode(f"{WP_ADMIN_USER}:{WP_APP_PASSWORD}".encode()).decode()
        headers["Authorization"] = f"Basic {creds}"
    elif WP_ADMIN_PASSWORD:
        auth = (WP_ADMIN_USER, WP_ADMIN_PASSWORD)

    url = WP_URL.rstrip("/") + "/wp-json/wp/v2/media"
    try:
        resp = requests.post(url, headers=headers, data=file_bytes, auth=auth, timeout=60)
        if resp.status_code in (200, 201):
            d = resp.json()
            return {
                "id": d.get("id"),
                "url": d.get("source_url") or d.get("guid", {}).get("rendered", ""),
            }
        return {"error": f"WordPress returned HTTP {resp.status_code}: {resp.text[:300]}"}
    except Exception as e:
        return {"error": str(e)}


def dispatch_tool(name: str, args: dict) -> str:
    """Route a tool call to the right function."""
    if name == "run_command":
        return run_command(args.get("command", ""))
    elif name == "wp_rest":
        return wp_rest(
            args.get("method", "GET"),
            args.get("endpoint", "/"),
            args.get("body"),
            args.get("params"),
        )
    elif name == "wp_cli_remote":
        return wp_cli_remote(args.get("command", ""))
    elif name == "schedule_task":
        return schedule_task_fn(
            args.get("task", ""),
            args.get("run_at"),
            args.get("cron"),
            args.get("label"),
        )
    elif name.startswith("skill_"):
        return dispatch_skill(name, args)
    else:
        return f"ERROR: Unknown tool '{name}'"


def _tool_label(fn_name: str, fn_args: dict) -> str:
    """One-line human-readable label for a tool call shown in Telegram progress."""
    reason = (fn_args.get("reason") or "").strip()
    if fn_name == "run_command":
        if reason:
            return f"🖥 {reason[:120]}"
        cmd = fn_args.get("command") or ""
        first_line = ""
        for line in cmd.splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#"):
                first_line = stripped
                break
        if not first_line:
            first_line = " ".join(cmd.split())[:80] or "(command)"
        return f"🖥 {first_line[:110]}"
    elif fn_name == "wp_rest":
        if reason:
            return f"🌐 {reason[:120]}"
        return f"🌐 {fn_args.get('method', 'GET')} {fn_args.get('endpoint', '')}"
    elif fn_name == "wp_cli_remote":
        if reason:
            return f"🔧 {reason[:120]}"
        return f"🔧 wp {fn_args.get('command', '')[:100]}"
    elif fn_name == "schedule_task":
        if reason:
            return f"⏰ {reason[:120]}"
        return f"⏰ Scheduling: {fn_args.get('label') or fn_args.get('task', '')[:80]}"
    elif fn_name.startswith("skill_"):
        if reason:
            return f"🔌 {reason[:120]}"
        return f"🔌 Skill: {fn_name.removeprefix('skill_')}"
    return f"⚙️ {reason or fn_name}"


# ─── Scheduler helpers ────────────────────────────────────────────────────────

def _notify_telegram(text: str) -> None:
    """Push a Markdown message to all admin users via Telegram Bot API (via Squid proxy)."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_ADMIN_USER_ID:
        app.logger.warning("Telegram notify skipped: BOT_TOKEN or ADMIN_USER_ID not set in agent env")
        return
    if len(text) > 4000:
        text = text[:4000] + "\n…[truncated]"
    for uid in TELEGRAM_ADMIN_USER_ID.split(","):
        uid = uid.strip()
        if not uid:
            continue
        try:
            # requests auto-applies HTTPS_PROXY env var → routes through Squid
            requests.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json={"chat_id": uid, "text": text, "parse_mode": "Markdown"},
                timeout=15,
            )
        except Exception as e:
            app.logger.warning(f"Telegram notify failed for user {uid}: {e}")


def execute_scheduled_task(task_label: str, task_text: str) -> None:
    """
    APScheduler job callback.  Runs the full agentic loop for a scheduled task
    and pushes the result back to the Telegram admin user(s).
    """
    app.logger.info(f"[scheduler] Running: {task_label!r}")
    result_text = "(no result)"
    elapsed = 0
    try:
        for event in run_agent(task_text):
            if event.get("type") == "result":
                result_text = event.get("text", "(no result)")
                elapsed = event.get("elapsed", 0)
    except Exception as e:
        result_text = f"❌ Scheduled task error: {e}"
        app.logger.exception(f"[scheduler] Error in '{task_label}'")

    app.logger.info(f"[scheduler] Done: {task_label!r} in {elapsed}s")
    _notify_telegram(f"⏰ *Scheduled task complete:* _{task_label}_\n\n{result_text}")


# ─── Agentic loop ─────────────────────────────────────────────────────────────

def run_agent(user_message: str, model: str = None, history: list = None):
    """
    Main agentic loop — generator that yields progress events then a final result.

    Yields dicts:
      {"type": "thinking"}                         — LLM is generating
      {"type": "progress", "text": "..."}          — tool about to execute
      {"type": "result", "text": "...",
       "elapsed": N, "model": "..."}               — final answer

    history: list of {"role": "user"|"assistant", "content": "..."} from prior turns.
    """
    if model is None:
        model = DEFAULT_MODEL

    messages = list(history or [])
    messages.append({"role": "user", "content": user_message})
    system_injected = False
    start = time.time()
    steps = 0
    all_tools = _get_all_tools()

    while steps < MAX_STEPS:
        steps += 1

        yield {"type": "thinking"}

        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=all_tools,
                tool_choice="auto",
                system=SYSTEM_PROMPT,  # OpenAI-compat passes system separately
                max_tokens=4096,
            )
        except TypeError:
            # Some model configurations don't accept 'system' as a kwarg;
            # prepend it as a system message instead.
            if not system_injected:
                messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages
                system_injected = True
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=all_tools,
                tool_choice="auto",
                max_tokens=4096,
            )
        except Exception as e:
            err = str(e)
            if model != FALLBACK_MODEL:
                app.logger.warning(f"Model {model} failed ({err}), trying {FALLBACK_MODEL}")
                yield from run_agent(user_message, model=FALLBACK_MODEL, history=history)
                return
            yield {"type": "result", "text": f"AI service error: {err}",
                   "elapsed": round(time.time() - start, 1), "model": model}
            return

        if not response.choices:
            yield {"type": "result", "text": "AI service returned an empty response.",
                   "elapsed": round(time.time() - start, 1), "model": model}
            return
        choice = response.choices[0]
        msg = choice.message
        messages.append({"role": "assistant", "content": msg.content, "tool_calls": msg.tool_calls})

        # No tool calls → final answer
        if not msg.tool_calls:
            yield {"type": "result", "text": msg.content or "(no response)",
                   "elapsed": round(time.time() - start, 1), "model": model}
            return

        # Execute each tool call, emitting a progress event before each one
        for tc in msg.tool_calls:
            fn_name = tc.function.name
            try:
                fn_args = json.loads(tc.function.arguments)
            except json.JSONDecodeError:
                fn_args = {}

            yield {"type": "progress", "text": _tool_label(fn_name, fn_args)}

            app.logger.info(f"Tool call: {fn_name}({list(fn_args.keys())})")
            tool_result = dispatch_tool(fn_name, fn_args)
            app.logger.info(f"  → {tool_result[:200]}")

            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": tool_result,
            })

    yield {"type": "result",
           "text": "Reached the maximum number of steps. The task may be partially complete.",
           "elapsed": round(time.time() - start, 1), "model": model}


# ─── Flask API ────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return jsonify({
        "status": "ok",
        "model": DEFAULT_MODEL,
        "scheduler": "running" if scheduler.running else "stopped",
        "scheduled_jobs": len(scheduler.get_jobs()),
        "custom_skills": len(_cached_custom_tools),
        "whisper": "available" if _whisper_client else "unavailable (set OPENAI_API_KEY)",
    })


@app.post("/upload")
def handle_upload():
    """Receive a photo from the bot and push it to the WordPress media library."""
    if "file" not in request.files:
        return jsonify({"error": "No file in request"}), 400
    f = request.files["file"]
    result = _upload_media_to_wp(
        f.read(),
        f.filename or "upload.jpg",
        f.content_type or "image/jpeg",
    )
    if "error" in result:
        return jsonify(result), 502
    return jsonify(result)


@app.post("/transcribe")
def handle_transcribe():
    """
    Receive an audio file (OGG Opus voice message from Telegram) and return a
    transcript.  Requires OPENAI_API_KEY — uses OpenAI Whisper API via Squid proxy.
    """
    if not _whisper_client:
        return jsonify({
            "error": (
                "Voice transcription unavailable. "
                "Add OPENAI_API_KEY to .env to enable Whisper."
            )
        }), 503

    if "file" not in request.files:
        return jsonify({"error": "No audio file provided (field: 'file')"}), 400

    f = request.files["file"]
    audio_bytes = f.read()
    filename    = f.filename or "voice.ogg"
    content_type = f.content_type or "audio/ogg"

    try:
        transcript = _whisper_client.audio.transcriptions.create(
            model="whisper-1",
            file=(filename, audio_bytes, content_type),
        )
        app.logger.info(f"Transcribed {len(audio_bytes)}B: {transcript.text[:80]!r}")
        return jsonify({"text": transcript.text})
    except Exception as e:
        app.logger.error(f"Whisper failed: {e}")
        return jsonify({"error": f"Transcription failed: {e}"}), 502


@app.post("/task")
def handle_task():
    data = request.get_json(force=True, silent=True) or {}
    message = data.get("message", "").strip()
    model   = data.get("model", DEFAULT_MODEL)
    history = data.get("history", [])

    # Belt-and-suspenders cap: never let history exceed 20 messages (10 turns)
    if len(history) > 20:
        history = history[-20:]

    if not message:
        return jsonify({"error": "No message provided"}), 400

    app.logger.info(f"Task received: {message[:100]}")

    def generate():
        try:
            for event in run_agent(message, model=model, history=history):
                yield json.dumps(event) + "\n"
                if event.get("type") == "result":
                    app.logger.info(f"Task done in {event.get('elapsed', '?')}s")
        except Exception as e:
            app.logger.exception("Unhandled exception in streaming generator")
            yield json.dumps({
                "type": "result",
                "text": f"❌ Internal agent error: {e}",
                "elapsed": 0,
                "model": model,
            }) + "\n"

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")


@app.get("/schedules")
def list_schedules():
    """Return all scheduled jobs as JSON."""
    jobs = []
    for job in scheduler.get_jobs():
        jobs.append({
            "id": job.id,
            "name": job.name,
            "next_run": str(job.next_run_time) if job.next_run_time else "N/A",
            "trigger": str(job.trigger),
        })
    return jsonify({"jobs": jobs})


@app.delete("/schedules/<job_id>")
def cancel_schedule(job_id: str):
    """Remove a scheduled job by its ID."""
    try:
        scheduler.remove_job(job_id)
        return jsonify({"status": "cancelled", "id": job_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 404


@app.get("/skills")
def list_skills_endpoint():
    """Return names of all available tools (built-in + custom skills)."""
    return jsonify({
        "builtin": [t["function"]["name"] for t in TOOLS],
        "custom":  [t["function"]["name"] for t in _cached_custom_tools],
        "count":   len(TOOLS) + len(_cached_custom_tools),
    })


@app.post("/reload-skills")
def reload_skills():
    """Hot-reload YAML skill files from openclaw-config/skills/ without restarting."""
    global _cached_custom_tools
    old_count = len(_cached_custom_tools)
    _cached_custom_tools = load_custom_skills()
    new_count = len(_cached_custom_tools)
    return jsonify({
        "loaded":   new_count,
        "previous": old_count,
        "skills":   [t["function"]["name"] for t in _cached_custom_tools],
    })


# ─── Startup ──────────────────────────────────────────────────────────────────

# Load custom skills at import time (gunicorn imports this module once per worker)
_cached_custom_tools = load_custom_skills()
app.logger.info(f"Custom skills loaded: {len(_cached_custom_tools)}")

# Start background scheduler (persists jobs in SQLite across restarts)
scheduler.start()
app.logger.info(f"Scheduler started — pending jobs: {len(scheduler.get_jobs())}")


if __name__ == "__main__":
    # For local dev only; in production use gunicorn
    app.run(host="0.0.0.0", port=8080, debug=False)
