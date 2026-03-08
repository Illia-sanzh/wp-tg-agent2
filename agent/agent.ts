/**
 * WordPress AI Agent (TypeScript)
 * ────────────────────────────────
 * Express HTTP server that receives tasks, runs an agentic loop using the LLM
 * (via LiteLLM), executes WP-CLI / REST API calls, and streams results as NDJSON.
 *
 * KEY DESIGN DECISION — Avoids the 401 Anthropic error:
 *   We use the OpenAI-compatible SDK pointing to LiteLLM, NOT the Anthropic SDK.
 *   LiteLLM handles the real API key and speaks to Anthropic/OpenAI/etc internally.
 */

import express, { Request, Response } from "express";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as yaml from "js-yaml";
import OpenAI, { toFile } from "openai";
import axios, { AxiosRequestConfig } from "axios";
import multer from "multer";
import Database from "better-sqlite3";
import schedule from "node-schedule";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

// ─── Configuration ────────────────────────────────────────────────────────────

const LITELLM_BASE_URL   = process.env.LITELLM_BASE_URL   ?? "http://openclaw-litellm:4000/v1";
const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? "sk-1234";
const DEFAULT_MODEL      = process.env.DEFAULT_MODEL      ?? "claude-sonnet-4-6";
const FALLBACK_MODEL     = process.env.FALLBACK_MODEL     ?? "gpt-4o";
const OR_FALLBACK_MODEL  = process.env.OR_FALLBACK_MODEL  ?? "openrouter/gpt-4o";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const HTTPS_PROXY    = process.env.HTTPS_PROXY    ?? "";

const WP_PATH           = process.env.WP_PATH           ?? "/wordpress";
const WP_URL            = process.env.WP_URL            ?? "";
const WP_ADMIN_USER     = process.env.WP_ADMIN_USER     ?? "admin";
const WP_APP_PASSWORD   = process.env.WP_APP_PASSWORD   ?? "";
const WP_ADMIN_PASSWORD = process.env.WP_ADMIN_PASSWORD ?? "";
const BRIDGE_SECRET     = process.env.BRIDGE_SECRET     ?? "";
const SKILL_FILE        = process.env.SKILL_FILE        ?? "/app/SKILL.md";

// MCP Adapter is always on the same host as WordPress — use host.docker.internal
// (in NO_PROXY, avoids Squid) rather than WP_URL which may be a public hostname.
const WP_MCP_ENDPOINT = WP_URL
  ? "http://host.docker.internal/wp-json/mcp/mcp-adapter-default-server"
  : "";

const TELEGRAM_BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN     ?? "";
const TELEGRAM_ADMIN_USER_ID = process.env.TELEGRAM_ADMIN_USER_ID ?? "";

const SKILLS_DIR  = "/app/config/skills";
const DATA_DIR    = "/app/data";
const SCHEDULE_DB = path.join(DATA_DIR, "schedules.db");
const THREADS_DB  = path.join(DATA_DIR, "threads.json");

// ─── Thread-based conversation history (for forum, github, etc.) ─────────────
interface ThreadEntry {
  role: "user" | "assistant" | "system";
  content: string;
}
interface ThreadRecord {
  channel: string;
  thread_id: string;
  history: ThreadEntry[];
  updated: number;  // epoch ms
}

const threadStore = new Map<string, ThreadRecord>();
const MAX_THREAD_HISTORY = 50;  // messages per thread (25 turns)
const MAX_THREADS = 500;

function loadThreads(): void {
  try {
    if (fs.existsSync(THREADS_DB)) {
      const data = JSON.parse(fs.readFileSync(THREADS_DB, "utf8"));
      for (const [k, v] of Object.entries(data)) threadStore.set(k, v as ThreadRecord);
      console.log(`[threads] Loaded ${threadStore.size} thread(s) from disk`);
    }
  } catch (e) { console.warn(`[threads] Failed to load: ${e}`); }
}

function saveThreads(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const obj: Record<string, ThreadRecord> = {};
    for (const [k, v] of threadStore) obj[k] = v;
    fs.writeFileSync(THREADS_DB, JSON.stringify(obj), "utf8");
  } catch (e) { console.warn(`[threads] Failed to save: ${e}`); }
}

function getThread(channel: string, threadId: string): ThreadRecord {
  const key = `${channel}:${threadId}`;
  if (!threadStore.has(key)) {
    threadStore.set(key, { channel, thread_id: threadId, history: [], updated: Date.now() });
  }
  return threadStore.get(key)!;
}

function appendToThread(channel: string, threadId: string, role: "user" | "assistant", content: string): void {
  const thread = getThread(channel, threadId);
  thread.history.push({ role, content });
  if (thread.history.length > MAX_THREAD_HISTORY) {
    thread.history = thread.history.slice(-MAX_THREAD_HISTORY);
  }
  thread.updated = Date.now();

  // Evict oldest threads if store is too large
  if (threadStore.size > MAX_THREADS) {
    let oldest: [string, ThreadRecord] | null = null;
    for (const entry of threadStore) {
      if (!oldest || entry[1].updated < oldest[1].updated) oldest = entry;
    }
    if (oldest) threadStore.delete(oldest[0]);
  }

  saveThreads();
}

// Webhook secret for inbound calls (optional security)
const INBOUND_SECRET = process.env.INBOUND_SECRET ?? "";

const MAX_STEPS       = 25;
const MAX_OUTPUT_CHARS = 8000;
const PORT            = 8080;

// ─── Ensure writable data dir ─────────────────────────────────────────────────

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  process.stderr.write(`[WARN] Cannot create data dir ${DATA_DIR}: ${e}\n`);
}

// ─── HTTP proxy helper ────────────────────────────────────────────────────────
// Uses proxy-from-env which understands NO_PROXY, like Python's requests library.

function getAgent(url: string): HttpsProxyAgent<string> | undefined {
  const proxy = getProxyForUrl(url);
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

async function httpRequest(config: AxiosRequestConfig): Promise<any> {
  const url = String(config.url ?? "");
  const agent = getAgent(url);
  return axios.request({
    ...config,
    proxy: false,
    httpsAgent: agent,
    httpAgent: agent,
  });
}

// ─── LiteLLM client (OpenAI-compatible) ──────────────────────────────────────
// This is the fix for the 401 issue: we never call Anthropic directly.

const client = new OpenAI({
  apiKey:     LITELLM_MASTER_KEY,
  baseURL:    LITELLM_BASE_URL,
  timeout:    300_000,
  maxRetries: 0,
});

// ─── Whisper client (OpenAI direct, via Squid proxy) ─────────────────────────

let whisperClient: OpenAI | null = null;
if (OPENAI_API_KEY) {
  const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;
  whisperClient = new OpenAI({
    apiKey:     OPENAI_API_KEY,
    timeout:    90_000,
    maxRetries: 0,
    // @ts-ignore — httpAgent is a valid undocumented option for node-fetch transport
    httpAgent:  proxyAgent,
  });
}

// ─── Persistent scheduler (APScheduler-compatible) ────────────────────────────

interface StoredJob {
  id: string;
  name: string;
  task: string;
  cron_expr: string | null;
  run_at: string | null;
  created_at: string;
}

class PersistentScheduler {
  private db: Database.Database;
  private activeJobs = new Map<string, schedule.Job>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        task       TEXT NOT NULL,
        cron_expr  TEXT,
        run_at     TEXT,
        created_at TEXT NOT NULL
      )
    `);
  }

  /** Load and re-register all persisted jobs. Call once on startup. */
  start(): void {
    const rows = this.db.prepare("SELECT * FROM scheduled_jobs").all() as StoredJob[];
    for (const row of rows) this._register(row);
    console.log(`[scheduler] Loaded ${rows.length} job(s) from DB`);
  }

  private _register(job: StoredJob): void {
    if (job.cron_expr) {
      const nodeJob = schedule.scheduleJob(job.id, job.cron_expr, async () => {
        await executeScheduledTask(job.name, job.task);
      });
      if (nodeJob) this.activeJobs.set(job.id, nodeJob);
    } else if (job.run_at) {
      const dt = new Date(job.run_at);
      if (dt > new Date()) {
        const nodeJob = schedule.scheduleJob(job.id, dt, async () => {
          await executeScheduledTask(job.name, job.task);
          this._removeFromDb(job.id);
          this.activeJobs.delete(job.id);
        });
        if (nodeJob) this.activeJobs.set(job.id, nodeJob);
      } else {
        // Past one-time job — clean it up
        this._removeFromDb(job.id);
      }
    }
  }

  addJob(id: string, name: string, task: string, cronExpr?: string, runAt?: Date): { nextRun: string } {
    this.db.prepare(`
      INSERT OR REPLACE INTO scheduled_jobs (id, name, task, cron_expr, run_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, name, task, cronExpr ?? null, runAt?.toISOString() ?? null, new Date().toISOString());

    this._register({ id, name, task, cron_expr: cronExpr ?? null, run_at: runAt?.toISOString() ?? null, created_at: new Date().toISOString() });

    const activeJob  = this.activeJobs.get(id);
    const nextRunDt  = activeJob?.nextInvocation() as Date | undefined;
    const nextRun    = nextRunDt
      ? nextRunDt.toISOString().replace("T", " ").slice(0, 16) + " UTC"
      : "N/A";
    return { nextRun };
  }

  removeJob(id: string): void {
    const job = this.activeJobs.get(id);
    if (job) { job.cancel(); this.activeJobs.delete(id); }
    this._removeFromDb(id);
  }

  private _removeFromDb(id: string): void {
    this.db.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(id);
  }

  getJobs(): Array<{ id: string; name: string; next_run: string; trigger: string }> {
    const rows = this.db.prepare("SELECT * FROM scheduled_jobs").all() as StoredJob[];
    return rows.map(row => {
      const activeJob = this.activeJobs.get(row.id);
      const nextRunDt = activeJob?.nextInvocation() as Date | undefined;
      return {
        id:       row.id,
        name:     row.name,
        next_run: nextRunDt ? nextRunDt.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "N/A",
        trigger:  row.cron_expr ? `cron: ${row.cron_expr}` : `date: ${row.run_at}`,
      };
    });
  }

  get jobCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM scheduled_jobs").get() as { c: number }).c;
  }
  get running(): boolean { return true; }
}

