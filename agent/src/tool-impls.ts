import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import axios from "axios";
import {
  log,
  MAX_OUTPUT_CHARS,
  WP_PATH,
  WP_URL,
  WP_ADMIN_USER,
  WP_APP_PASSWORD,
  WP_ADMIN_PASSWORD,
  BRIDGE_SECRET,
  SEARXNG_URL,
  BROWSER_URL,
} from "./config";
import { state } from "./state";
import { httpRequest } from "./http";

export const FORBIDDEN_COMMANDS = [
  "wp db drop",
  "wp db reset",
  "wp site empty",
  "wp eval",
  "wp eval-file",
  "wp shell",
  "rm -rf /",
  "mkfs",
  "dd if=",
  "> /dev/sda",
  "chmod 777 /",
];

export function runCommand(command: string): string {
  if (!command || !command.trim()) return "ERROR: No command provided. Please specify a bash command to execute.";
  const cmdLower = command.toLowerCase();
  for (const f of FORBIDDEN_COMMANDS) {
    if (cmdLower.includes(f)) return `ERROR: Command '${f}' is blocked for safety reasons.`;
  }

  try {
    const result = spawnSync(command, {
      shell: true,
      encoding: "utf8",
      timeout: 120_000,
      env: { ...process.env, HOME: "/root" },
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

export function cleanHtmlForDesign(raw: string): string {
  let html = raw;
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "");
  html = html.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '<svg data-removed="true"/>');
  html = html.replace(/<!--(?!\s*\/?wp:)[^]*?-->/g, "");
  html = html.replace(/data:[a-z/]+;base64,[A-Za-z0-9+/=]+/g, "data:removed");
  html = html.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "");
  html = html.replace(/<script\s+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi, "");
  html = html.replace(/<link\b[^>]*rel=["'](?:preload|prefetch|dns-prefetch|preconnect)["'][^>]*\/?>/gi, "");
  html = html.replace(/<meta\b(?![^>]*(?:charset|viewport))[^>]*\/?>/gi, "");
  html = html.replace(/\s+style="[^"]*"/gi, "");
  html = html.replace(/\s+style='[^']*'/gi, "");
  html = html.replace(/<[^>]+(?:aria-hidden="true"|hidden)[^>]*>[\s\S]*?<\/[^>]+>/gi, "");
  html = html.replace(/\s+(?:class|id)=""/g, "");
  html = html.replace(/\n\s*\n\s*\n/g, "\n\n");
  html = html.replace(/[ \t]{4,}/g, "  ");
  return html.trim();
}

export async function fetchPage(url: string): Promise<string> {
  try {
    const resp = await httpRequest({
      method: "get",
      url,
      timeout: 30_000,
      responseType: "text",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      maxRedirects: 5,
    });
    const rawHtml = typeof resp.data === "string" ? resp.data : String(resp.data);
    let html = cleanHtmlForDesign(rawHtml);
    if (html.length > MAX_FETCH_CHARS) {
      html =
        html.slice(0, MAX_FETCH_CHARS) +
        `\n\n... [truncated at ${MAX_FETCH_CHARS} chars, full page is ${rawHtml.length} chars]`;
    }
    return `<!-- Fetched from: ${url} -->\n<!-- Original size: ${rawHtml.length} chars, cleaned: ${html.length} chars -->\n\n${html}`;
  } catch (e: any) {
    const status = e?.response?.status;
    if (status) return `ERROR: HTTP ${status} fetching ${url}`;
    return `ERROR: ${e.message ?? e}`;
  }
}

export async function wpRest(
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

  const baseUrl = "http://host.docker.internal";
  const url = baseUrl + "/wp-json" + endpoint;
  try {
    const resp = await axios.request({
      method: method as any,
      url,
      data: body,
      params,
      headers,
      auth,
      timeout: 30_000,
      proxy: false,
    });
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

export async function wpCliRemote(command: string): Promise<string> {
  if (!WP_URL || !BRIDGE_SECRET) return "ERROR: WP_URL or BRIDGE_SECRET not configured.";

  const url = WP_URL.replace(/\/$/, "") + "/wp-json/greenclaw/v1/cli";
  try {
    const resp = await httpRequest({
      method: "post",
      url,
      data: { command },
      headers: { "X-GreenClaw-Secret": BRIDGE_SECRET, "Content-Type": "application/json" },
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
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export function scheduleTaskFn(task: string, runAt?: string, cronExpr?: string, label?: string): string {
  if (!runAt && !cronExpr) return "ERROR: Provide either run_at (ISO datetime) or cron (5-part expression).";
  if (!state.scheduler) return "ERROR: Scheduler not initialized.";

  const lbl = (label ?? task.slice(0, 60)).trim();
  const jobId = `oc_${Math.floor(Date.now() / 1000)}_${_simpleHash(task) % 9999}`;

  try {
    if (cronExpr) {
      const parts = cronExpr.trim().split(/\s+/);
      if (parts.length !== 5) {
        return `ERROR: cron must have exactly 5 fields (minute hour day month weekday). Got ${parts.length}: '${cronExpr}'`;
      }
      const { nextRun } = state.scheduler.addJob(jobId, lbl, task, cronExpr);
      return `✅ Recurring task scheduled!\nLabel: ${lbl}\nID: \`${jobId}\`\nCron: \`${cronExpr}\`\nNext run: ${nextRun}\n\nCancel any time with: /tasks cancel ${jobId}`;
    } else {
      const dt = new Date(runAt!);
      if (isNaN(dt.getTime())) return `ERROR: Invalid datetime '${runAt}'`;
      const { nextRun } = state.scheduler.addJob(jobId, lbl, task, undefined, dt);
      return `✅ One-time task scheduled!\nLabel: ${lbl}\nID: \`${jobId}\`\nRuns at: ${nextRun} UTC\n\nCancel with: /tasks cancel ${jobId}`;
    }
  } catch (e) {
    return `ERROR scheduling task: ${e}`;
  }
}

export const WRITABLE_PATHS = [
  "/tmp/",
  `${WP_PATH}/wp-content/plugins/`,
  `${WP_PATH}/wp-content/themes/`,
  `${WP_PATH}/wp-content/mu-plugins/`,
];

export function writeFile(filePath: string, content: string, append: boolean): string {
  if (!filePath) return "ERROR: No file path provided.";
  const normalized = path.resolve(filePath);
  const allowed = WRITABLE_PATHS.some((p) => normalized.startsWith(path.resolve(p)));
  if (!allowed) return `ERROR: Can only write to: ${WRITABLE_PATHS.join(", ")}`;
  if (!content) return "ERROR: No content provided.";
  try {
    fs.mkdirSync(path.dirname(normalized), { recursive: true });
    if (append) {
      fs.appendFileSync(normalized, content, "utf8");
    } else {
      fs.writeFileSync(normalized, content, "utf8");
    }
    const stat = fs.statSync(normalized);
    return `OK: ${append ? "Appended to" : "Wrote"} ${normalized} (${stat.size} bytes total)`;
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

export async function replyToForum(postId: number, content: string): Promise<string> {
  if (!postId || !content) return "ERROR: post_id and content are required.";
  try {
    const result = await wpRest("POST", "/wp/v2/comments", {
      post: postId,
      content,
      author_name: "AI Assistant",
      author_email: "ai@assistant.local",
      status: "approved",
    });
    const firstNewline = result.indexOf("\n");
    const statusLine = firstNewline > -1 ? result.slice(0, firstNewline) : result;
    const body = firstNewline > -1 ? result.slice(firstNewline + 1) : "";
    const statusCode = parseInt(statusLine.replace("HTTP ", ""), 10);
    if (statusCode >= 400) return `ERROR: ${result}`;
    try {
      const data = JSON.parse(body);
      return `OK: Comment posted (id=${data.id ?? "?"}) on post ${postId}`;
    } catch {
      return `OK: Comment posted on post ${postId}`;
    }
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

export function readFile(filePath: string): string {
  if (!filePath) return "ERROR: No file path provided.";
  const normalized = path.resolve(filePath);
  const readablePaths = ["/tmp/", path.resolve(WP_PATH) + "/", "/app/config/"];
  if (!readablePaths.some((p) => normalized.startsWith(p))) {
    return `ERROR: Can only read files under: ${readablePaths.join(", ")}`;
  }
  try {
    if (!fs.existsSync(normalized)) return `ERROR: File not found: ${normalized}`;
    const stat = fs.statSync(normalized);
    if (stat.isDirectory()) return `ERROR: '${normalized}' is a directory. Use run_command with 'ls' to list files.`;
    if (stat.size > 200_000)
      return `ERROR: File too large (${stat.size} bytes). Use run_command with 'head' or 'tail' instead.`;
    return fs.readFileSync(normalized, "utf8");
  } catch (e: any) {
    return `ERROR: ${e.message}`;
  }
}

export async function uploadMediaToWp(
  fileBytes: Buffer,
  filename: string,
  mimeType: string,
): Promise<{ id?: number; url?: string; error?: string }> {
  const wpExists = fs.existsSync(WP_PATH) && fs.readdirSync(WP_PATH).length > 0;
  if (wpExists) {
    const safeName = filename.replace(/[^\w.\-]/g, "_");
    const tmpPath = `/tmp/greenclaw-upload-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
    try {
      fs.writeFileSync(tmpPath, fileBytes);
      const result = spawnSync(`wp media import ${tmpPath} --porcelain --path=${WP_PATH} --allow-root`, {
        shell: true,
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, HOME: "/root" },
      });
      const output = ((result.stdout ?? "") + (result.stderr ?? "")).trim();
      let attachmentId: number | null = null;
      for (const token of output.split(/\s+/)) {
        if (/^\d+$/.test(token)) {
          attachmentId = parseInt(token, 10);
          break;
        }
      }
      if ((result.status !== 0 && result.status !== null) || attachmentId === null) {
        return { error: `WP-CLI media import failed: ${output.slice(0, 300)}` };
      }
      const urlResult = spawnSync(`wp post get ${attachmentId} --field=guid --path=${WP_PATH} --allow-root`, {
        shell: true,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: "/root" },
      });
      return { id: attachmentId, url: (urlResult.stdout ?? "").trim() };
    } catch (e) {
      return { error: String(e) };
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
    }
  }

  if (!WP_URL) return { error: "WP_URL not configured." };
  if (!WP_APP_PASSWORD && !WP_ADMIN_PASSWORD) {
    return { error: "No WordPress credentials configured for remote upload. Set WP_APP_PASSWORD in .env" };
  }

  const headers: Record<string, string> = {
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Type": mimeType,
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
    if (e.response)
      return {
        error: `WordPress returned HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 300)}`,
      };
    return { error: String(e.message) };
  }
}

interface SearchResult {
  title: string;
  url: string;
  content: string;
}

export async function webSearch(query: string, maxResults = 5): Promise<string> {
  if (!query?.trim()) return "ERROR: No search query provided.";
  const limit = Math.min(Math.max(maxResults, 1), 20);

  try {
    const resp = await axios.get(`${SEARXNG_URL}/search`, {
      params: { q: query, format: "json", pageno: 1 },
      timeout: 15_000,
      proxy: false,
    });

    const results: SearchResult[] = (resp.data?.results ?? []).slice(0, limit);
    if (results.length === 0) return `No results found for: ${query}`;

    return results
      .map((r: SearchResult, i: number) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.content}`)
      .join("\n\n");
  } catch (e: any) {
    if (e.code === "ECONNREFUSED") return "ERROR: Search service unavailable. SearXNG may not be running.";
    return `ERROR: Search failed — ${e.message}`;
  }
}

export async function screenshot(url: string, fullPage = false): Promise<string> {
  if (!url?.trim()) return "ERROR: No URL provided.";

  try {
    const resp = await axios.post(
      `${BROWSER_URL}/screenshot`,
      {
        url,
        options: { fullPage, type: "png" },
        gotoOptions: { waitUntil: "networkidle2", timeout: 30_000 },
      },
      {
        timeout: 45_000,
        responseType: "arraybuffer",
        proxy: false,
        headers: { "Content-Type": "application/json" },
      },
    );

    const buffer = Buffer.from(resp.data);
    const tmpPath = `/tmp/screenshot-${Date.now()}.png`;
    fs.writeFileSync(tmpPath, buffer);

    return `Screenshot captured (${buffer.length} bytes).\n[IMAGE:${tmpPath}]`;
  } catch (e: any) {
    if (e.code === "ECONNREFUSED") return "ERROR: Browser service unavailable. Browserless may not be running.";
    return `ERROR: Screenshot failed — ${e.message}`;
  }
}
