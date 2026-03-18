import axios from "axios";
import FormData from "form-data";
import { HttpsProxyAgent } from "https-proxy-agent";
import { MyContext } from "./types";
import { TELEGRAM_BOT_TOKEN, HTTPS_PROXY, AGENT_URL, DEFAULT_MODEL, log } from "./config";
import { agentAxios } from "./http";
import { bot } from "./bot-setup";
import { stopFlags } from "./state";
import { isAdmin, sanitize, clearFlows } from "./utils";
import { runAgentTask } from "./agent-task";
import { handleSkillDeleteConfirm, handleSkillCreateStep } from "./skills";
import { handleMcpInstallStep } from "./mcps";
import {
  handleSkillBrowseStep,
  isGithubSkillFileUrl,
  isGithubRepoUrl,
  parseGithubRepoUrl,
  installSkillFromUrl,
  browseGithubSkills,
} from "./github";

async function processPendingMedia(ctx: MyContext, taskDescription: string): Promise<void> {
  const media = ctx.session.pendingMedia;
  delete ctx.session.pendingMedia;
  delete ctx.session.mediaStep;
  if (!media) return;

  const statusMsg = await ctx.reply("📤 Uploading image…");
  let uploadData: any;
  try {
    const form = new FormData();
    form.append("file", Buffer.from(media.bytes), { filename: media.filename, contentType: media.contentType });
    const r = await agentAxios.post(`${AGENT_URL}/upload`, form, {
      headers: form.getHeaders(),
      timeout: 60_000,
    });
    uploadData = r.data;
  } catch (e) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Upload failed: ${sanitize(String(e))}`);
    return;
  }

  if (uploadData.error) {
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ ${uploadData.error}`);
    return;
  }

  const mediaUrl = uploadData.url ?? "";
  const mediaId = uploadData.id ?? "";

  await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);

  const lower = taskDescription.toLowerCase().trim();
  const uploadOnly = [
    "upload",
    "save",
    "store",
    "media library",
    "upload to wordpress",
    "save to wordpress",
    "upload to wordpress media library",
    "save to library",
  ];
  if (uploadOnly.includes(lower)) {
    await ctx.reply(`✅ Uploaded to WordPress media library!\n🆔 ID: \`${mediaId}\`\n🔗 ${mediaUrl}`, {
      parse_mode: "Markdown",
    });
    return;
  }

  await ctx.replyWithChatAction("typing");
  await runAgentTask(
    ctx,
    `The user shared an image that was uploaded to WordPress (Media ID: ${mediaId}, URL: ${mediaUrl}). Task: ${taskDescription}`,
  );
}

async function handlePendingMedia(ctx: MyContext): Promise<boolean> {
  if (ctx.session.mediaStep !== "waiting") return false;
  const text = (ctx.message?.text ?? "").trim();
  if (!text) return false;
  await processPendingMedia(ctx, text);
  return true;
}