let scheduler: PersistentScheduler;
try {
  scheduler = new PersistentScheduler(SCHEDULE_DB);
} catch (e) {
  process.stderr.write(`[WARN] SQLite job store failed (${e}). Using in-memory store.\n`);
  scheduler = new PersistentScheduler(":memory:");
}

// ─── System prompt ────────────────────────────────────────────────────────────

function loadSystemPrompt(): string {
  let skill = "";
  if (fs.existsSync(SKILL_FILE)) skill = fs.readFileSync(SKILL_FILE, "utf8");

  const wpDirExists = fs.existsSync(WP_PATH) && fs.readdirSync(WP_PATH).length > 0;
  const wpMode = wpDirExists ? "local" : "remote";

  return `You are a WordPress management AI agent.

${skill}

## Current Configuration
- WordPress mode: ${wpMode}
- WordPress path (local): ${WP_PATH}
- WordPress URL: ${WP_URL}
- WP admin user: ${WP_ADMIN_USER}

## Execution Rules
1. Think step-by-step before taking any action.
2. Use the \`run_command\` tool to run WP-CLI or bash commands.
3. Use the \`wp_rest\` tool to call the WordPress REST API.
4. Use the \`wp_cli_remote\` tool to run WP-CLI via the bridge plugin (remote mode).
5. After each command, check the output before proceeding.
6. When done, give a concise human-readable summary of what was accomplished.
7. If something fails, explain why and what the user should do.
8. Always set the \`reason\` field on every tool call with a short plain-English description of what you are doing.
9. NEVER run: wp db drop, wp db reset, wp site empty, wp eval, wp shell.
10. ALWAYS use --allow-root when running wp commands.
11. For destructive operations, always ask for confirmation first (respond without running).
12. If WP-CLI fails with a database error, switch to wp_rest immediately.
13. NEVER run: nmap, nc, netstat, ss, mysqladmin, mysqld, service mysql, systemctl mysql, mysql -u, mysqld_safe, ps aux | grep mysql.

## Efficiency Rules (IMPORTANT)
- You have a LIMITED step budget. Do NOT waste steps searching, listing, or exploring when you can act directly.
- If a command fails, try ONE different approach. If that also fails, explain the problem and stop.
- NEVER retry the exact same command hoping for a different result.
- When creating content, ALWAYS create NEW posts/pages. Do NOT search for existing posts unless the user explicitly asked to update a specific one.
- Prefer \`wp post create --porcelain\` to get an ID, then \`wp post update\` — this is 2 steps, not 5+ steps of searching.
- CRITICAL: Use the \`write_file\` tool (NOT run_command with cat/heredoc) to create HTML files. Split large HTML into 2-3 write_file calls: first call writes the <style> + first sections, then use append=true for the rest. This prevents output truncation.
- When updating an existing post's design, do NOT read the old content first — just create the new HTML from scratch and overwrite it.
- Do NOT fetch the same URL twice.

## WordPress Mode: ${wpMode.toUpperCase()}
${wpMode === "local"
  ? `You have direct WP-CLI access. Use: wp --path=${WP_PATH} --allow-root`
  : "WordPress is remote. Use wp_rest or wp_cli_remote tools."}

## Scheduling Tasks
Use the \`schedule_task\` tool when the user asks to do something at a specific time or on a recurring basis.
- For one-time tasks: set \`run_at\` to an ISO 8601 UTC datetime (e.g. "2024-01-15T17:00:00")
- For recurring tasks: set \`cron\` to a 5-part expression: minute hour day month weekday
  Examples: "0 17 * * *" = every day at 5 pm UTC | "0 3 * * 1" = every Monday at 3 am UTC
- When the user gives a local time, ask for their UTC offset (e.g. +05:30) before scheduling.
- Always tell the user the job ID returned so they can cancel it later with /tasks cancel <ID>.

## Fetching Web Pages
Use the \`fetch_page\` tool to download and inspect any public webpage's HTML/CSS.
When asked to replicate a design:
1. Fetch the page and study its LAYOUT PATTERNS: asymmetric grids, jigsaw arrangements, dark/light section alternation, card sizes
2. Note the exact COLOR PALETTE: primary brand color, dark section bg, accent colors, text colors
3. Note TYPOGRAPHY: weight (700? 800?), size hierarchy, letter-spacing
4. Create HTML+CSS that matches the layout structure precisely — asymmetric grids, not boring equal columns
5. Include ANIMATIONS: scroll-triggered fade-ins, hover effects, gradient animations
6. Convert to WordPress blocks (use skill_convert if available, otherwise wp:html wrapper)
7. Insert into WordPress

## Web Design Quality (CRITICAL)
You are a world-class web designer. Your output must feel ALIVE, not like a flat template.
- **Varied layouts**: use jigsaw grids (2/3+1/3, then 3 equal), bento grids, asymmetric splits. NEVER make every section the same boring equal-column grid.
- **Dark/light contrast**: alternate between light and dark background sections for drama
- **Animations**: ALWAYS include scroll-reveal animations (IntersectionObserver), card hover lift effects, and gradient text/backgrounds
- **Dramatic hero**: full-bleed gradient/image background, large bold heading (possibly with gradient text), animated background
- **Depth**: layered shadows, overlapping elements, backdrop-filter blur
- The web-design and greenshift-blocks knowledge skills have full CSS patterns and code snippets

## Custom Skills
Additional tool functions may be available below if YAML skill files are present in
openclaw-config/skills/. Use any loaded skill the same way as built-in tools.

## WordPress Abilities
WordPress Abilities are plugin-registered tools exposed via the MCP Adapter (WP 7.0+).
They appear as tools with the \`wp_ability__\` prefix. Use them for operations like
toggling maintenance mode or bulk-updating site identity — things not easily done
via WP-CLI or the REST API. They communicate directly with WordPress through its
MCP endpoint.
`;
}

const SYSTEM_PROMPT = loadSystemPrompt();

