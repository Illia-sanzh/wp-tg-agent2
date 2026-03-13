import { MyContext, EnvDef, McpEntry } from "./types";
import { AGENT_URL } from "./config";
import { agentAxios } from "./http";
import { sanitize, clearFlows, isAdmin } from "./utils";
import { bot } from "./bot-setup";
import { MCP_CATALOG } from "./mcp-catalog";

export function registerMcpCommands(): void {
  bot.command("mcp", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] ?? "").toLowerCase();

    if (sub === "reload") {
      try {
        const r = await agentAxios.post(`${AGENT_URL}/reload-mcps`, {}, { timeout: 15000 });
        const tools = (r.data.tools ?? []).map((t: string) => `• \`${t}\``).join("\n") || "_(none)_";
        await ctx.reply(`🔄 MCP tools reloaded — ${r.data.loaded ?? 0} tool(s) active:\n\n${tools}`, {
          parse_mode: "Markdown",
        });
      } catch (e) {
        await ctx.reply(`❌ Reload failed: ${e}`);
      }
      return;
    }

    if (sub === "tools") {
      if (!args[1]) {
        await ctx.reply("Usage: `/mcp tools <name>`", { parse_mode: "Markdown" });
        return;
      }
      try {
        const r = await agentAxios.get(`${AGENT_URL}/mcps/${args[1]}/tools`, { timeout: 10000 });
        if (r.status === 404) {
          await ctx.reply(`❌ MCP \`${args[1]}\` not found.`, { parse_mode: "Markdown" });
          return;
        }
        const tools = r.data.tools ?? [];
        if (!tools.length) {
          await ctx.reply(`MCP \`${args[1]}\` has no tools.`, { parse_mode: "Markdown" });
          return;
        }
        const lines = [`🔧 *Tools in \`${args[1]}\`:*\n`];
        for (const t of tools) lines.push(`• \`${t.name}\` — ${(t.description ?? "").slice(0, 80)}`);
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${e}`);
      }
      return;
    }

    if (sub === "remove") {
      if (!args[1]) {
        await ctx.reply("Usage: `/mcp remove <name>`", { parse_mode: "Markdown" });
        return;
      }
      try {
        const r = await agentAxios.delete(`${AGENT_URL}/mcps/${args[1]}`, { timeout: 15000 });
        if (r.data.error) {
          await ctx.reply(`❌ ${r.data.error}`);
        } else {
          await ctx.reply(`✅ MCP \`${args[1]}\` removed. Use \`/mcp reload\` to update the agent's tool list.`, {
            parse_mode: "Markdown",
          });
        }
      } catch (e) {
        await ctx.reply(`❌ Error: ${e}`);
      }
      return;
    }

    if (sub === "available") {
      const CATEGORY_EMOJI: Record<string, string> = {
        Utility: "🔧",
        Database: "🗄",
        Search: "🔍",
        Developer: "⚙",
        Productivity: "📋",
        Communication: "💬",
        Payments: "💳",
        Browser: "🌐",
        Cloud: "☁",
        CMS: "📝",
        Google: "📊",
        AI: "🤖",
        Media: "🎬",
        Sales: "📈",
      };
      const cats: Record<string, Array<[string, McpEntry]>> = {};
      for (const [slug, info] of Object.entries(MCP_CATALOG)) {
        if (!cats[info.category]) cats[info.category] = [];
        cats[info.category].push([slug, info]);
      }
      const total = Object.keys(MCP_CATALOG).length;
      const lines = [`📦 *Available MCPs* (${total})\nInstall: \`/mcp install <name>\`\n`];
      for (const [cat, entries] of Object.entries(cats)) {
        const emoji = CATEGORY_EMOJI[cat] ?? "📦";
        lines.push(`*${emoji} ${cat}*`);
        for (const [slug, info] of entries) {
          const reqVars = info.env.filter((e) => e.required);
          let line = `• \`${slug}\` — ${info.description}`;
          if (reqVars.length) {
            line += ` [${reqVars.map((e) => e.name).join(", ")}]`;
          }
          lines.push(line);
        }
        lines.push("");
      }
      lines.push("Use `/mcp info <name>` for setup details");

      const chunks: string[] = [];
      let current = "";
      for (const line of lines) {
        if (current.length + line.length + 1 > 4000) {
          chunks.push(current);
          current = line;
        } else {
          current += (current ? "\n" : "") + line;
        }
      }
      if (current) chunks.push(current);
      for (const chunk of chunks) {
        await ctx.reply(chunk, { parse_mode: "Markdown" });
      }
      return;
    }

    if (sub === "info") {
      if (!args[1]) {
        await ctx.reply("Usage: `/mcp info <name>`", { parse_mode: "Markdown" });
        return;
      }
      const slug = args[1].toLowerCase();
      const info = MCP_CATALOG[slug];
      if (!info) {
        await ctx.reply(`❌ \`${slug}\` not in catalog. Use \`/mcp available\` to browse.`, { parse_mode: "Markdown" });
        return;
      }
      const lines = [`📦 *${slug}*`, `\`${info.package}\``, `_${info.description}_\n`];
      if (info.env.length) {
        lines.push("*Required environment variables:*");
        for (const e of info.env) {
          lines.push(`• \`${e.name}\` _(${e.required ? "required" : "optional"})_`);
          lines.push(`  ${e.hint}`);
        }
      } else {
        lines.push("✅ No API keys required.");
      }
      lines.push(`\nInstall: \`/mcp install ${slug}\``);
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    if (sub === "install") {
      if (!args[1]) {
        await ctx.reply("Usage: `/mcp install <name>`\n\nBrowse available MCPs with `/mcp available`", {
          parse_mode: "Markdown",
        });
        return;
      }
      const shortName = args[1].toLowerCase();
      if (!MCP_CATALOG[shortName]) {
        await ctx.reply(`❌ \`${shortName}\` is not in the catalog.\n\nUse \`/mcp available\` to see all options.`, {
          parse_mode: "Markdown",
        });
        return;
      }
      const info = MCP_CATALOG[shortName];
      clearFlows(ctx);
      ctx.session.mcpDraft = { short_name: shortName, package: info.package, env: {}, env_defs: info.env };

      const requiredVars = info.env.filter((e) => e.required);
      if (requiredVars.length) {
        const lines = [
          `📦 *${shortName}* — ${info.description}\n`,
          "*This MCP needs the following environment variables:*\n",
        ];
        for (const e of info.env) {
          lines.push(`• \`${e.name}\` _(${e.required ? "required" : "optional"})_`);
          lines.push(`  _${e.hint}_\n`);
        }
        lines.push(
          "Do you have these credentials? Reply `yes` to enter them, `no` to cancel, or `skip` to install without them (it may not work).",
        );
        ctx.session.mcpStep = "env_choice";
        await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      } else {
        ctx.session.mcpStep = "installing";
        await doMcpInstall(ctx);
      }
      return;
    }

    // Default: list installed MCPs
    try {
      const r = await agentAxios.get(`${AGENT_URL}/mcps`, { timeout: 10000 });
      const mcps = r.data.mcps ?? [];
      if (!mcps.length) {
        await ctx.reply(
          "🔧 *No MCPs installed.*\n\n• `/mcp available` — browse all available MCPs\n• `/mcp install <name>` — install one\n• `/mcp info <name>` — see env vars and setup details",
          { parse_mode: "Markdown" },
        );
        return;
      }
      const lines = ["🔧 *Installed MCPs:*\n"];
      for (const mcp of mcps) lines.push(`• \`${mcp.name}\` — ${(mcp.tools ?? []).length} tool(s)`);
      lines.push("\n*Commands:*");
      lines.push("• `/mcp available` — browse catalog");
      lines.push("• `/mcp info <name>` — setup details + env vars");
      lines.push("• `/mcp install <name>` — install");
      lines.push("• `/mcp tools <name>` — list tools");
      lines.push("• `/mcp remove <name>` — uninstall");
      lines.push("• `/mcp reload` — sync tools to agent");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch (e) {
      await ctx.reply(`❌ Error fetching MCPs: ${e}`);
    }
  });
}

