import { Router, Request, Response } from "express";
import type OpenAI from "openai";
import { log, DEFAULT_MODEL, GITHUB_DEFAULT_REPO, TELEGRAM_ADMIN_USER_ID, INBOUND_SECRET } from "../config";
import { state } from "../state";
import { client } from "../http";
import { ROUTER_MODEL, TASK_PROFILES } from "../profiles";
import { pickAvailableModel, routeTask, routeInboundEvent } from "../models";
import { buildSystemPrompt } from "../prompt";
import { runAgent, runSingleShot, summarizeHistory } from "../agent-loop";
import { replyToForum } from "../tool-impls";
import { getThread, appendToThread } from "../threads";
import { cleanExpiredBugs } from "../bugs";
import { notifyTelegram } from "../notify";
import { whisperClient } from "../http";
import type { TaskProfile } from "../types";

export const coreRouter = Router();

coreRouter.get("/health", (_req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: "ok",
    version: "1.0.0",
    uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    taskCount: state.taskCount,
    lastTaskAt: state.lastTaskAt ? new Date(state.lastTaskAt).toISOString() : null,
    memory: {
      rss: Math.round(mem.rss / 1024 / 1024),
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    },
    model: DEFAULT_MODEL,
    router_model: ROUTER_MODEL,
    available_models: [...state.availableModels],
    profiles: Object.keys(TASK_PROFILES),
    scheduler: state.scheduler?.running ? "running" : "stopped",
    scheduled_jobs: state.scheduler?.jobCount ?? 0,
    custom_skills: state.cachedCustomTools.length,
    mcp_tools: state.cachedMcpTools.length,
    wp_ability_tools: state.cachedWpAbilityTools.length,
    whisper: whisperClient ? "available" : "unavailable (set OPENAI_API_KEY)",
    bug_fix: {
      repo: GITHUB_DEFAULT_REPO || "(not configured)",
      github_mcp: state.cachedMcpTools.some((t) => t.function.name.startsWith("mcp_server_github__")),
      pending_bugs: state.pendingBugs.size,
    },
  });
});

coreRouter.post("/task", async (req: Request, res: Response) => {
  const { message = "", model = DEFAULT_MODEL, history = [], profile: profileName } = req.body ?? {};
  const trimmedHistory = history.length > 20 ? history.slice(-20) : history;

  if (!String(message).trim()) {
    res.status(400).json({ error: "No message provided" });
    return;
  }

  const msg = String(message).trim();
  state.taskCount++;
  state.lastTaskAt = Date.now();
  log.info({ msg: msg.slice(0, 100) }, "task received");

  let profile: TaskProfile;
  if (profileName && TASK_PROFILES[profileName]) {
    profile = TASK_PROFILES[profileName];
    log.info(`[agent] Using explicit profile: ${profileName}`);
  } else {
    profile = await routeTask(msg);
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    for await (const event of runAgent(msg, model, trimmedHistory, profile)) {
      res.write(JSON.stringify(event) + "\n");
      if (event.type === "result") log.info({ elapsed: event.elapsed, profile: profile.name }, "task complete");
    }
  } catch (e) {
    log.error({ err: e }, "unhandled exception in streaming generator");
    res.write(JSON.stringify({ type: "result", text: `❌ Internal agent error: ${e}`, elapsed: 0, model }) + "\n");
  }
  res.end();
});

