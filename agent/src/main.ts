import { log, PORT, DATA_DIR } from "./config";
import { state } from "./state";
import { loadThreads } from "./threads";
import { loadCustomSkills, loadMarkdownSkillList, loadMcpTools, loadWpAbilities } from "./tool-loaders";
import { getMarkdownSkills } from "./prompt";
import { createScheduler } from "./scheduler";
import { probeModels } from "./models";
import { installProcessHandlers } from "./notify";
import { createApp } from "./routes";
import { runStartupValidation } from "./validate";
import * as fs from "fs";
import * as path from "path";

function seedAgentMemory(): void {
  const agentMdPath = path.join(DATA_DIR, "AGENT.md");
  if (!fs.existsSync(agentMdPath)) {
    fs.writeFileSync(
      agentMdPath,
      "# Agent Memory\n\nNo instructions saved yet. Tell the bot to remember something.\n",
      "utf8",
    );
    log.info("[agent] Seeded AGENT.md");
  }
}

export async function main(): Promise<void> {
  runStartupValidation();
  installProcessHandlers();
  loadThreads();
  seedAgentMemory();

  state.cachedCustomTools = loadCustomSkills();
  log.info(`[agent] Custom skills loaded: ${state.cachedCustomTools.length}`);

  state.cachedMarkdownSkillList = loadMarkdownSkillList();
  state.cachedMarkdownSkills = getMarkdownSkills(["*"]);
  log.info(
    `[agent] Markdown knowledge loaded: ${state.cachedMarkdownSkillList.length} skill(s), ${state.cachedMarkdownSkills.length} chars total`,
  );

  state.cachedMcpTools = await loadMcpTools();
  log.info(`[agent] MCP tools loaded: ${state.cachedMcpTools.length}`);

  state.cachedWpAbilityTools = await loadWpAbilities();
  log.info(`[agent] WP Ability tools loaded: ${state.cachedWpAbilityTools.length}`);

  state.scheduler = createScheduler();
  state.scheduler.start();
  log.info(`[scheduler] Started — pending jobs: ${state.scheduler.jobCount}`);

  const app = createApp();
  app.listen(PORT, "0.0.0.0", () => {
    log.info(`[agent] Listening on port ${PORT}`);
    probeModels().catch((e) => log.warn(`[probe] Failed: ${e}`));
  });
}
