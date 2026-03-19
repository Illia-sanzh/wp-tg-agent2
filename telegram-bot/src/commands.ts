import { AGENT_URL, AUTO_ROUTING, DEFAULT_MODEL, FAST_MODEL, SMART_MODEL } from "./config";
import { agentAxios } from "./http";
import { bot } from "./bot-setup";
import { stopFlags } from "./state";
import { isAdmin, isValidModel, sanitize, clearFlows, inFlow } from "./utils";

export function registerCommands(): void {
  bot.command("start", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply("⛔ Unauthorized.");
      return;
    }
    await ctx.reply(
      "👋 *WordPress Agent* is ready\\.\n\n" +
        "Send a task in plain English:\n" +
        "• _Create a blog post about Python tips_\n" +
        "• _Install WooCommerce and create 3 products_\n" +
        "• _Show me all active plugins_\n" +
        "• _Publish the draft post at 5pm UTC_\n" +
        "• _Update all plugins every Monday at 3am_\n\n" +
        "🎙️ *Voice messages* are supported — just send a voice note\\!\n\n" +
        "Commands:\n" +
        "`/status`  — check agent health\n" +
        "`/model`   — show or change AI model\n" +
        "`/tasks`   — list or cancel scheduled tasks\n" +
        "`/skill`   — manage custom skills\n" +
        "`/mcp`     — manage MCP tool servers\n" +
        "`/stop`    — abort current AI request\n" +
        "`/cancel`  — clear history & cancel flows",
      { parse_mode: "MarkdownV2" },
    );
  });

  bot.command("help", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.reply(
      "*Commands:*\n" +
        "`/status`  — agent health & loaded skills\n" +
        "`/model`   — show or switch AI model\n" +
        "`/model auto` — enable smart routing\n" +
        "`/tasks`   — list scheduled tasks\n" +
        "`/tasks cancel <id>` — cancel a task\n" +
        "`/skill`   — manage skills (list/create/delete)\n" +
        "`/mcp`     — manage MCP tool servers\n" +
        "`/stop`    — abort current request\n" +
        "`/cancel`  — clear history & stop all\n\n" +
        "*Tips:*\n" +
        "• Just type in plain English — no command needed\n" +
        "• Send a voice note to speak your task\n" +
        "• Send a photo to upload or use in posts\n" +
        "• Paste a GitHub URL to install skills from repos",
      { parse_mode: "Markdown" },
    );
  });

  bot.command("status", async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
      const r = await agentAxios.get(`${AGENT_URL}/health`, { timeout: 5000 });
      const d = r.data;
      const routingMode = AUTO_ROUTING ? "auto (smart routing on)" : "manual";
      await ctx.reply(
        `✅ Agent online\n` +
          `Default model: \`${d.model ?? "unknown"}\`\n` +
          `Model routing: \`${routingMode}\`\n` +
          `Scheduler: \`${d.scheduler ?? "unknown"}\` (${d.scheduled_jobs ?? 0} job(s))\n` +
          `Custom skills: \`${d.custom_skills ?? 0}\`\n` +
          `MCP tools: \`${d.mcp_tools ?? 0}\`\n` +
          `Voice (Whisper): \`${d.whisper ?? "unknown"}\``,
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      await ctx.reply(`❌ Agent unreachable: ${sanitize(String(e))}`);
    }
  });

  bot.command("model", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const manual = ctx.session.model;

    if (!args.length) {
      let currentLine: string;
      if (AUTO_ROUTING && !manual) {
        currentLine =
          `Current: *auto\\-routing* 🧠\n` +
          `  Fast  → \`${FAST_MODEL}\`\n` +
          `  Standard → \`${DEFAULT_MODEL}\`\n` +
          `  Smart → \`${SMART_MODEL}\`\n\n` +
          "Use `/model auto` to keep routing on, or pick a model to lock it in\\.";
      } else {
        currentLine = `Current model: \`${manual ?? DEFAULT_MODEL}\``;
        if (AUTO_ROUTING)
          currentLine += " _\\(auto\\-routing overridden\\)_\nUse `/model auto` to re\\-enable routing\\.";
      }
      await ctx.reply(
        `${currentLine}\n\n` +
          "*Select a model:*\n" +
          "• `auto` — smart routing ⚡/◆/🧠\n\n" +
          "*Anthropic:*\n" +
          "• `claude-sonnet-4-6` — default, best quality\n" +
          "• `claude-opus-4-6` — hardest tasks\n\n" +
          "*OpenAI:*\n" +
          "• `gpt-5.4-mini`\n\n" +
          "*DeepSeek:*\n" +
          "• `deepseek-chat` / `deepseek-reasoner`\n\n" +
          "*Google:*\n" +
          "• `gemini-3.1-flash` / `gemini-2.5-pro`\n\n" +
          "*Via OpenRouter* \\(only OPENROUTER\\_API\\_KEY needed\\):\n" +
          "• `openrouter/claude-sonnet-4-6` / `openrouter/claude-opus-4-6`\n" +
          "• `openrouter/gpt-5.4-mini`\n" +
          "• `openrouter/gemini-3.1-flash`\n" +
          "• `openrouter/deepseek-chat` / `openrouter/deepseek-r1`\n" +
          "• `openrouter/llama-3.3-70b` · `openrouter/mistral-large` · `openrouter/qwq-32b`\n" +
          "• Any slug from openrouter\\.ai — prefix with `openrouter/`\n\n" +
          "Usage: `/model claude-opus-4-6` — lock to a model\n" +
          "Usage: `/model auto` — enable smart routing",
        { parse_mode: "MarkdownV2" },
      );
      return;
    }

    const choice = args[0].trim();
    if (choice === "auto") {
      delete ctx.session.model;
      const status = AUTO_ROUTING
        ? "✅ Auto-routing re-enabled."
        : "ℹ️ Auto-routing is disabled in .env (AUTO_ROUTING=false). The default model will be used.";
      await ctx.reply(status);
    } else if (!isValidModel(choice)) {
      await ctx.reply(
        `❌ Unknown model: \`${choice}\`\n\nUse \`/model\` to see the list of available models.\nFor OpenRouter, prefix with \`openrouter/\` — e.g. \`openrouter/llama-3.3-70b\``,
        { parse_mode: "Markdown" },
      );
    } else {
      ctx.session.model = choice;
      await ctx.reply(`✅ Locked to model: \`${choice}\``, { parse_mode: "Markdown" });
    }
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx)) return;
    try {
      const r = await agentAxios.get(`${AGENT_URL}/audit`, { timeout: 5000 });
      const s = r.data.stats;
      const lines = [
        `📊 *Agent Stats*\n`,
        `Total tasks: \`${s.total_tasks}\``,
        `Last 24h: \`${s.last_24h}\``,
        `Errors (24h): \`${s.errors_24h}\``,
      ];
      if (s.avg_elapsed_ms) lines.push(`Avg response: \`${(s.avg_elapsed_ms / 1000).toFixed(1)}s\``);
      if (Object.keys(s.by_profile).length) {
        lines.push("\n*By profile:*");
        for (const [p, c] of Object.entries(s.by_profile)) lines.push(`  ${p}: \`${c}\``);
      }
      if (Object.keys(s.by_model).length) {
        lines.push("\n*By model:*");
        for (const [m, c] of Object.entries(s.by_model)) lines.push(`  ${m}: \`${c}\``);
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.reply(`❌ Error fetching stats: ${sanitize(String(e))}`);
    }
  });

  bot.command("cancel", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const chatId = ctx.chat.id;
    const wasInFlow = inFlow(ctx);
    clearFlows(ctx);
    stopFlags.set(chatId, true);
    ctx.session.cancelledAt = ctx.message?.date ?? Math.floor(Date.now() / 1000);
    delete ctx.session.history;
    await ctx.reply(
      wasInFlow
        ? "🛑 Flow cancelled and conversation history cleared."
        : "🛑 Cancelled. Stopping current task and skipping queued messages.",
    );
  });

  bot.command("stop", async (ctx) => {
    if (!isAdmin(ctx)) return;
    stopFlags.set(ctx.chat.id, true);
    ctx.session.cancelledAt = ctx.message?.date ?? Math.floor(Date.now() / 1000);
    await ctx.reply("🛑 Stopping current request…");
  });

  bot.command("tasks", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);

    if (args[0]?.toLowerCase() === "cancel") {
      if (!args[1]) {
        await ctx.reply("Usage: `/tasks cancel <job_id>`", { parse_mode: "Markdown" });
        return;
      }
      try {
        const r = await agentAxios.delete(`${AGENT_URL}/schedules/${args[1]}`, { timeout: 10000 });
        if (r.data.error) {
          await ctx.reply(`❌ ${r.data.error}`);
        } else {
          await ctx.reply(`✅ Scheduled task \`${args[1]}\` cancelled.`, { parse_mode: "Markdown" });
        }
      } catch (e) {
        await ctx.reply(`❌ Error: ${e}`);
      }
      return;
    }

    try {
      const r = await agentAxios.get(`${AGENT_URL}/schedules`, { timeout: 10000 });
      const jobs = r.data.jobs ?? [];
      if (!jobs.length) {
        await ctx.reply(
          '📅 No scheduled tasks.\n\nSchedule one by telling the bot:\n_"Update all plugins every Monday at 3am UTC"_',
          { parse_mode: "Markdown" },
        );
        return;
      }
      const lines = ["📅 *Scheduled Tasks:*\n"];
      for (const job of jobs) {
        lines.push(`*${job.name}*`);
        lines.push(`  Next run: \`${job.next_run}\``);
        lines.push(`  Trigger: \`${job.trigger}\``);
        lines.push(`  ID: \`${job.id}\``);
        lines.push("");
      }
      lines.push("To cancel: `/tasks cancel <ID>`");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.reply(`❌ Error fetching schedules: ${e}`);
    }
  });
}