export async function handleMcpInstallStep(ctx: MyContext): Promise<boolean> {
  const step = ctx.session.mcpStep;
  const draft = ctx.session.mcpDraft ?? {};
  const text = (ctx.message?.text ?? "").trim();
  if (!step) return false;

  if (step === "env_choice") {
    const choice = text.toLowerCase();
    if (choice === "yes") {
      ctx.session.mcpStep = "env_vars";
      const envDefs = (draft.env_defs ?? []) as EnvDef[];
      const lines = ["Enter environment variables, one per line as `KEY=VALUE`\n"];
      for (const e of envDefs) lines.push(`• \`${e.name}\` _(${e.required ? "required" : "optional"})_ — ${e.hint}`);
      lines.push("\nType `done` when finished.");
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } else if (choice === "no" || choice === "skip") {
      ctx.session.mcpStep = "installing";
      await doMcpInstall(ctx);
    } else {
      await ctx.reply("Please reply `yes`, `no`, or `skip`.", { parse_mode: "Markdown" });
    }
    return true;
  }

  if (step === "env_vars") {
    if (text.toLowerCase() === "done") {
      const env = (draft.env ?? {}) as Record<string, string>;
      const envDefs = (draft.env_defs ?? []) as EnvDef[];
      const missing = envDefs.filter((e) => e.required && !env[e.name]).map((e) => e.name);
      if (missing.length && !draft._missing_warned) {
        await ctx.reply(
          `⚠️ Still missing required variables: ${missing.map((m) => `\`${m}\``).join(", ")}\nAdd them or type \`done\` again to install anyway.`,
          { parse_mode: "Markdown" },
        );
        draft._missing_warned = true;
        ctx.session.mcpDraft = draft;
      } else {
        ctx.session.mcpStep = "installing";
        await doMcpInstall(ctx);
      }
    } else {
      const env = (draft.env ?? {}) as Record<string, string>;
      for (const line of text.split("\n")) {
        if (line.includes("=")) {
          const idx = line.indexOf("=");
          env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
      draft.env = env;
      draft._missing_warned = false;
      ctx.session.mcpDraft = draft;

      const envDefs = (draft.env_defs ?? []) as EnvDef[];
      const missing = envDefs.filter((e) => e.required && !env[e.name]).map((e) => e.name);
      const saved = Object.keys(env)
        .map((k) => `\`${k}\``)
        .join(", ");
      if (missing.length) {
        await ctx.reply(
          `✅ Saved: ${saved}\nStill needed: ${missing.map((m) => `\`${m}\``).join(", ")}\nType \`done\` when finished.`,
          { parse_mode: "Markdown" },
        );
      } else {
        await ctx.reply(`✅ All variables set: ${saved}\nType \`done\` to install.`, { parse_mode: "Markdown" });
      }
    }
    return true;
  }

  return false;
}