// ─── Built-in tool definitions ────────────────────────────────────────────────

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a bash command on the agent server. " +
        "Use this for WP-CLI commands (wp --path=/wordpress --allow-root ...), " +
        "file operations, and server-side tasks. Output is limited to 8000 characters.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The bash command to execute." },
          reason:  { type: "string", description: "One short sentence describing what this step does in plain English, shown to the user." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wp_rest",
      description:
        "Call the WordPress REST API. " +
        "Use for reading/writing posts, pages, media, users, settings, plugins, etc. " +
        "Works for both local and remote WordPress installations.",
      parameters: {
        type: "object",
        properties: {
          method:   { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "HTTP method." },
          endpoint: { type: "string", description: "REST API endpoint path, e.g. /wp/v2/posts or /wc/v3/products" },
          body:     { type: "object", description: "Request body as JSON object (for POST/PUT/PATCH)." },
          params:   { type: "object", description: "Query string parameters as key-value pairs." },
          reason:   { type: "string", description: "One short sentence describing what this step does in plain English." },
        },
        required: ["method", "endpoint"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wp_cli_remote",
      description:
        "Run a WP-CLI command on a remote WordPress site via the OpenClaw bridge plugin. " +
        "Use when WordPress is hosted on a different server. " +
        "Provide the WP-CLI command WITHOUT the 'wp' prefix.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "WP-CLI command without the 'wp' prefix. E.g.: 'plugin list --format=json'" },
          reason:  { type: "string", description: "One short sentence describing what this step does in plain English." },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_task",
      description:
        "Schedule a WordPress management task to run at a specific future time or on a " +
        "recurring schedule. Use this when the user says things like 'at 5pm', " +
        "'every Monday', 'publish tomorrow', 'weekly backup', etc.",
      parameters: {
        type: "object",
        properties: {
          task:   { type: "string", description: "Full plain-English description of what to do." },
          run_at: { type: "string", description: "ISO 8601 UTC datetime for a one-time task. Omit if using cron." },
          cron:   { type: "string", description: "5-part cron for recurring tasks. Omit if using run_at." },
          label:  { type: "string", description: "Short human-readable name shown in /tasks list." },
          reason: { type: "string", description: "One short sentence describing what this step does." },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write content to a file on the agent server. Use this to create HTML, CSS, or " +
        "any text files. PREFERRED over run_command with cat/heredoc for writing files — " +
        "especially large HTML files. You can call this multiple times with append=true " +
        "to build up a file in chunks.",
      parameters: {
        type: "object",
        properties: {
          path:    { type: "string", description: "Absolute file path, e.g. /tmp/design.html" },
          content: { type: "string", description: "The text content to write to the file." },
          append:  { type: "boolean", description: "If true, append to the file instead of overwriting. Default: false." },
          reason:  { type: "string", description: "One short sentence describing what this step does." },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_to_forum",
      description:
        "Post a reply (comment) to a forum topic on the WordPress site. " +
        "Use this when responding to forum messages received via the /inbound channel. " +
        "Requires the post_id of the topic to reply to.",
      parameters: {
        type: "object",
        properties: {
          post_id: { type: "number", description: "The WordPress post ID of the forum topic to reply to." },
          content: { type: "string", description: "The reply content (plain text or HTML)." },
          reason:  { type: "string", description: "One short sentence describing what this step does." },
        },
        required: ["post_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_page",
      description:
        "Fetch a web page and return its cleaned HTML content (scripts, SVGs, iframes, " +
        "base64 data stripped). Use this to study the design/layout of any public website. " +
        "Returns cleaned HTML truncated to 20000 chars.",
      parameters: {
        type: "object",
        properties: {
          url:    { type: "string", description: "The full URL to fetch, e.g. https://nytimes.com" },
          reason: { type: "string", description: "One short sentence describing why you're fetching this page." },
        },
        required: ["url"],
      },
    },
  },
];

// ─── Custom skills loader ─────────────────────────────────────────────────────

function loadCustomSkills(): OpenAI.Chat.ChatCompletionTool[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  let files: string[];
  try {
    files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".yaml")).sort();
  } catch { return []; }

  const tools: OpenAI.Chat.ChatCompletionTool[] = [];
  for (const file of files) {
    try {
      const skill = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, file), "utf8")) as Record<string, any>;
      if (!skill || typeof skill !== "object") continue;
      if (skill.disabled) continue;

      const name = (skill.name ?? "").trim();
      if (!name || !/^[a-zA-Z0-9_]+$/.test(name)) {
        console.warn(`[skills] ${file}: invalid/missing name, skipping.`);
        continue;
      }

      const props: Record<string, any> = {};
      const required: string[] = [];
      for (const p of (skill.parameters ?? [])) {
        const pName = (p.name ?? "").trim();
        if (!pName) continue;
        props[pName] = { type: p.type ?? "string", description: p.description ?? "" };
        if (p.required) required.push(pName);
      }

      tools.push({
        type: "function",
        function: {
          name:        `skill_${name}`,
          description: skill.description ?? `Custom skill: ${name}`,
          parameters:  { type: "object", properties: props, required },
        },
      });
      console.log(`[skills] Loaded skill_${name} (${file})`);
    } catch (e) {
      console.warn(`[skills] Failed to load ${file}: ${e}`);
    }
  }
  return tools;
}

let cachedCustomTools: OpenAI.Chat.ChatCompletionTool[] = [];

// ─── Markdown knowledge skills ───────────────────────────────────────────────

function loadMarkdownSkills(): string {
  if (!fs.existsSync(SKILLS_DIR)) return "";
  const parts: string[] = [];
  try {
    for (const file of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md") && !f.toLowerCase().startsWith("readme")).sort()) {
      try {
        const content = fs.readFileSync(path.join(SKILLS_DIR, file), "utf8").trim();
        if (content) parts.push(`### Skill: ${file.replace(/\.md$/, "")}\n\n${content}`);
      } catch (e) { console.warn(`[skills] Failed to load markdown ${file}: ${e}`); }
    }
  } catch {}
  return parts.join("\n\n---\n\n");
}

let cachedMarkdownSkills = "";

function fullSystemPrompt(): string {
  if (!cachedMarkdownSkills) return SYSTEM_PROMPT;
  return SYSTEM_PROMPT + "\n\n## Installed Knowledge Skills\n\n" + cachedMarkdownSkills;
}

// ─── MCP tool loader ──────────────────────────────────────────────────────────

const MCP_RUNNER_URL = "http://openclaw-mcp-runner:9000";

async function loadMcpTools(): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  try {
    const r = await axios.get(`${MCP_RUNNER_URL}/mcps`, { timeout: 5000, proxy: false });
    const mcps: Array<{ name: string; tools: Array<{ name: string; description: string; inputSchema: any }> }> =
      r.data.mcps ?? [];

    const tools: OpenAI.Chat.ChatCompletionTool[] = [];
    for (const mcp of mcps) {
      const mcpName = mcp.name ?? "";
      for (const tool of (mcp.tools ?? [])) {
        const tName = tool.name ?? "";
        if (!mcpName || !tName) continue;
        const fnName = `mcp_${mcpName}__${tName}`.replace(/-/g, "_");
        tools.push({
          type: "function",
          function: {
            name:        fnName,
            description: `[MCP: ${mcpName}] ${tool.description ?? ""}`,
            parameters:  tool.inputSchema ?? { type: "object", properties: {} },
          },
        });
      }
    }
    if (tools.length > 0) console.log(`[mcp] Loaded ${tools.length} tool(s) from ${mcps.length} MCP(s)`);
    return tools;
  } catch (e) {
    console.warn(`[mcp] Runner unreachable, skipping MCP tools: ${e}`);
    return [];
  }
}

let cachedMcpTools: OpenAI.Chat.ChatCompletionTool[] = [];

// ─── WP Abilities loader (WordPress 7.0 MCP Adapter) ─────────────────────────

let cachedWpAbilityTools: OpenAI.Chat.ChatCompletionTool[] = [];
const wpAbilityNameMap = new Map<string, string>(); // safe suffix → original ability name

/** POST JSON-RPC to the WP MCP Adapter, respecting proxy/NO_PROXY via httpRequest(). */
async function wpMcpPost(body: any, extraHeaders?: Record<string, string>, timeout = 15_000): Promise<any> {
  const auth = `Basic ${Buffer.from(`${WP_ADMIN_USER}:${WP_APP_PASSWORD}`).toString("base64")}`;
  return httpRequest({
    method: "POST", url: WP_MCP_ENDPOINT, data: body, timeout,
    headers: { "Content-Type": "application/json", Authorization: auth, ...extraHeaders },
  });
}

/** Open an MCP session with the WP MCP Adapter. Returns session headers. */
async function wpMcpSession(): Promise<Record<string, string>> {
  // Initialize — capture Mcp-Session-Id from response headers
  const initResp = await wpMcpPost({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05", capabilities: {},
      clientInfo: { name: "openclaw-agent", version: "1.0" },
    },
  });

  const sessionId = initResp.headers?.["mcp-session-id"] ?? "";
  const sessionHeaders = sessionId ? { "Mcp-Session-Id": sessionId } : {};

  // Send initialized notification
  await wpMcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders, 5_000).catch(() => {});

  return sessionHeaders;
}

/** Call an MCP tool on the WP Adapter within an existing session. */
async function wpMcpCall(
  sessionHeaders: Record<string, string>, toolName: string, args: Record<string, any>, id = 1,
): Promise<any> {
  const resp = await wpMcpPost({
    jsonrpc: "2.0", id, method: "tools/call",
    params: { name: toolName, arguments: args },
  }, sessionHeaders, 30_000);
  if (resp.data?.error) throw new Error(resp.data.error.message ?? JSON.stringify(resp.data.error));
  return resp.data?.result;
}

async function loadWpAbilities(): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  if (!WP_MCP_ENDPOINT || !WP_APP_PASSWORD) {
    console.warn("[wp-abilities] Skipped: WP_URL or WP_APP_PASSWORD not set");
    return [];
  }

  try {
    const sessionHeaders = await wpMcpSession();

    // Discover abilities via the MCP Adapter meta-tool
    const discoverResult = await wpMcpCall(sessionHeaders, "mcp-adapter-discover-abilities", {}, 2);
    const abilities: Array<{ name: string; label: string; description: string }> =
      discoverResult?.structuredContent?.abilities ?? JSON.parse(discoverResult?.content?.[0]?.text ?? "{}").abilities ?? [];

    if (abilities.length === 0) {
      console.log("[wp-abilities] No abilities discovered");
      return [];
    }

    // Get detailed info (input schema) for each ability
    wpAbilityNameMap.clear();
    const tools: OpenAI.Chat.ChatCompletionTool[] = [];
    for (const ability of abilities) {
      const safeSuffix = ability.name.replace(/[^a-zA-Z0-9_]/g, "_");
      const fnName = `wp_ability__${safeSuffix}`;
      wpAbilityNameMap.set(safeSuffix, ability.name);

      let inputSchema: any = { type: "object", properties: {} };
      try {
        const infoResult = await wpMcpCall(sessionHeaders, "mcp-adapter-get-ability-info", { ability_name: ability.name }, 3);
        const info = infoResult?.structuredContent ?? JSON.parse(infoResult?.content?.[0]?.text ?? "{}");
        if (info.input_schema) inputSchema = info.input_schema;
      } catch { /* use default schema */ }

      tools.push({
        type: "function",
        function: {
          name: fnName,
          description: `[WP Ability] ${ability.description || ability.label || ability.name}`,
          parameters: inputSchema,
        },
      });
    }

    console.log(`[wp-abilities] Loaded ${tools.length} tool(s): ${abilities.map(a => a.name).join(", ")}`);
    return tools;
  } catch (e: any) {
    console.warn(`[wp-abilities] Failed to load: ${e.message}`);
    return [];
  }
}

function getAllTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [...TOOLS, ...cachedCustomTools, ...cachedMcpTools, ...cachedWpAbilityTools];
}

// ─── Tool implementations ─────────────────────────────────────────────────────

const FORBIDDEN_COMMANDS = [
  "wp db drop", "wp db reset", "wp site empty",
  "wp eval", "wp eval-file", "wp shell",
  "rm -rf /", "mkfs", "dd if=",
  "> /dev/sda", "chmod 777 /",
];

