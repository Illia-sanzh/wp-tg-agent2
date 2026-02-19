"""
WordPress AI Agent
──────────────────
Receives a task message, runs an agentic loop using the LLM (via LiteLLM),
executes WP-CLI commands or REST API calls, and returns the result.

KEY DESIGN DECISION — Avoids the 401 Anthropic error:
  We use the OpenAI-compatible SDK pointing to LiteLLM, NOT the Anthropic SDK.
  LiteLLM handles the real API key and speaks to Anthropic/OpenAI/etc internally.
  The agent never touches the real API key at all.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import httpx
import requests
from flask import Flask, Response, jsonify, request, stream_with_context
from openai import OpenAI

# ─── Configuration ────────────────────────────────────────────────────────────

LITELLM_BASE_URL = os.environ.get("LITELLM_BASE_URL", "http://openclaw-litellm:4000/v1")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-1234")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "claude-sonnet-4-6")
FALLBACK_MODEL = os.environ.get("FALLBACK_MODEL", "deepseek-chat")

WP_PATH = os.environ.get("WP_PATH", "/wordpress")
WP_URL = os.environ.get("WP_URL", "")
WP_ADMIN_USER = os.environ.get("WP_ADMIN_USER", "admin")
WP_APP_PASSWORD = os.environ.get("WP_APP_PASSWORD", "")
WP_ADMIN_PASSWORD = os.environ.get("WP_ADMIN_PASSWORD", "")
BRIDGE_SECRET = os.environ.get("BRIDGE_SECRET", "")
SKILL_FILE = os.environ.get("SKILL_FILE", "/app/SKILL.md")

# Max tool calls per task (prevents infinite loops)
MAX_STEPS = 25
# Max chars of command output fed back to the LLM
MAX_OUTPUT_CHARS = 8000

app = Flask(__name__)

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
8. NEVER run: wp db drop, wp db reset, wp site empty, wp eval, wp shell.
9. ALWAYS use --allow-root when running wp commands.
10. For destructive operations, always ask for confirmation first (respond without running).

## WordPress Mode: {wp_mode.upper()}
{"You have direct WP-CLI access. Use: wp --path=" + WP_PATH + " --allow-root" if wp_mode == "local" else "WordPress is remote. Use wp_rest or wp_cli_remote tools."}
"""

SYSTEM_PROMPT = load_system_prompt()

# ─── Tools definition ─────────────────────────────────────────────────────────

TOOLS = [
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
                    }
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
                    }
                },
                "required": ["command"],
            },
        },
    },
]

# ─── Tool implementations ─────────────────────────────────────────────────────

def run_command(command: str) -> str:
    """Execute a bash command safely."""
    # Block dangerous commands
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

    # Choose auth method
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
            # Squid proxy is set via HTTP_PROXY env var automatically
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
    else:
        return f"ERROR: Unknown tool '{name}'"


def _tool_label(fn_name: str, fn_args: dict) -> str:
    """One-line human-readable label for a tool call shown in Telegram progress."""
    if fn_name == "run_command":
        cmd = fn_args.get("command", "").strip().replace("\n", " ")
        return f"🖥 {cmd[:120]}"
    elif fn_name == "wp_rest":
        return f"🌐 {fn_args.get('method', 'GET')} {fn_args.get('endpoint', '')}"
    elif fn_name == "wp_cli_remote":
        return f"🔧 wp {fn_args.get('command', '')[:100]}"
    return f"⚙️ {fn_name}"


# ─── Agentic loop ─────────────────────────────────────────────────────────────

def run_agent(user_message: str, model: str = None):
    """
    Main agentic loop — generator that yields progress events then a final result.

    Yields dicts:
      {"type": "thinking"}                         — LLM is generating
      {"type": "progress", "text": "..."}          — tool about to execute
      {"type": "result", "text": "...",
       "elapsed": N, "model": "..."}               — final answer
    """
    if model is None:
        model = DEFAULT_MODEL

    messages = [{"role": "user", "content": user_message}]
    system_injected = False
    start = time.time()
    steps = 0

    while steps < MAX_STEPS:
        steps += 1

        yield {"type": "thinking"}

        try:
            response = client.chat.completions.create(
                model=model,
                messages=messages,
                tools=TOOLS,
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
                tools=TOOLS,
                tool_choice="auto",
                max_tokens=4096,
            )
        except Exception as e:
            err = str(e)
            if model != FALLBACK_MODEL:
                app.logger.warning(f"Model {model} failed ({err}), trying {FALLBACK_MODEL}")
                yield from run_agent(user_message, model=FALLBACK_MODEL)
                return
            yield {"type": "result", "text": f"AI service error: {err}",
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
    return jsonify({"status": "ok", "model": DEFAULT_MODEL})


@app.post("/task")
def handle_task():
    data = request.get_json(force=True, silent=True) or {}
    message = data.get("message", "").strip()
    model = data.get("model", DEFAULT_MODEL)

    if not message:
        return jsonify({"error": "No message provided"}), 400

    app.logger.info(f"Task received: {message[:100]}")

    def generate():
        for event in run_agent(message, model=model):
            yield json.dumps(event) + "\n"
            if event.get("type") == "result":
                app.logger.info(f"Task done in {event.get('elapsed', '?')}s")

    return Response(stream_with_context(generate()), mimetype="application/x-ndjson")


if __name__ == "__main__":
    # For local dev only; in production use gunicorn
    app.run(host="0.0.0.0", port=8080, debug=False)
