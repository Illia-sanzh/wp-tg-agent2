import { MyContext } from "./types";
import { AGENT_URL, DEFAULT_MODEL, AUTO_ROUTING, log } from "./config";
import { agentAxios } from "./http";
import { sanitize, autoSelectModel } from "./utils";
import { stopFlags } from "./state";

export async function runAgentTask(ctx: MyContext, taskText: string): Promise<void> {
  const chatId = ctx.chat!.id;
  stopFlags.delete(chatId);
  const manualModel = ctx.session.model;
  const history = ctx.session.history ?? [];

  let model: string;
  let modelHint: string;

  if (manualModel) {
    model = manualModel;
    modelHint = `\`${model}\``;
  } else if (AUTO_ROUTING) {
    const [selectedModel, tier] = autoSelectModel(taskText);
    model = selectedModel;
    const tierBadge = tier === "fast" ? " · ⚡ fast" : tier === "smart" ? " · 🧠 smart" : "";
    modelHint = `\`${model}\`${tierBadge}`;
  } else {
    model = DEFAULT_MODEL;
    modelHint = `\`${model}\``;
  }

  const statusMsg = await ctx.reply(`🤔 Thinking… (${modelHint})`, { parse_mode: "Markdown" });

  let result = "(no result)";
  let elapsed = 0;
  let modelUsed = model;
  const steps: string[] = [];

  function buildStatus(): string {
    const lines = ["🤔 Thinking…"];
    if (steps.length) {
      lines.push("");
      steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    }
    return lines.join("\n");
  }

  try {
    const response = await agentAxios.post(
      `${AGENT_URL}/task`,
      { message: taskText, model, history },
      { responseType: "stream", timeout: 310_000 },
    );

    let buffer = "";
    let stopped = false;
    await new Promise<void>((resolve) => {
      response.data.on("data", (chunk: Buffer) => {
        if (stopFlags.get(chatId)) {
          stopped = true;
          response.data.destroy();
          return;
        }
        buffer += chunk.toString("utf8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            const etype = event.type;
            if (etype === "progress") {
              steps.push(event.text ?? "⚙️ Working…");
              ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, buildStatus()).catch(() => {});
            } else if (etype === "thinking") {
              ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, buildStatus()).catch(() => {});
            } else if (etype === "result") {
              result = event.text ?? "(no result)";
              elapsed = event.elapsed ?? 0;
              modelUsed = event.model ?? model;
            }
          } catch {}
        }
      });
      response.data.on("end", resolve);
      response.data.on("error", resolve);
      response.data.on("close", resolve);
    });

    if (stopped || stopFlags.get(chatId)) {
      stopFlags.delete(chatId);
      try {
        await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, "🛑 Stopped.");
      } catch {}
      return;
    }
  } catch (e: any) {
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      result = "⏱️ Timed out after 5 minutes.";
    } else if (e.code === "ECONNREFUSED") {
      result = "❌ Agent is unreachable.";
    } else {
      result = `❌ Error: ${sanitize(e.message ?? String(e))}`;
    }
  }

  const newHistory = [
    ...(ctx.session.history ?? []),
    { role: "user", content: taskText },
    { role: "assistant", content: result },
  ];
  ctx.session.history = newHistory.slice(-20);

  try {
    await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
  } catch {}

  // Strip internal image markers
  result = result.replace(/\[IMAGE:[^\]]+\]/g, "").trim();

  // Extract image URLs from result and send as photos
  const imageUrlRegex = /(https?:\/\/\S+\.(?:png|jpg|jpeg|gif|webp))/gi;
  const imageUrls = [...new Set(result.match(imageUrlRegex) ?? [])];

  const MAX_LEN = 4000;
  const footer = `\n\n_⏱ ${elapsed}s • ${modelUsed}_`;
  const chunks = [];
  for (let i = 0; i < Math.max(result.length, 1); i += MAX_LEN) chunks.push(result.slice(i, i + MAX_LEN));

  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i] + (i === chunks.length - 1 ? footer : "");
    try {
      await ctx.reply(text, { parse_mode: "Markdown" });
    } catch {
      try {
        await ctx.reply(text);
      } catch (e2) {
        log.error(`Failed to send chunk: ${e2}`);
      }
    }
  }

  for (const imgUrl of imageUrls) {
    try {
      await ctx.replyWithPhoto(imgUrl);
    } catch (e) {
      log.warn(`Failed to send photo ${imgUrl}: ${e}`);
    }
  }
}