function runCommand(command: string): string {
  if (!command || !command.trim()) return "ERROR: No command provided. Please specify a bash command to execute.";
  const cmdLower = command.toLowerCase();
  for (const f of FORBIDDEN_COMMANDS) {
    if (cmdLower.includes(f)) return `ERROR: Command '${f}' is blocked for safety reasons.`;
  }

  try {
    const result = spawnSync(command, {
      shell:    true,
      encoding: "utf8",
      timeout:  120_000,
      env:      { ...process.env, HOME: "/root" },
    });

    if (result.error) {
      const err = result.error as NodeJS.ErrnoException;
      if (err.code === "ETIMEDOUT") return "ERROR: Command timed out after 120 seconds.";
      return `ERROR: ${result.error.message}`;
    }

    let output = (result.stdout ?? "") + (result.stderr ?? "");
    if (output.length > MAX_OUTPUT_CHARS) {
      output = output.slice(0, MAX_OUTPUT_CHARS) + `\n... [truncated, ${output.length} total chars]`;
    }
    return output.trim() || "(command completed with no output)";
  } catch (e) {
    return `ERROR: ${e}`;
  }
}

const MAX_FETCH_CHARS = 20_000;

/** Strip noise from HTML to extract design-relevant content */
function cleanHtmlForDesign(raw: string): string {
  let html = raw;
  // Remove script tags and their content
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  // Remove noscript
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  // Remove SVG (often huge inline icons) — keep a marker
  html = html.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '<svg data-removed="true"/>');
  // Remove HTML comments (except WordPress block comments)
  html = html.replace(/<!--(?!\s*\/?wp:)[^]*?-->/g, "");
  // Remove data: URIs (base64 images bloat)
  html = html.replace(/data:[a-z/]+;base64,[A-Za-z0-9+/=]+/g, "data:removed");
  // Remove tracking pixels and ad iframes
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
  // Remove JSON-LD structured data
  html = html.replace(/<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
  // Remove link preloads/prefetches (noise for design analysis)
  html = html.replace(/<link\b[^>]*rel=["'](?:preload|prefetch|dns-prefetch|preconnect)["'][^>]*\/?>/gi, "");
  // Remove meta tags (keep charset and viewport only)
  html = html.replace(/<meta\b(?![^>]*(?:charset|viewport))[^>]*\/?>/gi, "");
  // Remove inline style attributes (we want structure, not inline CSS)
  html = html.replace(/\s+style="[^"]*"/gi, "");
  html = html.replace(/\s+style='[^']*'/gi, "");
  // Remove hidden elements
  html = html.replace(/<[^>]+(?:aria-hidden="true"|hidden)[^>]*>[\s\S]*?<\/[^>]+>/gi, "");
  // Remove empty class/id attributes
  html = html.replace(/\s+(?:class|id)=""/g, "");
  // Collapse excessive whitespace
  html = html.replace(/\n\s*\n\s*\n/g, "\n\n");
  html = html.replace(/[ \t]{4,}/g, "  ");
  return html.trim();
}

async function fetchPage(url: string): Promise<string> {
  try {
    const resp = await httpRequest({
      method: "get",
      url,
      timeout: 30_000,
      responseType: "text",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      maxRedirects: 5,
    });
    const rawHtml = typeof resp.data === "string" ? resp.data : String(resp.data);
    let html = cleanHtmlForDesign(rawHtml);
    if (html.length > MAX_FETCH_CHARS) {
      html = html.slice(0, MAX_FETCH_CHARS) + `\n\n... [truncated at ${MAX_FETCH_CHARS} chars, full page is ${rawHtml.length} chars]`;
    }
    return `<!-- Fetched from: ${url} -->\n<!-- Original size: ${rawHtml.length} chars, cleaned: ${html.length} chars -->\n\n${html}`;
  } catch (e: any) {
    const status = e?.response?.status;
    if (status) return `ERROR: HTTP ${status} fetching ${url}`;
    return `ERROR: ${e.message ?? e}`;
  }
}

async function wpRest(
  method: string,
  endpoint: string,
  body?: Record<string, any>,
  params?: Record<string, any>,
): Promise<string> {
  if (!WP_URL) return "ERROR: WP_URL not configured. Set it in .env";

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  let auth: { username: string; password: string } | undefined;

  if (WP_APP_PASSWORD) {
    headers["Authorization"] = `Basic ${Buffer.from(`${WP_ADMIN_USER}:${WP_APP_PASSWORD}`).toString("base64")}`;
  } else if (WP_ADMIN_PASSWORD) {
    auth = { username: WP_ADMIN_USER, password: WP_ADMIN_PASSWORD };
  }

  // Use host.docker.internal to bypass the proxy (WP is on the same Docker host)
  const baseUrl = "http://host.docker.internal";
  const url = baseUrl + "/wp-json" + endpoint;
  try {
    const resp = await axios.request({ method: method as any, url, data: body, params, headers, auth, timeout: 30_000, proxy: false });
    let text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
    if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS) + "... [truncated]";
    return `HTTP ${resp.status}\n${text}`;
  } catch (e: any) {
    if (e.response) {
      const txt = typeof e.response.data === "string" ? e.response.data : JSON.stringify(e.response.data);
      return `HTTP ${e.response.status}\n${txt.slice(0, MAX_OUTPUT_CHARS)}`;
    }
    return `ERROR: ${e.message}`;
  }
}

async function wpCliRemote(command: string): Promise<string> {
  if (!WP_URL || !BRIDGE_SECRET) return "ERROR: WP_URL or BRIDGE_SECRET not configured.";

  const url = WP_URL.replace(/\/$/, "") + "/wp-json/openclaw/v1/cli";
  try {
    const resp = await httpRequest({
      method:  "post",
      url,
      data:    { command },
      headers: { "X-OpenClaw-Secret": BRIDGE_SECRET, "Content-Type": "application/json" },
      timeout: 60_000,
    });
    const d = resp.data;
    return d.output ?? JSON.stringify(d);
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

function _simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) - h) + s.charCodeAt(i); h |= 0; }
  return Math.abs(h);
}

function scheduleTaskFn(task: string, runAt?: string, cronExpr?: string, label?: string): string {
  if (!runAt && !cronExpr) return "ERROR: Provide either run_at (ISO datetime) or cron (5-part expression).";

  const lbl   = (label ?? task.slice(0, 60)).trim();
  const jobId = `oc_${Math.floor(Date.now() / 1000)}_${_simpleHash(task) % 9999}`;

  try {
    if (cronExpr) {
      const parts = cronExpr.trim().split(/\s+/);
      if (parts.length !== 5) {
        return `ERROR: cron must have exactly 5 fields (minute hour day month weekday). Got ${parts.length}: '${cronExpr}'`;
      }
      const { nextRun } = scheduler.addJob(jobId, lbl, task, cronExpr);
      return `✅ Recurring task scheduled!\nLabel: ${lbl}\nID: \`${jobId}\`\nCron: \`${cronExpr}\`\nNext run: ${nextRun}\n\nCancel any time with: /tasks cancel ${jobId}`;
    } else {
      const dt = new Date(runAt!);
      if (isNaN(dt.getTime())) return `ERROR: Invalid datetime '${runAt}'`;
      const { nextRun } = scheduler.addJob(jobId, lbl, task, undefined, dt);
      return `✅ One-time task scheduled!\nLabel: ${lbl}\nID: \`${jobId}\`\nRuns at: ${nextRun} UTC\n\nCancel with: /tasks cancel ${jobId}`;
    }
  } catch (e) {
    return `ERROR scheduling task: ${e}`;
  }
}

async function dispatchSkill(toolName: string, args: Record<string, any>): Promise<string> {
  const rawName = toolName.replace(/^skill_/, "");
  if (!fs.existsSync(SKILLS_DIR)) return `ERROR: Custom skill '${rawName}' not found. Try /skill reload.`;

  let skillData: Record<string, any> | null = null;
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".yaml"));
    for (const file of files) {
      try {
        const s = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, file), "utf8")) as Record<string, any>;
        if (s && s.name === rawName) { skillData = s; break; }
      } catch {}
    }
  } catch {}

  if (!skillData) return `ERROR: Custom skill '${rawName}' not found. Try /skill reload.`;

  const skillType   = skillData.type ?? "command";
  const filteredArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "reason"));

  if (skillType === "command") {
    let cmd = skillData.command ?? "";
    for (const [k, v] of Object.entries(filteredArgs)) cmd = cmd.replace(`{${k}}`, String(v));
    return runCommand(cmd);
  }

  if (skillType === "http" || skillType === "webhook") {
    let url    = skillData.url ?? "";
    const method = (skillData.method ?? "GET").toUpperCase();
    for (const [k, v] of Object.entries(filteredArgs)) url = url.replace(`{${k}}`, String(v));
    const body = skillType === "webhook" ? filteredArgs : undefined;
    try {
      const resp = await httpRequest({ method, url, data: body, timeout: 30_000 });
      let text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS) + "... [truncated]";
      return `HTTP ${resp.status}\n${text}`;
    } catch (e: any) {
      return `ERROR in skill ${rawName}: ${e.message}`;
    }
  }

  return `ERROR: Unknown skill type '${skillType}' in ${rawName}.yaml`;
}