export async function doMcpInstall(ctx: MyContext): Promise<void> {
  const draft = ctx.session.mcpDraft ?? {};
  const pkg = (draft.package ?? "") as string;
  const shortName = (draft.short_name ?? "") as string;
  const env = (draft.env ?? {}) as Record<string, string>;

  const statusMsg = await ctx.reply(`⏳ Installing \`${pkg}\`… this may take a minute.`, { parse_mode: "Markdown" });
  try {
    const r = await agentAxios.post(
      `${AGENT_URL}/mcps/install`,
      { package: pkg, name: shortName, env },
      { timeout: 120_000 },
    );
    clearFlows(ctx);
    if (r.data.error) {
      await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Install failed:\n${r.data.error}`);
      return;
    }
    const tools = r.data.tools ?? [];
    const toolsText = tools.length
      ? tools.map((t: any) => `• \`${t.name}\` — ${(t.description ?? "").slice(0, 60)}`).join("\n")
      : "_(none discovered)_";
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `✅ \`${pkg}\` installed!\n\nTools discovered:\n${toolsText}\n\nUse \`/mcp reload\` to make them available to the agent.`,
      { parse_mode: "Markdown" },
    );
  } catch (e) {
    clearFlows(ctx);
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Install error: ${sanitize(String(e))}`);
  }
}
