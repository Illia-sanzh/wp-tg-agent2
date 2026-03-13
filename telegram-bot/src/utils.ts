import { TELEGRAM_BOT_TOKEN, KNOWN_MODELS, ADMIN_USER_IDS, DEFAULT_MODEL, FAST_MODEL, SMART_MODEL } from "./config";
import { MyContext } from "./types";

export function sanitize(text: string): string {
  return text.replaceAll(TELEGRAM_BOT_TOKEN!, "[REDACTED]");
}

export function isValidModel(name: string): boolean {
  return KNOWN_MODELS.has(name) || name.startsWith("openrouter/");
}

export function isAdmin(ctx: MyContext): boolean {
  return ADMIN_USER_IDS.has(ctx.from?.id ?? 0);
}

export function clearFlows(ctx: MyContext): void {
  delete ctx.session.skillDraft;
  delete ctx.session.skillStep;
  delete ctx.session.pendingSkillDelete;
  delete ctx.session.mcpDraft;
  delete ctx.session.mcpStep;
  delete ctx.session.pendingMedia;
  delete ctx.session.mediaStep;
  delete ctx.session.skillBrowseStep;
  delete ctx.session.skillBrowseFiles;
  delete ctx.session.skillBrowseRepo;
}

export function inFlow(ctx: MyContext): boolean {
  return !!(
    ctx.session.skillStep ||
    ctx.session.pendingSkillDelete ||
    ctx.session.mcpStep ||
    ctx.session.mediaStep ||
    ctx.session.skillBrowseStep
  );
}

export const FAST_KEYWORDS = new Set([
  "show",
  "list",
  "get",
  "fetch",
  "find",
  "check",
  "count",
  "display",
  "status",
  "health",
  "ping",
  "version",
  "info",
  "which",
  "who",
  "what is",
  "what are",
  "how many",
  "is there",
  "are there",
]);

export const SMART_KEYWORDS = new Set([
  "analyze",
  "analyse",
  "audit",
  "debug",
  "diagnose",
  "investigate",
  "optimize",
  "optimise",
  "review",
  "evaluate",
  "compare",
  "migrate",
  "migration",
  "restructure",
  "refactor",
  "comprehensive",
  "thorough",
  "complete",
  "detailed",
  "full report",
  "performance",
  "security",
  "vulnerability",
  "why is",
  "why does",
  "figure out",
  "root cause",
  "step by step",
]);

export function autoSelectModel(message: string): [string, string] {
  const msg = message.toLowerCase().trim();
  const words = msg.split(/\s+/);
  const n = words.length;

  if (n > 80) return [SMART_MODEL, "smart"];
  if ((msg.match(/ and /g) ?? []).length >= 3) return [SMART_MODEL, "smart"];
  if ([...SMART_KEYWORDS].some((kw) => msg.includes(kw))) return [SMART_MODEL, "smart"];
  if (n <= 15 && [...FAST_KEYWORDS].some((kw) => msg.includes(kw))) return [FAST_MODEL, "fast"];
  if (n <= 5) return [FAST_MODEL, "fast"];
  return [DEFAULT_MODEL, "standard"];
}
