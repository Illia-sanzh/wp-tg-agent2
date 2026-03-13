import pino from "pino";

export const log = pino({
  level: process.env.LOG_LEVEL || "info",
  ...(process.env.NODE_ENV !== "production" && {
    transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  }),
});

export const HTTPS_PROXY = process.env.HTTPS_PROXY ?? "";

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is required");

export const ADMIN_USER_IDS = new Set<number>(
  (process.env.TELEGRAM_ADMIN_USER_ID ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10))
    .filter((n) => !isNaN(n)),
);

export const AGENT_URL = process.env.AGENT_URL ?? "http://greenclaw-agent:8080";
export const DEFAULT_MODEL = process.env.DEFAULT_MODEL ?? "claude-sonnet-4-6";
export const AUTO_ROUTING = (process.env.AUTO_ROUTING ?? "false").toLowerCase() === "true";
export const FAST_MODEL = process.env.FAST_MODEL ?? "claude-haiku-4-5";
export const SMART_MODEL = process.env.SMART_MODEL ?? DEFAULT_MODEL;

export const KNOWN_MODELS = new Set([
  "auto",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-opus-4-6",
  "gpt-4o",
  "gpt-4o-mini",
  "deepseek-chat",
  "deepseek-reasoner",
  "gemini-2.0-flash",
  "openrouter/claude-sonnet-4-6",
  "openrouter/claude-haiku-4-5",
  "openrouter/claude-opus-4-6",
  "openrouter/gpt-4o",
  "openrouter/gpt-4o-mini",
  "openrouter/gemini-2.0-flash",
  "openrouter/deepseek-chat",
  "openrouter/deepseek-r1",
  "openrouter/llama-3.3-70b",
  "openrouter/mistral-large",
  "openrouter/gemma-3-27b",
  "openrouter/qwq-32b",
]);