async function dispatchMcpTool(toolName: string, args: Record<string, any>): Promise<string> {
  const filteredArgs  = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "reason"));
  const withoutPrefix = toolName.slice("mcp_".length);
  const idx           = withoutPrefix.indexOf("__");
  if (idx < 0) return `ERROR: Malformed MCP tool name '${toolName}'`;

  const mcpNameU = withoutPrefix.slice(0, idx);
  const fnName   = withoutPrefix.slice(idx + 2);
  const mcpName  = mcpNameU.replace(/_/g, "-");

  try {
    let r = await axios.post(
      `${MCP_RUNNER_URL}/mcps/${mcpName}/call`,
      { tool: fnName, arguments: filteredArgs },
      { timeout: 60_000, proxy: false },
    );
    if (r.status === 404) {
      r = await axios.post(
        `${MCP_RUNNER_URL}/mcps/${mcpNameU}/call`,
        { tool: fnName, arguments: filteredArgs },
        { timeout: 60_000, proxy: false },
      );
      if (r.status === 404) return `ERROR: MCP '${mcpName}' not found. Install it with /mcp install.`;
    }
    const data = r.data;
    if (data.error) return `ERROR from MCP ${mcpName}: ${data.error}`;
    return String(data.result ?? "(no result)");
  } catch (e: any) {
    return `ERROR calling MCP tool ${toolName}: ${e.message}`;
  }
}

async function dispatchWpAbility(toolName: string, args: Record<string, any>): Promise<string> {
  if (!WP_MCP_ENDPOINT || !WP_APP_PASSWORD) {
    return "ERROR: WP_URL or WP_APP_PASSWORD not configured for WP Abilities.";
  }

  const filteredArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "reason"));
  const safeSuffix   = toolName.slice("wp_ability__".length);
  const abilityName  = wpAbilityNameMap.get(safeSuffix) ?? safeSuffix.replace(/_/g, "-");

  try {
    const sessionHeaders = await wpMcpSession();
    const result = await wpMcpCall(sessionHeaders, "mcp-adapter-execute-ability", {
      ability_name: abilityName, parameters: filteredArgs,
    });

    // Extract text from MCP response content array
    if (result?.structuredContent) return JSON.stringify(result.structuredContent);
    const content: Array<{ text?: string }> = result?.content ?? [];
    const text = content.map(c => c.text ?? JSON.stringify(c)).join("\n");
    return text || JSON.stringify(result ?? "(no result)");
  } catch (e: any) {
    if (e.response) {
      return `ERROR calling WP Ability: HTTP ${e.response.status} — ${JSON.stringify(e.response.data).slice(0, 500)}`;
    }
    return `ERROR calling WP Ability ${abilityName}: ${e.message}`;
  }
}

async function uploadMediaToWp(
  fileBytes: Buffer,
  filename: string,
  mimeType: string,
): Promise<{ id?: number; url?: string; error?: string }> {
  // ── Local mode: WP-CLI ────────────────────────────────────────────────────
  const wpExists = fs.existsSync(WP_PATH) && fs.readdirSync(WP_PATH).length > 0;
  if (wpExists) {
    const safeName = filename.replace(/[^\w.\-]/g, "_");
    const tmpPath  = `/tmp/openclaw-upload-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
    try {
      fs.writeFileSync(tmpPath, fileBytes);
      const result = spawnSync(
        `wp media import ${tmpPath} --porcelain --path=${WP_PATH} --allow-root`,
        { shell: true, encoding: "utf8", timeout: 60_000, env: { ...process.env, HOME: "/root" } },
      );
      const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
      let attachmentId: number | null = null;
      for (const token of output.split(/\s+/)) {
        if (/^\d+$/.test(token)) { attachmentId = parseInt(token, 10); break; }
      }
      if ((result.status !== 0 && result.status !== null) || attachmentId === null) {
        return { error: `WP-CLI media import failed: ${output.slice(0, 300)}` };
      }
      const urlResult = spawnSync(
        `wp post get ${attachmentId} --field=guid --path=${WP_PATH} --allow-root`,
        { shell: true, encoding: "utf8", timeout: 30_000, env: { ...process.env, HOME: "/root" } },
      );
      return { id: attachmentId, url: (urlResult.stdout ?? "").trim() };
    } catch (e) {
      return { error: String(e) };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }

  // ── Remote mode: REST API ─────────────────────────────────────────────────
  if (!WP_URL) return { error: "WP_URL not configured." };
  if (!WP_APP_PASSWORD && !WP_ADMIN_PASSWORD) {
    return { error: "No WordPress credentials configured for remote upload. Set WP_APP_PASSWORD in .env" };
  }

  const headers: Record<string, string> = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type":        mimeType,
  };
  let auth: { username: string; password: string } | undefined;
  if (WP_APP_PASSWORD) {
    headers["Authorization"] = `Basic ${Buffer.from(`${WP_ADMIN_USER}:${WP_APP_PASSWORD}`).toString("base64")}`;
  } else if (WP_ADMIN_PASSWORD) {
    auth = { username: WP_ADMIN_USER, password: WP_ADMIN_PASSWORD };
  }

  const url = WP_URL.replace(/\/$/, "") + "/wp-json/wp/v2/media";
  try {
    const resp = await httpRequest({ method: "post", url, data: fileBytes, headers, auth, timeout: 60_000 });
    const d = resp.data;
    return { id: d.id, url: d.source_url ?? d.guid?.rendered ?? "" };
  } catch (e: any) {
    if (e.response) return { error: `WordPress returned HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 300)}` };
    return { error: String(e.message) };
  }
}

function writeFile(filePath: string, content: string, append: boolean): string {
  if (!filePath || !filePath.startsWith("/tmp/")) return "ERROR: Can only write to /tmp/ directory.";
  if (!content) return "ERROR: No content provided.";
  try {
    if (append) {
      fs.appendFileSync(filePath, content, "utf8");
    } else {
      fs.writeFileSync(filePath, content, "utf8");
    }
    const stat = fs.statSync(filePath);
    return `OK: ${append ? "Appended to" : "Wrote"} ${filePath} (${stat.size} bytes total)`;
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

async function replyToForum(postId: number, content: string): Promise<string> {
  if (!postId || !content) return "ERROR: post_id and content are required.";
  try {
    const result = await wpRest("POST", "/wp/v2/comments", { post: postId, content, author_name: "AI Assistant" });
    if (typeof result === "object" && result.error) return `ERROR: ${result.error}`;
    const data = typeof result === "string" ? JSON.parse(result) : result;
    return `OK: Comment posted (id=${data.id ?? "?"}) on post ${postId}`;
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

async function dispatchTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "run_command")      return runCommand(args.command ?? "");
  if (name === "write_file")       return writeFile(args.path ?? "", args.content ?? "", args.append === true);
  if (name === "wp_rest")          return wpRest(args.method ?? "GET", args.endpoint ?? "/", args.body, args.params);
  if (name === "wp_cli_remote")    return wpCliRemote(args.command ?? "");
  if (name === "schedule_task")    return scheduleTaskFn(args.task ?? "", args.run_at, args.cron, args.label);
  if (name === "reply_to_forum")   return replyToForum(args.post_id ?? 0, args.content ?? "");
  if (name === "fetch_page")       return fetchPage(args.url ?? "");
  if (name.startsWith("skill_"))      return dispatchSkill(name, args);
  if (name.startsWith("mcp_"))        return dispatchMcpTool(name, args);
  if (name.startsWith("wp_ability__")) return dispatchWpAbility(name, args);
  return `ERROR: Unknown tool '${name}'`;
}

function toolLabel(fnName: string, fnArgs: Record<string, any>): string {
  const reason = (fnArgs.reason ?? "").trim();
  if (fnName === "run_command") {
    if (reason) return `🖥 ${reason.slice(0, 120)}`;
    const cmd = fnArgs.command ?? "";
    let firstLine = "";
    for (const line of cmd.split("\n")) {
      const stripped = line.trim();
      if (stripped && !stripped.startsWith("#")) { firstLine = stripped; break; }
    }
    return `🖥 ${(firstLine || cmd.replace(/\s+/g, " ")).slice(0, 110) || "(command)"}`;
  }
  if (fnName === "wp_rest")       return reason ? `🌐 ${reason.slice(0, 120)}` : `🌐 ${fnArgs.method ?? "GET"} ${fnArgs.endpoint ?? ""}`;
  if (fnName === "wp_cli_remote") return reason ? `🔧 ${reason.slice(0, 120)}` : `🔧 wp ${(fnArgs.command ?? "").slice(0, 100)}`;
  if (fnName === "schedule_task") return reason ? `⏰ ${reason.slice(0, 120)}` : `⏰ Scheduling: ${(fnArgs.label ?? fnArgs.task ?? "").slice(0, 80)}`;
  if (fnName === "write_file")    return reason ? `📝 ${reason.slice(0, 120)}` : `📝 Writing: ${(fnArgs.path ?? "").slice(0, 100)}`;
  if (fnName === "reply_to_forum") return reason ? `💬 ${reason.slice(0, 120)}` : `💬 Replying to forum post ${fnArgs.post_id ?? ""}`;
  if (fnName === "fetch_page")    return reason ? `🌍 ${reason.slice(0, 120)}` : `🌍 Fetching: ${(fnArgs.url ?? "").slice(0, 100)}`;
  if (fnName.startsWith("skill_"))      return reason ? `🔌 ${reason.slice(0, 120)}` : `🔌 Skill: ${fnName.replace(/^skill_/, "")}`;
  if (fnName.startsWith("wp_ability__")) return reason ? `🔮 ${reason.slice(0, 120)}` : `🔮 WP: ${fnName.slice("wp_ability__".length).replace(/_/g, " ")}`;
  return `⚙️ ${reason || fnName}`;
}

// ─── Scheduler helpers ────────────────────────────────────────────────────────

async function notifyTelegram(text: string): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_ADMIN_USER_ID) {
    console.warn("[notify] Telegram notify skipped: BOT_TOKEN or ADMIN_USER_ID not set");
    return;
  }
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n…[truncated]" : text;
  for (const uid of TELEGRAM_ADMIN_USER_ID.split(",").map(s => s.trim()).filter(Boolean)) {
    try {
      await httpRequest({
        method:  "post",
        url:     `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        data:    { chat_id: uid, text: truncated, parse_mode: "Markdown" },
        timeout: 15_000,
      });
    } catch (e) {
      console.warn(`[notify] Telegram notify failed for user ${uid}: ${e}`);
    }
  }
}

