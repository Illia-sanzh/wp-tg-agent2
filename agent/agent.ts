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
const FALLBACK_MODEL     = process.env.FALLBACK_MODEL     ?? "deepseek-chat";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const HTTPS_PROXY    = process.env.HTTPS_PROXY    ?? "";

const WP_PATH           = process.env.WP_PATH           ?? "/wordpress";
const WP_URL            = process.env.WP_URL            ?? "";
const WP_ADMIN_USER     = process.env.WP_ADMIN_USER     ?? "admin";
const WP_APP_PASSWORD   = process.env.WP_APP_PASSWORD   ?? "";
const WP_ADMIN_PASSWORD = process.env.WP_ADMIN_PASSWORD ?? "";
const BRIDGE_SECRET     = process.env.BRIDGE_SECRET     ?? "";
const SKILL_FILE        = process.env.SKILL_FILE        ?? "/app/SKILL.md";

const TELEGRAM_BOT_TOKEN     = process.env.TELEGRAM_BOT_TOKEN     ?? "";
const TELEGRAM_ADMIN_USER_ID = process.env.TELEGRAM_ADMIN_USER_ID ?? "";

const SKILLS_DIR  = "/app/config/skills";
const DATA_DIR    = "/app/data";
const SCHEDULE_DB = path.join(DATA_DIR, "schedules.db");

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
  timeout:    120_000,
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

## Custom Skills
Additional tool functions may be available below if YAML skill files are present in
openclaw-config/skills/. Use any loaded skill the same way as built-in tools.
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

function getAllTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [...TOOLS, ...cachedCustomTools, ...cachedMcpTools];
}

// ─── Tool implementations ─────────────────────────────────────────────────────

const FORBIDDEN_COMMANDS = [
  "wp db drop", "wp db reset", "wp site empty",
  "wp eval", "wp eval-file", "wp shell",
  "rm -rf /", "mkfs", "dd if=",
  "> /dev/sda", "chmod 777 /",
];

function runCommand(command: string): string {
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

  const url = WP_URL.replace(/\/$/, "") + "/wp-json" + endpoint;
  try {
    const resp = await httpRequest({ method: method as any, url, data: body, params, headers, auth, timeout: 30_000 });
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

async function dispatchTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "run_command")    return runCommand(args.command ?? "");
  if (name === "wp_rest")        return wpRest(args.method ?? "GET", args.endpoint ?? "/", args.body, args.params);
  if (name === "wp_cli_remote")  return wpCliRemote(args.command ?? "");
  if (name === "schedule_task")  return scheduleTaskFn(args.task ?? "", args.run_at, args.cron, args.label);
  if (name.startsWith("skill_")) return dispatchSkill(name, args);
  if (name.startsWith("mcp_"))   return dispatchMcpTool(name, args);
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
  if (fnName.startsWith("skill_")) return reason ? `🔌 ${reason.slice(0, 120)}` : `🔌 Skill: ${fnName.replace(/^skill_/, "")}`;
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
  const allTools     = getAllTools();

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
        system:      SYSTEM_PROMPT,
        max_tokens:  4096,
      } as any);
    } catch (firstErr: any) {
      // Some providers don't accept the non-standard 'system' kwarg; prepend it
      if (firstErr?.message?.includes("system") && !systemInjected) {
        messages.unshift({ role: "system", content: SYSTEM_PROMPT });
        systemInjected = true;
        try {
          response = await client.chat.completions.create({
            model, messages, tools: allTools, tool_choice: "auto", max_tokens: 4096,
          } as any);
        } catch (e2: any) {
          const err2 = String(e2.message ?? e2);
          if (model !== FALLBACK_MODEL) {
            console.warn(`[agent] Model ${model} failed (${err2}), trying ${FALLBACK_MODEL}`);
            yield* runAgent(userMessage, FALLBACK_MODEL, history);
            return;
          }
          yield { type: "result", text: `AI service error: ${err2}`, elapsed: (Date.now() - start) / 1000, model };
          return;
        }
      } else {
        const err = String(firstErr.message ?? firstErr);
        if (model !== FALLBACK_MODEL) {
          console.warn(`[agent] Model ${model} failed (${err}), trying ${FALLBACK_MODEL}`);
          yield* runAgent(userMessage, FALLBACK_MODEL, history);
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

    const msg = response.choices[0].message;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls } as any);

    if (!msg.tool_calls?.length) {
      yield { type: "result", text: msg.content ?? "(no response)", elapsed: (Date.now() - start) / 1000, model };
      return;
    }

    for (const tc of msg.tool_calls) {
      const fnName = tc.function.name;
      let fnArgs: Record<string, any> = {};
      try { fnArgs = JSON.parse(tc.function.arguments ?? "{}"); } catch {}

      yield { type: "progress", text: toolLabel(fnName, fnArgs) };

      console.log(`[agent] Tool call: ${fnName}(${Object.keys(fnArgs).join(", ")})`);
      const toolResult = await dispatchTool(fnName, fnArgs);
      console.log(`[agent]   → ${String(toolResult).slice(0, 200)}`);

      messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult } as any);
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
  res.json({
    builtin: TOOLS.map(t => t.function.name),
    custom:  cachedCustomTools.map(t => t.function.name),
    count:   TOOLS.length + cachedCustomTools.length,
  });
});

expressApp.post("/reload-skills", (_req, res) => {
  const oldCount    = cachedCustomTools.length;
  cachedCustomTools = loadCustomSkills();
  res.json({ loaded: cachedCustomTools.length, previous: oldCount, skills: cachedCustomTools.map(t => t.function.name) });
});

// ─── Skill CRUD ────────────────────────────────────────────────────────────────

const BUILTIN_TOOL_NAMES      = new Set(["run_command", "wp_rest", "wp_cli_remote", "schedule_task"]);
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
  if (!/^[a-zA-Z0-9_]+$/.test(name)) { res.status(400).json({ error: "Invalid skill name" }); return; }
  if (!fs.existsSync(SKILLS_DIR))    { res.status(404).json({ error: "Skills directory not found" }); return; }

  try {
    for (const file of fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith(".yaml"))) {
      const raw   = fs.readFileSync(path.join(SKILLS_DIR, file), "utf8");
      const skill = yaml.load(raw) as Record<string, any>;
      if (skill?.name === name) { res.json({ name, yaml: raw }); return; }
    }
  } catch {}
  res.status(404).json({ error: `Skill '${name}' not found` });
});

expressApp.post("/skills", (req, res) => {
  const raw = (req.body?.yaml ?? "").trim();
  if (!raw) { res.status(400).json({ error: "Request body must include 'yaml' field" }); return; }

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
  if (!/^[a-zA-Z0-9_]+$/.test(name)) { res.status(400).json({ error: "Invalid skill name" }); return; }
  if (!fs.existsSync(SKILLS_DIR))    { res.status(404).json({ error: "Skills directory not found" }); return; }

  try {
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

// ─── Startup ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  cachedCustomTools = loadCustomSkills();
  console.log(`[agent] Custom skills loaded: ${cachedCustomTools.length}`);

  cachedMcpTools = await loadMcpTools();
  console.log(`[agent] MCP tools loaded: ${cachedMcpTools.length}`);

  scheduler.start();
  console.log(`[scheduler] Started — pending jobs: ${scheduler.jobCount}`);

  expressApp.listen(PORT, "0.0.0.0", () => {
    console.log(`[agent] Listening on port ${PORT}`);
  });
}

main().catch(console.error);
