import { Bot, session } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { HttpsProxyAgent } from "https-proxy-agent";
import { TELEGRAM_BOT_TOKEN, HTTPS_PROXY, log } from "./config";
import { MyContext, SessionData } from "./types";

export const bot = new Bot<MyContext>(TELEGRAM_BOT_TOKEN!, {
  client: HTTPS_PROXY ? { baseFetchConfig: { agent: new HttpsProxyAgent(HTTPS_PROXY) } } : {},
});

// Let /cancel and /stop bypass the queue by giving them a different constraint key
bot.use(
  sequentialize((ctx) => {
    const chatId = ctx.chat?.id?.toString() ?? "";
    const text = ctx.message?.text ?? "";
    if (text.startsWith("/cancel") || text.startsWith("/stop")) {
      return `${chatId}:control`;
    }
    return chatId;
  }),
);

bot.use(session({ initial: (): SessionData => ({}) }));

bot.catch((err) => {
  log.error({ err }, "unhandled bot error");
});
