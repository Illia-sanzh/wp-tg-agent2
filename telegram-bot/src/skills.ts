import * as yaml from "js-yaml";
import { MyContext } from "./types";
import { AGENT_URL, log } from "./config";
import { agentAxios } from "./http";
import { clearFlows } from "./utils";
import { bot } from "./bot-setup";
import { isAdmin } from "./utils";
import {
  isGithubSkillFileUrl,
  isGithubRepoUrl,
  parseGithubRepoUrl,
  installSkillFromUrl,
  browseGithubSkills,
} from "./github";

export function registerSkillCommands(): void {
  bot.command(["skill", "skills"], async (ctx) => {
    if (!isAdmin(ctx)) return;
    clearFlows(ctx);
    const rawMatch = ctx.match ?? "";
    const args = rawMatch.trim().split(/\s+/).filter(Boolean);
    const sub = (args[0] ?? "").toLowerCase();
    log.info(`[bot] /skill command: match="${rawMatch}" sub="${sub}" args=${JSON.stringify(args)}`);

    if (sub === "reload") {
      try {
        const r = await agentAxios.post(`${AGENT_URL}/reload-skills`, {}, { timeout: 15000 });
        const names = (r.data.skills ?? []).map((n: string) => `• \`${n}\``).join("\n") || "_(none)_";
        await ctx.reply(`🔄 Skills reloaded — ${r.data.loaded ?? 0} custom skill(s) active:\n\n${names}`, {
          parse_mode: "Markdown",
        });
      } catch (e) {
        await ctx.reply(`❌ Reload failed: ${e}`);
      }
      return;
    }

    if (sub === "show") {
      if (!args[1]) {
        await ctx.reply("Usage: `/skill show <name>`", { parse_mode: "Markdown" });
        return;
      }
      try {
        const r = await agentAxios.get(`${AGENT_URL}/skills/${args[1]}`, { timeout: 10000 });
        if (r.status === 404) {
          await ctx.reply(`❌ Skill \`${args[1]}\` not found.`, { parse_mode: "Markdown" });
          return;
        }
        await ctx.reply(`📄 *Skill:* \`${args[1]}\`\n\n\`\`\`\n${r.data.yaml}\n\`\`\``, { parse_mode: "Markdown" });
      } catch (e) {
        await ctx.reply(`❌ Error: ${e}`);
      }
      return;
    }

    if (sub === "delete") {
      if (!args[1]) {
        await ctx.reply("Usage: `/skill delete <name>`", { parse_mode: "Markdown" });
        return;
      }
      ctx.session.pendingSkillDelete = args[1];
      await ctx.reply(
        `⚠️ Are you sure you want to delete skill \`${args[1]}\`?\n\nType \`yes\` to confirm or \`/cancel\` to abort.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    if (sub === "install") {
      if (!args[1]) {
        await ctx.reply(
          "📦 *Install a skill from GitHub*\n\n" +
            "Usage: `/skill install <github-url>`\n\n" +
            "Supports:\n" +
            "• Direct file: `.../blob/main/skill.yaml` or `.md` or `.js`\n" +
            "• Whole repo: `https://github.com/user/repo`\n" +
            "• Subdirectory: `.../tree/main/subdir`\n\n" +
            "_Tip: paste any GitHub URL directly in chat — the bot detects it automatically!_",
          { parse_mode: "Markdown" },
        );
        return;
      }
      const url = args[1];
      if (isGithubSkillFileUrl(url)) {
        await installSkillFromUrl(ctx, url);
      } else if (isGithubRepoUrl(url)) {
        const info = parseGithubRepoUrl(url)!;
        await browseGithubSkills(ctx, info);
      } else {
        await ctx.reply("❌ Unrecognised URL. Please provide a GitHub `.yaml` file link or a repo/directory URL.", {
          parse_mode: "Markdown",
        });
      }
      return;
    }

    if (sub === "create") {
      log.info("[bot] /skill create: entering create flow");
      ctx.session.skillDraft = {};
      ctx.session.skillStep = "name";
      await ctx.reply(
        "Create a new skill — Step 1/5\n\n" +
          "What is the skill name?\n" +
          "Alphanumeric + underscores only, e.g. check_ssl\n\n" +
          "Type /cancel at any time to abort.",
      );
      log.info("[bot] /skill create: reply sent successfully");
      return;
    }

    // Default: list
    try {
      const r = await agentAxios.get(`${AGENT_URL}/skills`, { timeout: 10000 });
      const builtin = (r.data.builtin ?? []).map((n: string) => `• \`${n}\``).join("\n");
      const custom = (r.data.custom ?? []).map((n: string) => `• \`${n}\``).join("\n") || "_(none)_";
      const mdSkills = (r.data.markdown ?? []) as string[];
      const mdText = mdSkills.length ? mdSkills.map((n: string) => `• \`${n}\` _(knowledge)_`).join("\n") : "_(none)_";
      const scriptSkills = (r.data.scripts ?? []) as string[];
      const scriptText = scriptSkills.length
        ? scriptSkills.map((n: string) => `• \`${n}\` _(script)_`).join("\n")
        : "_(none)_";
      await ctx.reply(
        `🔌 *Custom Skills (tools):*\n${custom}\n\n` +
          `📚 *Knowledge Skills:*\n${mdText}\n\n` +
          `📜 *Script Skills:*\n${scriptText}\n\n` +
          `⚙️ *Built-in Tools:*\n${builtin}\n\n` +
          "Sub-commands:\n• `/skill create` — guided skill creation\n• `/skill install <github-url>` — install from GitHub\n• `/skill show <name>` — view skill content\n• `/skill delete <name>` — remove a skill\n• `/skill reload` — reload from disk\n\n" +
          "_Tip: paste a GitHub skill URL directly in chat to auto-install._",
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      await ctx.reply(`❌ Error fetching skills: ${e}`);
    }
  });
}