async function executeScheduledTask(taskLabel: string, taskText: string): Promise<void> {
  console.log(`[scheduler] Running: ${taskLabel}`);
  let resultText = "(no result)";
  let elapsed    = 0;
  try {
    for await (const event of runAgent(taskText)) {
      if (event.type === "result") {
        resultText = event.text ?? "(no result)";
        elapsed    = event.elapsed ?? 0;
      }
    }
  } catch (e) {
    resultText = `❌ Scheduled task error: ${e}`;
    console.error(`[scheduler] Error in '${taskLabel}': ${e}`);
  }
  console.log(`[scheduler] Done: ${taskLabel} in ${elapsed}s`);
  await notifyTelegram(`⏰ *Scheduled task complete:* _${taskLabel}_\n\n${resultText}`);
}

// ─── Agentic loop ─────────────────────────────────────────────────────────────

interface AgentEvent {
  type: "thinking" | "progress" | "result";
  text?: string;
  elapsed?: number;
  model?: string;
}

interface ChatMessage { role: string; content: string; }

async function* runAgent(
  userMessage: string,
  model: string = DEFAULT_MODEL,
  history: ChatMessage[] = [],
): AsyncGenerator<AgentEvent> {
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...history.map(h => ({ role: h.role as "user" | "assistant" | "system", content: h.content })),
    { role: "user", content: userMessage },
  ];

  let systemInjected = false;
  const start        = Date.now();
  let steps          = 0;
  let consecutiveErrors = 0;
  let recentErrors: string[] = [];  // collect last few error messages
  let lastToolSig    = "";          // detect repeated identical tool calls
  let repeatCount    = 0;
  const allTools     = getAllTools();
  // Pick a fallback from the same provider family
  const fallback     = model.startsWith("openrouter/") ? OR_FALLBACK_MODEL : FALLBACK_MODEL;

  while (steps < MAX_STEPS) {
    steps++;
    yield { type: "thinking" };

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools:       allTools,
        tool_choice: "auto",
        // @ts-ignore — LiteLLM extension: system passed as extra field
        system:      fullSystemPrompt(),
        max_tokens:  16384,
      } as any);
    } catch (firstErr: any) {
      // Some providers don't accept the non-standard 'system' kwarg; prepend it
      if (firstErr?.message?.includes("system") && !systemInjected) {
        messages.unshift({ role: "system", content: fullSystemPrompt() });
        systemInjected = true;
        try {
          response = await client.chat.completions.create({
            model, messages, tools: allTools, tool_choice: "auto", max_tokens: 8192,
          } as any);
        } catch (e2: any) {
          const err2 = String(e2.message ?? e2);
          if (model !== fallback) {
            console.warn(`[agent] Model ${model} failed (${err2}), trying ${fallback}`);
            yield* runAgent(userMessage, fallback, history);
            return;
          }
          yield { type: "result", text: `AI service error: ${err2}`, elapsed: (Date.now() - start) / 1000, model };
          return;
        }
      } else {
        const err = String(firstErr.message ?? firstErr);
        if (model !== fallback) {
          console.warn(`[agent] Model ${model} failed (${err}), trying ${fallback}`);
          yield* runAgent(userMessage, fallback, history);
          return;
        }
        yield { type: "result", text: `AI service error: ${err}`, elapsed: (Date.now() - start) / 1000, model };
        return;
      }
    }

    if (!response.choices?.length) {
      yield { type: "result", text: "AI service returned an empty response.", elapsed: (Date.now() - start) / 1000, model };
      return;
    }

    const choice = response.choices[0];
    console.log(`[agent] Step ${steps}: finish_reason=${choice.finish_reason}, tool_calls=${choice.message?.tool_calls?.length ?? 0}, content_len=${choice.message?.content?.length ?? 0}`);

    // Detect output truncation — response was cut off mid-generation
    if (choice.finish_reason === "length") {
      console.warn(`[agent] Response truncated (finish_reason=length) at step ${steps}`);
      messages.push({
        role: "system",
        content: "YOUR PREVIOUS RESPONSE WAS TRUNCATED because it exceeded the output limit. " +
          "You MUST split your work into smaller pieces. When writing HTML files, write the CSS/first section " +
          "with `cat > /tmp/file.html <<'EOF'`, then append more with `cat >> /tmp/file.html <<'EOF'`. " +
          "Each command must be SHORT ENOUGH to fit in a single response. Try again with a smaller chunk.",
      } as any);
      yield { type: "progress", text: "⚠️ Output was truncated, retrying with smaller chunks…" };
      continue;  // retry the step
    }

    const msg = choice.message;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls } as any);

    if (!msg.tool_calls?.length) {
      yield { type: "result", text: msg.content ?? "(no response)", elapsed: (Date.now() - start) / 1000, model };
      return;
    }

    let stepHadError = false;
    for (const tc of msg.tool_calls) {
      const fnName = tc.function.name;
      const rawArgs = tc.function.arguments ?? "";
      let fnArgs: Record<string, any> = {};
      try { fnArgs = JSON.parse(rawArgs || "{}"); } catch (parseErr) {
        console.warn(`[agent] Failed to parse tool args for ${fnName}: ${String(parseErr).slice(0, 100)}`);
        console.warn(`[agent] Raw args (first 200 chars): ${rawArgs.slice(0, 200)}`);
      }
      if (fnName === "run_command" && !fnArgs.command) {
        console.warn(`[agent] Empty command! Raw args length: ${rawArgs.length}, starts with: ${rawArgs.slice(0, 200)}`);
        console.warn(`[agent] Assistant content: ${(msg.content ?? "(none)").slice(0, 500)}`);
        console.warn(`[agent] All tool_calls: ${JSON.stringify(msg.tool_calls?.map(t => ({ name: t.function.name, argsLen: t.function.arguments?.length ?? 0 })))}`);
      }

      yield { type: "progress", text: toolLabel(fnName, fnArgs) };

      console.log(`[agent] Tool call: ${fnName}(${Object.keys(fnArgs).join(", ")})`);
      const toolResult = await dispatchTool(fnName, fnArgs);
      console.log(`[agent]   → ${String(toolResult).slice(0, 200)}`);

      messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult } as any);

      // Track errors
      if (String(toolResult).startsWith("ERROR")) {
        stepHadError = true;
        recentErrors.push(`${fnName}: ${String(toolResult).slice(0, 300)}`);
        if (recentErrors.length > 6) recentErrors.shift();
      }

      // Track repeated identical calls (sign of a loop)
      const sig = `${fnName}:${tc.function.arguments ?? ""}`;
      if (sig === lastToolSig) {
        repeatCount++;
      } else {
        lastToolSig = sig;
        repeatCount = 0;
      }
    }

    // Consecutive error detection — bail if 4+ steps in a row all errored
    consecutiveErrors = stepHadError ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 4) {
      console.warn(`[agent] Bailing: ${consecutiveErrors} consecutive error steps`);
      const errorDetail = recentErrors.length
        ? "\n\nErrors encountered:\n" + recentErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")
        : "";
      yield {
        type: "result",
        text: `I've encountered errors on ${consecutiveErrors} consecutive attempts and stopped to avoid wasting time.${errorDetail}\n\nPlease check the approach and try again with more specific instructions.`,
        elapsed: (Date.now() - start) / 1000, model,
      };
      return;
    }

    // Repeated tool call detection — bail if same exact call 3+ times
    if (repeatCount >= 3) {
      const repeatedAction = lastToolSig.split(":")[0] || "unknown";
      console.warn(`[agent] Bailing: same tool call repeated ${repeatCount + 1} times (${repeatedAction})`);
      yield {
        type: "result",
        text: `I got stuck in a loop — repeated the same "${repeatedAction}" call ${repeatCount + 1} times. Could you rephrase what you'd like me to do?`,
        elapsed: (Date.now() - start) / 1000, model,
      };
      return;
    }

    // Budget warning — inject a nudge when getting close to step limit
    if (steps === MAX_STEPS - 3) {
      messages.push({
        role: "system",
        content: "WARNING: You are running low on steps (3 remaining). Wrap up now: finish the current operation, report what you've done, and stop. Do NOT start new searches or explorations.",
      } as any);
    }
  }

  yield {
    type:    "result",
    text:    "Reached the maximum number of steps. The task may be partially complete.",
    elapsed: (Date.now() - start) / 1000,
    model,
  };
}

// ─── Express app ──────────────────────────────────────────────────────────────

const expressApp = express();
expressApp.use(express.json({ limit: "1mb" }));
const upload = multer({ storage: multer.memoryStorage() });

