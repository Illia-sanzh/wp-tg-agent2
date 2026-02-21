# Custom Skills — OpenClaw WordPress Agent

Drop `.yaml` files in this directory to add new tools to the AI agent.
The agent reloads skills automatically on startup, or on demand via `/skill reload` in Telegram.

---

## Quick Start

1. Copy one of the example files below into this directory.
2. Edit it to fit your use case.
3. Send `/skill reload` in Telegram (or restart the stack).
4. Ask the agent to use it: _"Check the disk space"_ / _"Get the exchange rate for USD to EUR"_.

---

## File Format

```yaml
# Required fields
name: my_tool_name          # Unique identifier — alphanumeric + underscores ONLY
label: "Human-readable name"
description: |
  When the LLM should use this tool and what it does.
  Be specific — this text is read by the AI to decide when to call your tool.
type: command               # command | http | webhook

# For type: command
command: "shell command with {param} placeholders"

# For type: http
url: "https://api.example.com/endpoint/{param}"
method: GET                 # GET | POST | PUT | PATCH | DELETE (default: GET)

# For type: webhook  (same as http but also sends all params as JSON body)
url: "https://hooks.example.com/trigger"
method: POST

# Optional
disabled: false             # Set to true to skip this skill without deleting the file

# Parameters (optional — omit the list entirely for no-parameter skills)
parameters:
  - name: param_name
    description: "What this parameter means (seen by the LLM)"
    type: string             # string | integer | boolean
    required: true
  - name: optional_param
    description: "An optional parameter"
    type: string
    required: false
```

---

## Skill Types

### `command` — Run a shell command

The agent container runs the shell command. Use `{param_name}` placeholders.

```yaml
name: check_server_disk
label: "Check Server Disk Space"
description: >
  Check how much disk space is available on the server where WordPress runs.
  Use this before large media uploads, plugin installs, or when diagnosing storage issues.
type: command
command: "df -h / && echo '---' && du -sh /wordpress 2>/dev/null | head -1"
parameters: []
```

```yaml
name: ping_host
label: "Ping a Host"
description: "Check if a host or domain is reachable from the server."
type: command
command: "ping -c 3 {host}"
parameters:
  - name: host
    description: "Hostname or IP to ping (e.g. 'google.com')"
    type: string
    required: true
```

> ⚠️ **Security note:** `{param}` values are substituted directly into the shell command.
> Skills are only callable by the AI agent — but if your skill takes user-supplied input,
> keep the command sandboxed (e.g. use specific flags, avoid `sh -c "{user_input}"`).

---

### `http` — Call an external API (GET or POST)

`{param_name}` placeholders are replaced in the URL. The response is returned to the LLM.

```yaml
name: get_exchange_rate
label: "Currency Exchange Rate"
description: >
  Fetch the current exchange rate from one currency to another.
  Useful when pricing WooCommerce products for international markets.
type: http
method: GET
url: "https://open.er-api.com/v6/latest/{base}"
parameters:
  - name: base
    description: "Base currency code (e.g. USD, EUR, GBP)"
    type: string
    required: true
```

> ⚠️ **Squid allowlist:** The agent container routes all outbound traffic through Squid.
> You must add the API domain to `squid/allowlist.txt` for HTTP skills to work.
>
> ```
> # Add to squid/allowlist.txt:
> .open.er-api.com
> ```
>
> Then reload Squid:
> ```bash
> docker exec openclaw-squid squid -k reconfigure
> ```

---

### `webhook` — POST JSON to a URL

All parameters are sent as a JSON body. `{param}` placeholders work in the URL too.

```yaml
name: notify_slack
label: "Send Slack Notification"
description: >
  Send a message to a Slack channel via webhook.
  Use this to notify the team when a post is published or a plugin is updated.
type: webhook
url: "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
method: POST
parameters:
  - name: message
    description: "The message text to send to Slack"
    type: string
    required: true
```

---

## Tips

- **Test first:** After adding a skill, type `/skill reload` then ask the agent to use it.
- **Be descriptive:** The `description` field is how the AI decides when to call your skill. The more specific, the better.
- **No restart needed:** Use `/skill reload` to pick up new or changed files without restarting Docker.
- **Disable without deleting:** Set `disabled: true` to temporarily hide a skill from the agent.
- **Multiple files:** Each `.yaml` file can define one skill. Keep one skill per file for clarity.

---

## MCP Servers (Advanced)

For more complex integrations, you can run a [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server as an additional Docker container and expose its tools as HTTP skills pointing to its endpoints.

Example pattern:
1. Add an MCP server container to `docker-compose.yml` on the `agent-internal` network.
2. Create a skill YAML pointing to `http://my-mcp-server:8000/tools/invoke`.
3. `/skill reload` and start using it.

Future versions of OpenClaw may add native MCP transport (SSE/stdio) support.