export async function handleSkillCreateStep(ctx: MyContext): Promise<boolean> {
  const step = ctx.session.skillStep;
  const draft = ctx.session.skillDraft ?? {};
  const text = ctx.message?.text?.trim() ?? "";
  if (!step) return false;
  log.info(`[bot] handleSkillCreateStep: step="${step}" text="${text.slice(0, 50)}"`);

  if (step === "name") {
    if (!/^[a-zA-Z0-9_]+$/.test(text)) {
      await ctx.reply("❌ Invalid name. Use only letters, numbers, and underscores.\n\nTry again:");
      return true;
    }
    draft.name = text;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep = "type";
    await ctx.reply(
      `🛠️ *Create a new skill* — Step 2/5\n\nName: \`${text}\`\n\nWhat *type* of skill?\n• \`command\` — runs a shell command on the server\n• \`http\` — calls an external HTTP API\n• \`webhook\` — sends a POST to a URL`,
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "type") {
    if (!["command", "http", "webhook"].includes(text.toLowerCase())) {
      await ctx.reply("❌ Please reply with: `command`, `http`, or `webhook`", { parse_mode: "Markdown" });
      return true;
    }
    draft.type = text.toLowerCase();
    ctx.session.skillDraft = draft;
    ctx.session.skillStep = "cmd_or_url";
    const prompt =
      draft.type === "command"
        ? "Enter the *shell command* to run.\nUse `{param_name}` for parameters, e.g.:\n`df -h {path}`"
        : "Enter the *URL* for the API endpoint.\nUse `{param_name}` for URL path variables, e.g.:\n`https://api.example.com/check/{domain}`";
    await ctx.reply(`🛠️ *Create a new skill* — Step 3/5\n\n${prompt}`, { parse_mode: "Markdown" });
    return true;
  }

  if (step === "cmd_or_url") {
    if (draft.type === "command") draft.command = text;
    else draft.url = text;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep = "description";
    await ctx.reply(
      "🛠️ *Create a new skill* — Step 4/5\n\nEnter a *description* the AI will use to decide when to call this skill.\nBe specific! Or type `skip` for a default description.",
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "description") {
    if (text.toLowerCase() !== "skip") draft.description = text;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep = "params";
    await ctx.reply(
      "🛠️ *Create a new skill* — Step 5/5\n\nAdd *parameters*? Enter one per line:\n`name|description|type|required`\n\nExample:\n`query|The search query|string|true`\n`limit|Max results|integer|false`\n\nOr type `none` for no parameters.",
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "params") {
    const params: any[] = [];
    if (text.toLowerCase() !== "none") {
      for (const line of text.split("\n")) {
        const parts = line.split("|").map((p) => p.trim());
        if (parts.length >= 2) {
          params.push({
            name: parts[0],
            description: parts[1] ?? "",
            type: parts[2] ?? "string",
            required: (parts[3] ?? "false").toLowerCase() === "true",
          });
        }
      }
    }
    draft.parameters = params;
    ctx.session.skillDraft = draft;
    ctx.session.skillStep = "confirm";
    const preview = (yaml.dump(draft, { noRefs: true }) as string).trim();
    await ctx.reply(
      `🛠️ *Preview your skill:*\n\n\`\`\`\n${preview}\n\`\`\`\n\nType \`save\` to create it, or \`/cancel\` to abort.`,
      { parse_mode: "Markdown" },
    );
    return true;
  }

  if (step === "confirm") {
    if (text.toLowerCase() !== "save") {
      await ctx.reply("Type `save` to confirm, or `/cancel` to abort.", { parse_mode: "Markdown" });
      return true;
    }
    const rawYaml = yaml.dump(draft, { noRefs: true }) as string;
    clearFlows(ctx);
    try {
      const r = await agentAxios.post(`${AGENT_URL}/skills`, { yaml: rawYaml }, { timeout: 15000 });
      if (r.data.error) {
        await ctx.reply(`❌ Failed to create skill:\n${r.data.error}`);
      } else {
        const name = r.data.name ?? draft.name ?? "?";
        await ctx.reply(`✅ Skill \`${name}\` created! The agent can now use it immediately.`, {
          parse_mode: "Markdown",
        });
      }
    } catch (e) {
      await ctx.reply(`❌ Error saving skill: ${e}`);
    }
    return true;
  }

  return false;
}

export async function handleSkillDeleteConfirm(ctx: MyContext): Promise<boolean> {
  const pending = ctx.session.pendingSkillDelete;
  if (!pending) return false;

  const text = (ctx.message?.text ?? "").trim().toLowerCase();
  if (text === "yes") {
    try {
      const r = await agentAxios.delete(`${AGENT_URL}/skills/${pending}`, { timeout: 10000 });
      delete ctx.session.pendingSkillDelete;
      if (r.data.error) {
        await ctx.reply(`❌ ${r.data.error}`);
      } else {
        await ctx.reply(`✅ Skill \`${pending}\` deleted.`, { parse_mode: "Markdown" });
      }
    } catch (e) {
      await ctx.reply(`❌ Error: ${e}`);
    }
  } else {
    await ctx.reply(`Type \`yes\` to confirm deletion of \`${pending}\`, or \`/cancel\` to abort.`, {
      parse_mode: "Markdown",
    });
  }
  return true;
}
