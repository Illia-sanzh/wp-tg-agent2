import { run } from "@grammyjs/runner";
import { log, ADMIN_USER_IDS } from "./config";
import { bot } from "./bot-setup";
import { registerCommands } from "./commands";
import { registerSkillCommands } from "./skills";
import { registerMcpCommands } from "./mcps";
import { registerHandlers } from "./handlers";

export async function main(): Promise<void> {
  registerCommands();
  registerSkillCommands();
  registerMcpCommands();
  registerHandlers();

  await bot.api.setMyCommands([
    { command: "start", description: "Welcome message & feature list" },
    { command: "status", description: "Check agent health" },
    { command: "model", description: "Show or switch AI model" },
    { command: "stop", description: "Abort current AI request" },
    { command: "cancel", description: "Clear history / cancel active flow" },
    { command: "tasks", description: "List or cancel scheduled tasks" },
    { command: "skill", description: "List, create, install (GitHub), delete custom skills" },
    { command: "mcp", description: "Install, list, remove MCP tool servers" },
  ]);

  log.info(`[bot] Starting (admin users: ${[...ADMIN_USER_IDS].join(", ")})`);
  log.info("[bot] Bot commands registered with Telegram.");

  const runner = run(bot);
  log.info("[bot] Runner started (concurrent update processing)…");
  runner.task().then(() => log.info("[bot] Runner stopped."));
}