export function registerHandlers(): void {
  // Bug fix callback handler
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;

    if (!data.startsWith("bugfix:")) {
      await ctx.answerCallbackQuery({ text: "Unknown action" });
      return;
    }

    if (!isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: "Unauthorized" });
      return;
    }

    const postId = data.slice(7);
    await ctx.answerCallbackQuery({ text: "Starting bug fix…" });

    try {
      const origText = ctx.callbackQuery.message?.text ?? "";
      await ctx.editMessageText(origText + "\n\n🔧 _Fix in progress…_", { parse_mode: "Markdown" });
    } catch {}
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    } catch {}

    const statusMsg = await ctx.reply(`🐛 Fixing bug #${postId}…`);
    const chatId = ctx.chat!.id;
    stopFlags.delete(chatId);

    let result = "(no result)";
    let elapsed = 0;
    let modelUsed = DEFAULT_MODEL;
    const steps: string[] = [];

    function buildStatus(): string {
      const lines = [`🐛 Fixing bug #${postId}…`];
      if (steps.length) {
        lines.push("");
        steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      }
      return lines.join("\n");
    }

    try {
      const response = await agentAxios.post(
        `${AGENT_URL}/bugfix/${postId}`,
        {},
        { responseType: "stream", timeout: 600_000 },
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
              if (event.type === "progress") {
                steps.push(event.text ?? "⚙️ Working…");
                ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, buildStatus()).catch(() => {});
              } else if (event.type === "thinking") {
                ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, buildStatus()).catch(() => {});
              } else if (event.type === "result") {
                result = event.text ?? "(no result)";
                elapsed = event.elapsed ?? 0;
                modelUsed = event.model ?? DEFAULT_MODEL;
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
          await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, "🛑 Bug fix stopped.");
        } catch {}
        return;
      }
    } catch (e: any) {
      if (e.response?.status === 404) {
        result = `❌ Bug #${postId} not found or expired. Bugs expire after 24 hours.`;
      } else if (e.response?.status === 503) {
        const errorMsg = e.response?.data?.error ?? "Service unavailable";
        result = `❌ ${errorMsg}`;
      } else if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
        result = "⏱️ Bug fix timed out after 10 minutes.";
      } else {
        result = `❌ Error: ${sanitize(e.message ?? String(e))}`;
      }
    }

    try {
      await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
    } catch {}

    const MAX_LEN = 4000;
    const footer = `\n\n_⏱ ${elapsed}s • ${modelUsed} • bug fix_`;
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
          log.error(`Failed to send bug fix result: ${e2}`);
        }
      }
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply("⛔ Unauthorized.");
      return;
    }

    if (ctx.session.cancelledAt && ctx.message.date <= ctx.session.cancelledAt) {
      return;
    }

    if (await handleSkillDeleteConfirm(ctx)) return;
    if (await handleSkillCreateStep(ctx)) return;
    if (await handleMcpInstallStep(ctx)) return;
    if (await handleSkillBrowseStep(ctx)) return;
    if (await handlePendingMedia(ctx)) return;

    const userText = (ctx.message.text ?? "").trim();
    if (!userText) return;

    if (isGithubSkillFileUrl(userText)) {
      await installSkillFromUrl(ctx, userText);
      return;
    }
    if (isGithubRepoUrl(userText)) {
      const info = parseGithubRepoUrl(userText)!;
      await browseGithubSkills(ctx, info);
      return;
    }

    await ctx.replyWithChatAction("typing");
    await runAgentTask(ctx, userText);
  });

  bot.on("message:voice", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply("⛔ Unauthorized.");
      return;
    }
    if (ctx.session.cancelledAt && ctx.message.date <= ctx.session.cancelledAt) return;

    const voice = ctx.message.voice;
    const statusMsg = await ctx.reply("🎙️ Transcribing voice message…");

    let audioBytes: Buffer;
    try {
      const tgFile = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${tgFile.file_path}`;
      const resp = await axios.get(fileUrl, {
        responseType: "arraybuffer",
        proxy: false,
        httpsAgent: HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined,
      });
      audioBytes = Buffer.from(resp.data);
    } catch (e) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        `❌ Failed to download voice message: ${sanitize(String(e))}`,
      );
      return;
    }

    let transcribeData: any;
    try {
      const form = new FormData();
      form.append("file", audioBytes, { filename: "voice.ogg", contentType: "audio/ogg" });
      const r = await agentAxios.post(`${AGENT_URL}/transcribe`, form, {
        headers: form.getHeaders(),
        timeout: 60_000,
      });
      transcribeData = r.data;
    } catch (e) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        `❌ Transcription request failed: ${sanitize(String(e))}`,
      );
      return;
    }

    if (transcribeData.error) {
      await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ ${transcribeData.error}`);
      return;
    }

    const transcript = (transcribeData.text ?? "").trim();
    if (!transcript) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        "❌ Could not transcribe audio (empty result).",
      );
      return;
    }

    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `🎙️ *Heard:* _${transcript}_`, {
      parse_mode: "Markdown",
    });
    await ctx.replyWithChatAction("typing");
    await runAgentTask(ctx, transcript);
  });

  // Media group buffering for multi-photo uploads
  const mediaGroupBuffers = new Map<
    string,
    { ctx: MyContext; photos: { fileId: string; caption: string }[]; timer: ReturnType<typeof setTimeout> }
  >();

  bot.on("message:photo", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.reply("⛔ Unauthorized.");
      return;
    }

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = (ctx.message.caption ?? "").trim();
    const groupId = ctx.message.media_group_id;

    if (groupId) {
      const existing = mediaGroupBuffers.get(groupId);
      if (existing) {
        existing.photos.push({ fileId: photo.file_id, caption });
        clearTimeout(existing.timer);
        existing.timer = setTimeout(() => processMediaGroup(groupId), 800);
      } else {
        const timer = setTimeout(() => processMediaGroup(groupId), 800);
        mediaGroupBuffers.set(groupId, { ctx, photos: [{ fileId: photo.file_id, caption }], timer });
      }
      return;
    }

    // Single photo (no media group)
    await uploadAndProcess(ctx, [{ fileId: photo.file_id, caption }]);
  });

  async function downloadPhoto(ctx: MyContext, fileId: string): Promise<Buffer> {
    const tgFile = await ctx.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${tgFile.file_path}`;
    const resp = await axios.get(fileUrl, {
      responseType: "arraybuffer",
      proxy: false,
      httpsAgent: HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined,
    });
    return Buffer.from(resp.data);
  }

  async function processMediaGroup(groupId: string): Promise<void> {
    const group = mediaGroupBuffers.get(groupId);
    mediaGroupBuffers.delete(groupId);
    if (!group) return;
    await uploadAndProcess(group.ctx, group.photos);
  }

  async function uploadAndProcess(ctx: MyContext, photos: { fileId: string; caption: string }[]): Promise<void> {
    const statusMsg = await ctx.reply(`📤 Uploading ${photos.length} image${photos.length > 1 ? "s" : ""}…`);
    const uploaded: { id: number; url: string }[] = [];

    for (const p of photos) {
      try {
        const photoBytes = await downloadPhoto(ctx, p.fileId);
        const form = new FormData();
        form.append("file", photoBytes, { filename: `telegram_${p.fileId}.jpg`, contentType: "image/jpeg" });
        const r = await agentAxios.post(`${AGENT_URL}/upload`, form, {
          headers: form.getHeaders(),
          timeout: 60_000,
        });
        if (r.data.id) uploaded.push({ id: r.data.id, url: r.data.url ?? "" });
      } catch (e) {
        log.warn(`Failed to upload photo: ${e}`);
      }
    }

    await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);

    if (uploaded.length === 0) {
      await ctx.reply("❌ Failed to upload images.");
      return;
    }

    const caption = photos
      .map((p) => p.caption)
      .filter(Boolean)
      .join(" ")
      .trim();
    const mediaInfo = uploaded.map((u) => `Media ID: ${u.id}, URL: ${u.url}`).join("\n");

    if (caption) {
      await ctx.replyWithChatAction("typing");
      await runAgentTask(
        ctx,
        `The user shared ${uploaded.length} image(s) uploaded to WordPress:\n${mediaInfo}\n\nTask: ${caption}`,
      );
    } else {
      const lines = uploaded.map((u) => `🆔 \`${u.id}\` — ${u.url}`);
      await ctx.reply(
        `✅ Uploaded ${uploaded.length} image${uploaded.length > 1 ? "s" : ""} to WordPress:\n${lines.join("\n")}`,
        {
          parse_mode: "Markdown",
        },
      );
    }
  }
}
