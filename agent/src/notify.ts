import { log, TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_USER_ID } from "./config";
import { httpRequest } from "./http";

export async function notifyTelegram(text: string, recipientIds?: string[], replyMarkup?: any): Promise<void> {
  if (!TELEGRAM_BOT_TOKEN) {
    log.warn("[notify] Telegram notify skipped: BOT_TOKEN not set");
    return;
  }
  const ids =
    recipientIds && recipientIds.length > 0
      ? recipientIds
      : (TELEGRAM_ADMIN_USER_ID || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  if (ids.length === 0) {
    log.warn("[notify] Telegram notify skipped: no recipient IDs");
    return;
  }
  const truncated = text.length > 4000 ? text.slice(0, 4000) + "\n…[truncated]" : text;
  for (const uid of ids) {
    try {
      const baseData: any = { chat_id: uid, text: truncated };
      if (replyMarkup) baseData.reply_markup = replyMarkup;
      await httpRequest({
        method: "post",
        url: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        data: { ...baseData, parse_mode: "Markdown" },
        timeout: 15_000,
      }).catch(() =>
        httpRequest({
          method: "post",
          url: `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
          data: baseData,
          timeout: 15_000,
        }),
      );
    } catch (e) {
      log.warn(`[notify] Telegram notify failed for user ${uid}: ${e}`);
    }
  }
}

export async function notifyError(context: string, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack?.slice(0, 500) : "";
  log.error({ err: error, context }, "notifyError");
  await notifyTelegram(`⚠️ *Error* in \`${context}\`\n\`\`\`\n${msg}\n${stack}\n\`\`\``).catch(() => {});
}

export function installProcessHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    notifyError("unhandledRejection", reason);
  });
  process.on("uncaughtException", (err) => {
    notifyError("uncaughtException", err).finally(() => process.exit(1));
  });
}
