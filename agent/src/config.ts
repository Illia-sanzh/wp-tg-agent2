import * as path from "path";
import * as fs from "fs";
import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  }),
});

export const LITELLM_BASE_URL = process.env.LITELLM_BASE_URL ?? "http://greenclaw-litellm:4000/v1";
export const LITELLM_MASTER_KEY = process.env.LITELLM_MASTER_KEY ?? "sk-1234";
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";
export const FALLBACK_MODEL = process.env.FALLBACK_MODEL ?? "gpt-4o";
export const OR_FALLBACK_MODEL = process.env.OR_FALLBACK_MODEL ?? "openrouter/gpt-4o";

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
export const HTTPS_PROXY = process.env.HTTPS_PROXY ?? "";

export const WP_PATH = process.env.WP_PATH ?? "/wordpress";
export const WP_URL = process.env.WP_URL ?? "";
export const WP_ADMIN_USER = process.env.WP_ADMIN_USER ?? "admin";
export const WP_APP_PASSWORD = process.env.WP_APP_PASSWORD ?? "";
export const WP_ADMIN_PASSWORD = process.env.WP_ADMIN_PASSWORD ?? "";
export const BRIDGE_SECRET = process.env.BRIDGE_SECRET ?? "";
export const SKILL_FILE = process.env.SKILL_FILE ?? "/app/SKILL.md";
export const GITHUB_DEFAULT_REPO = process.env.GITHUB_DEFAULT_REPO ?? "";

export const WP_MCP_ENDPOINT = WP_URL ? "http://host.docker.internal/wp-json/mcp/mcp-adapter-default-server" : "";

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
export const TELEGRAM_ADMIN_USER_ID = process.env.TELEGRAM_ADMIN_USER_ID ?? "";

export const SKILLS_DIR = "/app/config/skills";
export const DATA_DIR = "/app/data";
export const SCHEDULE_DB = path.join(DATA_DIR, "schedules.db");
export const THREADS_DB = path.join(DATA_DIR, "threads.json");

export const INBOUND_SECRET = process.env.INBOUND_SECRET ?? "";

export const SEARXNG_URL = process.env.SEARXNG_URL ?? "http://greenclaw-searxng:8888";
export const BROWSER_URL = process.env.BROWSER_URL ?? "http://greenclaw-browser:3000";

export const MAX_STEPS = 25;
export const MAX_OUTPUT_CHARS = 8000;
export const PORT = 8080;
export const BUG_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_THREAD_HISTORY = 50;
export const MAX_THREADS = 500;

// Ensure writable data dir
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  process.stderr.write(`[WARN] Cannot create data dir ${DATA_DIR}: ${e}\n`);
}