expressApp.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    model:           DEFAULT_MODEL,
    scheduler:       scheduler.running ? "running" : "stopped",
    scheduled_jobs:  scheduler.jobCount,
    custom_skills:   cachedCustomTools.length,
    mcp_tools:       cachedMcpTools.length,
    wp_ability_tools: cachedWpAbilityTools.length,
    whisper:         whisperClient ? "available" : "unavailable (set OPENAI_API_KEY)",
  });
});

expressApp.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) { res.status(400).json({ error: "No file in request" }); return; }
  const result = await uploadMediaToWp(req.file.buffer, req.file.originalname ?? "upload.jpg", req.file.mimetype ?? "image/jpeg");
  if (result.error) { res.status(502).json(result); return; }
  res.json(result);
});

expressApp.post("/transcribe", upload.single("file"), async (req: Request, res: Response) => {
  if (!whisperClient) {
    res.status(503).json({ error: "Voice transcription unavailable. Add OPENAI_API_KEY to .env to enable Whisper." });
    return;
  }
  if (!req.file) { res.status(400).json({ error: "No audio file provided (field: 'file')" }); return; }

  const audioBuffer = req.file.buffer;
  const filename    = req.file.originalname ?? "voice.ogg";
  const contentType = req.file.mimetype ?? "audio/ogg";

  try {
    const transcript = await whisperClient.audio.transcriptions.create({
      model: "whisper-1",
      file:  await toFile(audioBuffer, filename, { type: contentType }),
    });
    console.log(`[transcribe] ${audioBuffer.length}B → ${transcript.text.slice(0, 80)}`);
    res.json({ text: transcript.text });
  } catch (e) {
    console.error(`[transcribe] Whisper failed: ${e}`);
    res.status(502).json({ error: `Transcription failed: ${e}` });
  }
});

expressApp.post("/task", async (req: Request, res: Response) => {
  const { message = "", model = DEFAULT_MODEL, history = [] } = req.body ?? {};
  const trimmedHistory = history.length > 20 ? history.slice(-20) : history;

  if (!String(message).trim()) { res.status(400).json({ error: "No message provided" }); return; }

  console.log(`[agent] Task received: ${String(message).slice(0, 100)}`);

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    for await (const event of runAgent(String(message).trim(), model, trimmedHistory)) {
      res.write(JSON.stringify(event) + "\n");
      if (event.type === "result") console.log(`[agent] Task done in ${event.elapsed}s`);
    }
  } catch (e) {
    console.error("[agent] Unhandled exception in streaming generator:", e);
    res.write(JSON.stringify({ type: "result", text: `❌ Internal agent error: ${e}`, elapsed: 0, model }) + "\n");
  }
  res.end();
});

// ─── Inbound webhook (generic — forum, github, slack, etc.) ──────────────────

expressApp.post("/inbound", async (req: Request, res: Response) => {
  // Optional secret validation
  if (INBOUND_SECRET) {
    const provided = req.headers["x-webhook-secret"] ?? req.body?.secret;
    if (provided !== INBOUND_SECRET) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }
  }

  const {
    channel   = "unknown",   // "forum", "github", "slack", etc.
    event     = "message",   // "new_post", "new_comment", "push", etc.
    thread_id = "",          // unique ID for conversation continuity
    author    = {},          // { name, email, role }
    content   = "",          // the message text
    title     = "",          // post/PR title
    images    = [],          // array of image URLs
    metadata  = {},          // any extra data (post_id, category, link, etc.)
    model: reqModel,         // optional model override
    auto_respond = true,     // if true, run the agent to generate a response
  } = req.body ?? {};

  if (!content && !title) {
    res.status(400).json({ error: "No content or title provided" });
    return;
  }

  const threadKey = thread_id || `${channel}_${Date.now()}`;
  console.log(`[inbound] ${channel}/${event} thread=${threadKey} author=${author?.name ?? "?"}`);

  // Build the message the agent will see
  const contextParts: string[] = [
    `[Inbound message from ${channel}]`,
    `Event: ${event}`,
  ];
  if (title)       contextParts.push(`Title: ${title}`);
  if (author?.name) contextParts.push(`Author: ${author.name}${author.role ? ` (${author.role})` : ""}`);
  if (metadata?.link)     contextParts.push(`Link: ${metadata.link}`);
  if (metadata?.post_id)  contextParts.push(`Post ID: ${metadata.post_id}`);
  if (metadata?.category) contextParts.push(`Category: ${metadata.category}`);
  if (content)     contextParts.push(`\nContent:\n${content}`);
  if (images?.length) contextParts.push(`\nAttached images: ${images.join(", ")}`);

  const userMessage = contextParts.join("\n");

  // Save to thread history
  appendToThread(channel, threadKey, "user", userMessage);

  // Forward to Telegram as CRM notification
  const tgNotification = [
    `📩 *Inbound: ${channel}* (${event})`,
    title ? `📝 ${title}` : "",
    author?.name ? `👤 ${author.name}` : "",
    metadata?.link ? `🔗 ${metadata.link}` : "",
    content ? `\n${content.slice(0, 500)}${content.length > 500 ? "…" : ""}` : "",
  ].filter(Boolean).join("\n");
  notifyTelegram(tgNotification).catch(() => {});

  // If auto_respond is false, just acknowledge receipt
  if (!auto_respond) {
    res.json({
      status: "received",
      thread_id: threadKey,
      message: "Event received and forwarded to Telegram.",
    });
    return;
  }

  // Run the agent with thread history for context
  const thread = getThread(channel, threadKey);
  const model = reqModel ?? DEFAULT_MODEL;

  // Build history from thread (exclude the current message — it's in userMessage)
  const history = thread.history.slice(0, -1).map(h => ({
    role: h.role,
    content: h.content,
  }));

  // Stream the agent response
  res.setHeader("Content-Type", "application/json");

  let resultText = "(no response)";
  let elapsed = 0;
  try {
    for await (const event of runAgent(userMessage, model, history)) {
      if (event.type === "result") {
        resultText = event.text ?? "(no response)";
        elapsed = event.elapsed ?? 0;
      }
    }
  } catch (e) {
    resultText = `Agent error: ${e}`;
    console.error(`[inbound] Agent error: ${e}`);
  }

  // Save agent response to thread
  appendToThread(channel, threadKey, "assistant", resultText);
  console.log(`[inbound] Response for ${channel}/${threadKey} in ${elapsed}s`);

  // Notify Telegram of the agent's response
  if (resultText && resultText !== "(no response)") {
    const tgResponse = `🤖 *Agent replied* (${channel}/${event}):\n${resultText.slice(0, 3500)}`;
    notifyTelegram(tgResponse).catch(() => {});
  }

  res.json({
    status: "ok",
    thread_id: threadKey,
    response: resultText,
    elapsed,
    model,
  });
});

expressApp.get("/schedules", (_req, res) => {
  res.json({ jobs: scheduler.getJobs() });
});

expressApp.delete("/schedules/:jobId", (req, res) => {
  try {
    scheduler.removeJob(req.params.jobId);
    res.json({ status: "cancelled", id: req.params.jobId });
  } catch (e) {
    res.status(404).json({ error: String(e) });
  }
});

expressApp.get("/skills", (_req, res) => {
  let mdNames: string[] = [];
  try { mdNames = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".md")).map(f => f.replace(/\.md$/, "")).sort(); } catch {}
  const scriptsDir = path.join(SKILLS_DIR, "scripts");
  let scriptNames: string[] = [];
  try { scriptNames = fs.readdirSync(scriptsDir).filter(f => f.endsWith(".js")).map(f => f.replace(/\.js$/, "")).sort(); } catch {}
  res.json({
    builtin:  TOOLS.map(t => t.function.name),
    custom:   cachedCustomTools.map(t => t.function.name),
    markdown: mdNames,
    scripts:  scriptNames,
    count:    TOOLS.length + cachedCustomTools.length + mdNames.length + scriptNames.length,
  });
});

expressApp.post("/reload-skills", (_req, res) => {
  const oldCount    = cachedCustomTools.length;
  cachedCustomTools = loadCustomSkills();
  cachedMarkdownSkills = loadMarkdownSkills();
  res.json({ loaded: cachedCustomTools.length, previous: oldCount, skills: cachedCustomTools.map(t => t.function.name) });
});

// ─── Skill CRUD ────────────────────────────────────────────────────────────────

const BUILTIN_TOOL_NAMES      = new Set(["run_command", "write_file", "wp_rest", "wp_cli_remote", "schedule_task", "reply_to_forum"]);
const FORBIDDEN_SKILL_COMMANDS = [
  "wp db drop", "wp db reset", "wp site empty", "wp eval", "wp eval-file", "wp shell",
  "rm -rf /", "mkfs", "dd if=", "> /dev/sda", "chmod 777 /",
];

function validateSkillYaml(raw: string): Record<string, any> | string {
  let skill: Record<string, any>;
  try {
    skill = yaml.load(raw) as Record<string, any>;
  } catch (e) {
    return `Invalid YAML: ${e}`;
  }
  if (!skill || typeof skill !== "object") return "YAML must be a mapping (key: value) at the top level.";

  const name = (skill.name ?? "").trim();
  if (!name)                           return "Missing required field: name";
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return "Skill name must contain only letters, numbers, and underscores.";
  if (BUILTIN_TOOL_NAMES.has(name))   return `Name '${name}' conflicts with a built-in tool. Choose a different name.`;

  const skillType = (skill.type ?? "").trim();
  if (!["command", "http", "webhook"].includes(skillType)) return "Field 'type' must be one of: command, http, webhook";

  if (skillType === "command") {
    const cmd = (skill.command ?? "").trim();
    if (!cmd) return "Field 'command' is required for type: command";
    const cmdLower = cmd.toLowerCase();
    for (const f of FORBIDDEN_SKILL_COMMANDS) if (cmdLower.includes(f)) return `Command contains blocked operation: '${f}'`;
  }
  if (skillType === "http" || skillType === "webhook") {
    if (!(skill.url ?? "").trim()) return "Field 'url' is required for type: http/webhook";
  }

  return skill;
}

