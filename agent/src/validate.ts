import {
  log,
  LITELLM_MASTER_KEY,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_ADMIN_USER_ID,
  WP_URL,
  WP_ADMIN_USER,
  WP_APP_PASSWORD,
  WP_ADMIN_PASSWORD,
  INBOUND_SECRET,
  BRIDGE_SECRET,
} from "./config";

interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateEnv(): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Critical: LiteLLM key
  if (
    !LITELLM_MASTER_KEY ||
    LITELLM_MASTER_KEY === "sk-1234" ||
    LITELLM_MASTER_KEY === "sk-CHANGE-ME-USE-OPENSSL-RAND-HEX-32"
  ) {
    errors.push(
      "LITELLM_MASTER_KEY is not set or still uses the default placeholder. Generate one: openssl rand -hex 32",
    );
  }

  // Critical: Telegram
  if (!TELEGRAM_BOT_TOKEN) {
    warnings.push("TELEGRAM_BOT_TOKEN not set — bot notifications will fail");
  }
  if (!TELEGRAM_ADMIN_USER_ID) {
    warnings.push("TELEGRAM_ADMIN_USER_ID not set — bot will reject all users");
  }

  // Critical: WordPress
  if (!WP_URL) {
    warnings.push("WP_URL not set — WordPress REST API calls will fail");
  }
  if (!WP_APP_PASSWORD && !WP_ADMIN_PASSWORD) {
    warnings.push("Neither WP_APP_PASSWORD nor WP_ADMIN_PASSWORD set — WordPress auth will fail");
  }

  // Security warnings
  if (!INBOUND_SECRET) {
    warnings.push("INBOUND_SECRET not set — /inbound webhook endpoint is unauthenticated");
  }
  if (!BRIDGE_SECRET || BRIDGE_SECRET === "CHANGE-ME-USE-OPENSSL-RAND-HEX-32") {
    warnings.push("BRIDGE_SECRET uses default value — WordPress bridge plugin auth is insecure");
  }

  // AI providers
  const hasAnyKey = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
  ].some((k) => !!process.env[k]);
  if (!hasAnyKey) {
    errors.push(
      "No AI provider API key set. Set at least one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, GEMINI_API_KEY, OPENROUTER_API_KEY",
    );
  }

  return { errors, warnings };
}

export function runStartupValidation(): void {
  const { errors, warnings } = validateEnv();

  for (const w of warnings) {
    log.warn(`[startup] ${w}`);
  }
  for (const e of errors) {
    log.error(`[startup] ${e}`);
  }

  if (errors.length > 0) {
    log.error(`[startup] ${errors.length} critical config error(s) found. Fix them in .env and restart.`);
    process.exit(1);
  }

  if (warnings.length > 0) {
    log.warn(`[startup] ${warnings.length} config warning(s) — some features may not work`);
  } else {
    log.info("[startup] Configuration validated OK");
  }
}