coreRouter.post("/bugfix/:postId", async (req: Request, res: Response) => {
  const postId = req.params.postId;
  const bug = state.pendingBugs.get(postId);

  if (!bug) {
    res.status(404).json({ error: `Bug #${postId} not found or expired (bugs expire after 24h)` });
    return;
  }

  const hasGithubMcp = state.cachedMcpTools.some((t) => t.function.name.startsWith("mcp_server_github__"));
  if (!hasGithubMcp) {
    res.status(503).json({ error: "GitHub MCP not installed. Use /mcp install server-github first." });
    return;
  }
  if (!GITHUB_DEFAULT_REPO) {
    res.status(503).json({ error: "GITHUB_DEFAULT_REPO not set in .env" });
    return;
  }

  const profile = TASK_PROFILES.bug_fix;
  const model = DEFAULT_MODEL;

  const contextParts: string[] = [
    `[BUG FIX REQUEST]`,
    `This is a bug report from the forum that needs automated investigation and fixing.`,
    "",
    `Title: ${bug.title}`,
    `Author: ${bug.author?.name ?? "Unknown"}`,
    `Forum post ID: ${postId}`,
  ];
  if (bug.metadata?.link) contextParts.push(`Forum link: ${bug.metadata.link}`);
  contextParts.push(`Target GitHub repository: ${GITHUB_DEFAULT_REPO}`);
  contextParts.push("");
  contextParts.push(`Bug description:`);
  contextParts.push(bug.content || "(no description provided)");
  contextParts.push("");
  contextParts.push(
    `Follow the Bug Fix Workflow steps in your system prompt. Use GitHub MCP tools to search, fix, and create a PR. Then reply on the forum (post_id: ${postId}) with the PR link.`,
  );

  const userMessage = contextParts.join("\n");
  log.info(`[bugfix] Starting fix for bug #${postId}: ${bug.title}`);

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Transfer-Encoding", "chunked");

  try {
    for await (const event of runAgent(userMessage, model, [], profile)) {
      res.write(JSON.stringify(event) + "\n");
      if (event.type === "result") {
        log.info(`[bugfix] Bug #${postId} done in ${event.elapsed}s`);
        const respLines = [`🐛 Bug Fix Complete`, "", `📝 Bug: ${bug.title}`];
        if (bug.metadata?.link) respLines.push(`🔗 Forum: ${bug.metadata.link}`);
        respLines.push("");
        respLines.push((event.text ?? "").slice(0, 3500));
        const chatIds = (TELEGRAM_ADMIN_USER_ID || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        notifyTelegram(respLines.join("\n"), chatIds.length > 0 ? chatIds : undefined).catch(() => {});
      }
    }
  } catch (e) {
    log.error({ err: e, postId }, "bugfix error");
    res.write(JSON.stringify({ type: "result", text: `❌ Bug fix error: ${e}`, elapsed: 0, model }) + "\n");
  }
  res.end();
});

coreRouter.post("/inbound", async (req: Request, res: Response) => {
  if (INBOUND_SECRET) {
    const authHeader = (req.headers["authorization"] ?? "").toString();
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const provided = bearer || req.headers["x-webhook-secret"] || req.body?.secret;
    if (provided !== INBOUND_SECRET) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }
  }

  const {
    channel = "unknown",
    event = "message",
    thread_id = "",
    author = {},
    content = "",
    title = "",
    images = [],
    metadata = {},
    model: reqModel,
    auto_respond = true,
    notify_chat_ids = [],
  } = req.body ?? {};

  if (!content && !title) {
    res.status(400).json({ error: "No content or title provided" });
    return;
  }

  const authorEmail = (author?.email ?? "").toLowerCase();
  const authorName = (author?.name ?? "").toLowerCase();
  if (authorEmail === "ai@assistant.local" || authorName === "ai assistant") {
    log.info(`[inbound] Skipping self-authored event (author: ${author?.name}, email: ${author?.email})`);
    res.json({ status: "skipped", reason: "self-authored" });
    return;
  }

  const profile = routeInboundEvent(event, auto_respond, metadata);
  const threadKey = thread_id || `${channel}_${Date.now()}`;
  log.info(`[inbound] ${channel}/${event} thread=${threadKey} author=${author?.name ?? "?"} profile=${profile.name}`);

  const eventLabels: Record<string, string> = {
    new_topic: "🆕 New post",
    new_comment: "💬 New comment",
    vote_milestone: "🗳️ Vote milestone",
    urgent_priority: "🚨 Urgent priority",
    bug_type: "🐛 Marked as Bug",
  };
  const sectionLabel = metadata?.section === "feature_requests" ? "Feature Requests" : "Forum";
  const heading = `${eventLabels[event] ?? `📩 ${event}`} in ${sectionLabel}`;
  const tgLines: string[] = [heading, ""];
  if (title) tgLines.push(`📝 Title: ${title}`);
  if (metadata?.category) tgLines.push(`📁 Category: ${metadata.category}`);
  if (metadata?.link) tgLines.push(`🔗 Link: ${metadata.link}`);
  if (metadata?.post_id) tgLines.push(`⚙️ Post ID: ${metadata.post_id}`);
  if (author?.name) tgLines.push(`👤 Author: ${author.name}`);
  if (metadata?.type) tgLines.push(`🏷️ Type: ${metadata.type}`);
  if (metadata?.priority && metadata.priority !== "regular") tgLines.push(`⚡ Priority: ${metadata.priority}`);
  if (metadata?.vote_count) tgLines.push(`🔢 Votes: ${metadata.vote_count}`);
  if (content) {
    tgLines.push("");
    tgLines.push(`📰 Content: ${content.slice(0, 500)}${content.length > 500 ? "…" : ""}`);
  }
  const chatIds = Array.isArray(notify_chat_ids) && notify_chat_ids.length > 0 ? notify_chat_ids : undefined;

  let bugFixButton: any = undefined;
  if (event === "bug_type" && metadata?.post_id) {
    const pId = String(metadata.post_id);
    state.pendingBugs.set(pId, { title, content, author, metadata, timestamp: Date.now() });
    cleanExpiredBugs();
    log.info(`[inbound] Stored pending bug #${pId} (${state.pendingBugs.size} total)`);

    const hasGithubMcp = state.cachedMcpTools.some((t) => t.function.name.startsWith("mcp_server_github__"));
    if (hasGithubMcp && GITHUB_DEFAULT_REPO) {
      bugFixButton = {
        inline_keyboard: [[{ text: "🔧 Fix this bug", callback_data: `bugfix:${pId}` }]],
      };
    }
  }
  notifyTelegram(tgLines.join("\n"), chatIds, bugFixButton).catch(() => {});

  if (profile.name === "inbound_notify") {
    res.json({
      status: "received",
      thread_id: threadKey,
      message: "Event received and forwarded to Telegram.",
    });
    return;
  }

  const contextParts: string[] = [`[Inbound message from ${channel}]`, `Event: ${event}`];
  if (title) contextParts.push(`Title: ${title}`);
  if (author?.name) contextParts.push(`Author: ${author.name}${author.role ? ` (${author.role})` : ""}`);
  if (metadata?.link) contextParts.push(`Link: ${metadata.link}`);
  if (metadata?.post_id) contextParts.push(`Post ID: ${metadata.post_id}`);
  if (metadata?.category) contextParts.push(`Category: ${metadata.category}`);
  if (content) contextParts.push(`\nContent:\n${content}`);
  if (images?.length) contextParts.push(`\nAttached images: ${images.join(", ")}`);

  const userMessage = contextParts.join("\n");
  appendToThread(channel, threadKey, "user", userMessage);

  const thread = getThread(channel, threadKey);
  const profileModel =
    profile.model === "cheap"
      ? pickAvailableModel(ROUTER_MODEL, "openrouter/claude-haiku", "openrouter/gpt-4o-mini", DEFAULT_MODEL)
      : profile.model;
  const model = reqModel ?? profileModel ?? DEFAULT_MODEL;
  const history = thread.history.slice(0, -1).map((h) => ({ role: h.role, content: h.content }));

  let resultText = "(no response)";
  let elapsed = 0;

  if (profile.singleShot) {
    log.info(`[inbound] Single-shot mode (${profile.name})`);

    const singleShotPrompt = `You are a helpful AI assistant on a WordPress forum. Reply to the following forum message.
Be helpful, friendly, and concise. If the user asks a question about the site, answer based on your knowledge.
Do NOT say things like "I'll use the reply_to_forum tool" — just write the reply content directly.
Your entire response will be posted as a comment on the forum topic.`;

    try {
      const condensedHistory = await summarizeHistory(history);
      const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        { role: "system", content: singleShotPrompt },
        ...condensedHistory.map((h) => ({ role: h.role as "user" | "assistant" | "system", content: h.content })),
        { role: "user", content: userMessage },
      ];

      const start = Date.now();
      const resp = await client.chat.completions.create({
        model,
        messages,
        max_tokens: profile.maxTokens,
        temperature: 0.7,
      });
      resultText = resp.choices?.[0]?.message?.content ?? "(no response)";
      elapsed = (Date.now() - start) / 1000;

      if (resultText && resultText !== "(no response)" && metadata?.post_id) {
        const postResult = await replyToForum(Number(metadata.post_id), resultText);
        log.info(`[inbound] Direct reply result: ${postResult}`);
      }
    } catch (e: any) {
      log.error({ err: e }, "inbound single-shot error");
      resultText = `Error generating reply: ${e.message ?? e}`;
    }
  } else {
    contextParts.push(
      `\nInstructions: Use the reply_to_forum tool to post your response. In your final message, include the FULL text of what you replied so the admin can see it.`,
    );
    const agentMessage = contextParts.join("\n");

    try {
      for await (const ev of runAgent(agentMessage, model, history, profile)) {
        if (ev.type === "result") {
          resultText = ev.text ?? "(no response)";
          elapsed = ev.elapsed ?? 0;
        }
      }
    } catch (e) {
      resultText = `Agent error: ${e}`;
      log.error({ err: e }, "inbound agent error");
    }
  }

  appendToThread(channel, threadKey, "assistant", resultText);
  log.info(`[inbound] Response for ${channel}/${threadKey} in ${elapsed}s (profile: ${profile.name})`);

  if (resultText && resultText !== "(no response)") {
    const respLines: string[] = [`🤖 Agent Response`, ""];
    if (title) respLines.push(`📝 Topic: ${title}`);
    if (metadata?.link) respLines.push(`🔗 Link: ${metadata.link}`);
    respLines.push("");
    respLines.push(resultText.slice(0, 3500));
    notifyTelegram(respLines.join("\n"), chatIds).catch(() => {});
  }

  res.json({
    status: "ok",
    thread_id: threadKey,
    response: resultText,
    elapsed,
    model,
    profile: profile.name,
  });
});