expressApp.get("/skills/:name", (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) { res.status(400).json({ error: "Invalid skill name" }); return; }
  if (!fs.existsSync(SKILLS_DIR))    { res.status(404).json({ error: "Skills directory not found" }); return; }

  // Check script skill
  const jsPath = path.join(SKILLS_DIR, "scripts", `${name}.js`);
  if (fs.existsSync(jsPath)) {
    const content = fs.readFileSync(jsPath, "utf8");
    res.json({ name, type: "script", content });
    return;
  }

  // Check markdown skill
  const mdPath = path.join(SKILLS_DIR, `${name}.md`);
  if (fs.existsSync(mdPath)) {
    const content = fs.readFileSync(mdPath, "utf8");
    res.json({ name, type: "markdown", content });
    return;
  }

  // Check YAML skills
  try {
    for (const file of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".yaml"))) {
      const raw   = fs.readFileSync(path.join(SKILLS_DIR, file), "utf8");
      const skill = yaml.load(raw) as Record<string, any>;
      if (skill?.name === name) { res.json({ name, type: "yaml", yaml: raw }); return; }
    }
  } catch {}
  res.status(404).json({ error: `Skill '${name}' not found` });
});

expressApp.post("/skills", (req, res) => {
  const body = req.body ?? {};

  // ── Markdown skill (knowledge document) ──────────────────────────────
  const mdContent = String(body.markdown ?? "").trim();
  const mdName    = String(body.name ?? "").trim();
  if (mdContent) {
    if (!mdName) { res.status(400).json({ error: "Markdown skills require a 'name' field" }); return; }
    if (!/^[a-zA-Z0-9_-]+$/.test(mdName)) { res.status(400).json({ error: "Name must be alphanumeric (plus _ and -)" }); return; }
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const filePath = path.join(SKILLS_DIR, `${mdName}.md`);
    fs.writeFileSync(filePath, mdContent);
    cachedMarkdownSkills = loadMarkdownSkills();
    console.log(`[skills] Markdown skill created/updated: ${mdName}`);
    res.json({ status: "created", name: mdName, type: "markdown", file: `${mdName}.md` });
    return;
  }

  // ── JavaScript script skill (auto-wrapped as command tool) ──────────
  const scriptContent = String(body.script ?? "").trim();
  const scriptName    = String(body.name ?? "").trim();
  if (scriptContent && scriptName) {
    if (!/^[a-zA-Z0-9_-]+$/.test(scriptName)) { res.status(400).json({ error: "Name must be alphanumeric (plus _ and -)" }); return; }
    const scriptsDir = path.join(SKILLS_DIR, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, `${scriptName}.js`), scriptContent);
    // Auto-generate companion YAML tool
    const companionYaml = yaml.dump({
      name: scriptName,
      type: "command",
      description: `Run the ${scriptName}.js script. Accepts an input file path. `
        + "For HTML-to-block conversion, write HTML to a temp file first, "
        + "then pass the file path. Output is the converted result.",
      command: `node /app/config/skills/scripts/${scriptName}.js {input_file}`,
      parameters: [{ name: "input_file", description: "Path to the input file (e.g. /tmp/input.html)", type: "string", required: true }],
    });
    fs.writeFileSync(path.join(SKILLS_DIR, `${scriptName}.yaml`), companionYaml);
    cachedCustomTools = loadCustomSkills();
    console.log(`[skills] Script skill created: ${scriptName} (js + yaml wrapper)`);
    res.json({ status: "created", name: scriptName, type: "script", tool_name: `skill_${scriptName}`, file: `${scriptName}.js` });
    return;
  }

  // ── YAML skill (callable tool) ───────────────────────────────────────
  const raw = String(body.yaml ?? "").trim();
  if (!raw) { res.status(400).json({ error: "Request body must include 'yaml', 'markdown', or 'script' field" }); return; }

  const result = validateSkillYaml(raw);
  if (typeof result === "string") { res.status(400).json({ error: result }); return; }

  const name = result.name;
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, `${name}.yaml`), raw);
  cachedCustomTools = loadCustomSkills();
  console.log(`[skills] Created/updated: ${name}`);
  res.json({ status: "created", name, tool_name: `skill_${name}`, file: `${name}.yaml` });
});

expressApp.delete("/skills/:name", (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) { res.status(400).json({ error: "Invalid skill name" }); return; }
  if (!fs.existsSync(SKILLS_DIR))    { res.status(404).json({ error: "Skills directory not found" }); return; }

  try {
    // Check for script skill (js + companion yaml)
    const jsPath = path.join(SKILLS_DIR, "scripts", `${name}.js`);
    if (fs.existsSync(jsPath)) {
      fs.unlinkSync(jsPath);
      const companion = path.join(SKILLS_DIR, `${name}.yaml`);
      if (fs.existsSync(companion)) fs.unlinkSync(companion);
      cachedCustomTools = loadCustomSkills();
      console.log(`[skills] Script skill deleted: ${name}`);
      res.json({ status: "deleted", name });
      return;
    }

    // Check for markdown skill
    const mdPath = path.join(SKILLS_DIR, `${name}.md`);
    if (fs.existsSync(mdPath)) {
      fs.unlinkSync(mdPath);
      cachedMarkdownSkills = loadMarkdownSkills();
      console.log(`[skills] Markdown skill deleted: ${name}`);
      res.json({ status: "deleted", name });
      return;
    }

    // Check YAML skills
    let found: string | null = null;
    for (const file of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".yaml"))) {
      const s = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, file), "utf8")) as Record<string, any>;
      if (s?.name === name) { found = file; break; }
    }
    if (!found) { res.status(404).json({ error: `Skill '${name}' not found` }); return; }
    fs.unlinkSync(path.join(SKILLS_DIR, found));
    cachedCustomTools = loadCustomSkills();
    console.log(`[skills] Deleted: ${name}`);
    res.json({ status: "deleted", name });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ─── MCP proxy endpoints ──────────────────────────────────────────────────────

async function mcpProxy(method: string, mcpPath: string, body?: any, timeout = 120_000) {
  return axios.request({ method, url: `${MCP_RUNNER_URL}${mcpPath}`, data: body, timeout, proxy: false });
}

expressApp.get("/mcps", async (_req, res) => {
  try { const r = await mcpProxy("get", "/mcps", undefined, 10_000); res.status(r.status).json(r.data); }
  catch (e: any) { res.status(503).json({ error: `MCP runner unreachable: ${e.message}` }); }
});

expressApp.post("/mcps/install", async (req, res) => {
  try {
    const r = await mcpProxy("post", "/mcps/install", req.body, 120_000);
    if (r.status === 200 && !r.data.error) cachedMcpTools = await loadMcpTools();
    res.status(r.status).json(r.data);
  } catch (e: any) { res.status(503).json({ error: `MCP runner unreachable: ${e.message}` }); }
});

expressApp.delete("/mcps/:name", async (req, res) => {
  try {
    const r = await mcpProxy("delete", `/mcps/${req.params.name}`, undefined, 15_000);
    if (r.status === 200) cachedMcpTools = await loadMcpTools();
    res.status(r.status).json(r.data);
  } catch (e: any) { res.status(503).json({ error: `MCP runner unreachable: ${e.message}` }); }
});

expressApp.get("/mcps/:name/tools", async (req, res) => {
  try { const r = await mcpProxy("get", `/mcps/${req.params.name}/tools`, undefined, 10_000); res.status(r.status).json(r.data); }
  catch (e: any) { res.status(503).json({ error: `MCP runner unreachable: ${e.message}` }); }
});

expressApp.post("/reload-mcps", async (_req, res) => {
  const oldCount = cachedMcpTools.length;
  cachedMcpTools = await loadMcpTools();
  res.json({ loaded: cachedMcpTools.length, previous: oldCount, tools: cachedMcpTools.map(t => t.function.name) });
});

expressApp.post("/reload-wp-abilities", async (_req, res) => {
  const oldCount = cachedWpAbilityTools.length;
  cachedWpAbilityTools = await loadWpAbilities();
  res.json({ loaded: cachedWpAbilityTools.length, previous: oldCount, tools: cachedWpAbilityTools.map(t => t.function.name) });
});

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadThreads();

  cachedCustomTools = loadCustomSkills();
  console.log(`[agent] Custom skills loaded: ${cachedCustomTools.length}`);

  cachedMarkdownSkills = loadMarkdownSkills();
  console.log(`[agent] Markdown knowledge loaded: ${cachedMarkdownSkills.length} chars`);

  cachedMcpTools = await loadMcpTools();
  console.log(`[agent] MCP tools loaded: ${cachedMcpTools.length}`);

  cachedWpAbilityTools = await loadWpAbilities();
  console.log(`[agent] WP Ability tools loaded: ${cachedWpAbilityTools.length}`);

  scheduler.start();
  console.log(`[scheduler] Started — pending jobs: ${scheduler.jobCount}`);

  expressApp.listen(PORT, "0.0.0.0", () => {
    console.log(`[agent] Listening on port ${PORT}`);
  });
}

main().catch(console.error);
