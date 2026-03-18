import * as fs from "fs";
import type OpenAI from "openai";
import { log, DEFAULT_MODEL, FALLBACK_MODEL, OR_FALLBACK_MODEL, MAX_STEPS, MAX_OUTPUT_CHARS } from "./config";
import { state } from "./state";
import { client } from "./http";
import { ROUTER_MODEL, DEFAULT_PROFILE, effortBody } from "./profiles";
import { pickAvailableModel } from "./models";
import { buildSystemPrompt } from "./prompt";
import { getToolsForProfile } from "./tool-loaders";
import { dispatchTool, toolLabel } from "./tool-dispatch";
import type { TaskProfile, AgentEvent, ChatMessage } from "./types";

const SUMMARIZE_AFTER = 6;
const IMAGE_MARKER_RE = /\[IMAGE:([^\]]+)\]/g;
const VISION_MODELS = ["claude", "gpt-5", "gpt-4-turbo", "gemini"];

function supportsVision(model: string): boolean {
  const m = model.toLowerCase();
  return VISION_MODELS.some((v) => m.includes(v));
}

function extractImages(toolResult: string): { text: string; images: string[] } {
  const images: string[] = [];
  const text = toolResult
    .replace(IMAGE_MARKER_RE, (_, filePath: string) => {
      try {
        if (fs.existsSync(filePath)) {
          const buf = fs.readFileSync(filePath);
          images.push(buf.toString("base64"));
        }
      } catch (e) {
        log.warn(`[agent] Failed to read image ${filePath}: ${e}`);
      }
      return "";
    })
    .trim();
  return { text, images };
}

export async function summarizeHistory(
  history: Array<{ role: string; content: string }>,
): Promise<Array<{ role: string; content: string }>> {
  if (history.length <= SUMMARIZE_AFTER) return history;

  const toSummarize = history.slice(0, -4);
  const toKeep = history.slice(-4);

  try {
    const cheapModel = pickAvailableModel(
      ROUTER_MODEL,
      "openrouter/gpt-5.4-mini",
      "openrouter/gpt-5.4-nano",
      DEFAULT_MODEL,
    );
    const summaryResp = await client.chat.completions.create({
      model: cheapModel,
      messages: [
        {
          role: "system",
          content:
            "Summarize this conversation history in 2-3 concise sentences. Focus on: what was discussed, what actions were taken, and any important context for continuing the conversation. Be factual and brief.",
        },
        {
          role: "user",
          content: toSummarize
            .map((m) => `${m.role}: ${m.content}`)
            .join("\n\n")
            .slice(0, 3000),
        },
      ],
      max_tokens: 200,
      temperature: 0,
      ...effortBody(cheapModel, "low"),
    });
    const summary = summaryResp.choices?.[0]?.message?.content ?? "";
    if (summary) {
      log.info(`[threads] Summarized ${toSummarize.length} messages → ${summary.length} chars`);
      return [{ role: "system", content: `Previous conversation summary: ${summary}` }, ...toKeep];
    }
  } catch (e) {
    log.warn(`[threads] Summary failed (${e}), using truncated history`);
  }

  return toKeep;
}

export async function runSingleShot(
  userMessage: string,
  model: string,
  profile: TaskProfile,
  history: ChatMessage[] = [],
): Promise<{ text: string; elapsed: number; model: string }> {
  const start = Date.now();
  const systemPrompt = buildSystemPrompt(profile.promptSections, profile);

  const rawHistory = history.map((h) => ({ role: h.role, content: h.content }));
  const condensed = await summarizeHistory(rawHistory);

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...condensed.map((h) => ({ role: h.role as "user" | "assistant" | "system", content: h.content })),
    { role: "user", content: userMessage },
  ];

  const fallback = model.startsWith("openrouter/")
    ? pickAvailableModel(OR_FALLBACK_MODEL, "openrouter/gemini-2.0-flash", "openrouter/deepseek-chat")
    : pickAvailableModel(FALLBACK_MODEL, "gemini-2.0-flash", "deepseek-chat");

  try {
    const resp = await client.chat.completions.create({
      model,
      messages,
      max_tokens: profile.maxTokens,
      temperature: 0.7,
      ...effortBody(model, profile.effort),
    });
    const text = resp.choices?.[0]?.message?.content ?? "(no response)";
    return { text, elapsed: (Date.now() - start) / 1000, model };
  } catch (e: any) {
    if (model !== fallback && state.availableModels.has(fallback)) {
      log.warn(`[single-shot] ${model} failed, trying ${fallback}`);
      try {
        const resp = await client.chat.completions.create({
          model: fallback,
          messages,
          max_tokens: profile.maxTokens,
          temperature: 0.7,
          ...effortBody(fallback, profile.effort),
        });
        const text = resp.choices?.[0]?.message?.content ?? "(no response)";
        return { text, elapsed: (Date.now() - start) / 1000, model: fallback };
      } catch (e2: any) {
        return { text: `AI service error: ${e2.message ?? e2}`, elapsed: (Date.now() - start) / 1000, model: fallback };
      }
    }
    return { text: `AI service error: ${e.message ?? e}`, elapsed: (Date.now() - start) / 1000, model };
  }
}

export async function* runAgent(
  userMessage: string,
  model: string = DEFAULT_MODEL,
  history: ChatMessage[] = [],
  profile: TaskProfile = DEFAULT_PROFILE,
): AsyncGenerator<AgentEvent> {
  const rawHistory = history.map((h) => ({ role: h.role, content: h.content }));
  const condensed = await summarizeHistory(rawHistory);

  const systemPrompt = buildSystemPrompt(profile.promptSections, profile);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    ...condensed.map((h) => ({ role: h.role as "user" | "assistant" | "system", content: h.content })),
    { role: "user", content: userMessage },
  ];

  if (profile.model) {
    model =
      profile.model === "cheap"
        ? pickAvailableModel(ROUTER_MODEL, "openrouter/gpt-5.4-mini", "openrouter/gpt-5.4-nano", DEFAULT_MODEL)
        : profile.model;
  } else if (profile.maxSteps > 5) {
    const cheapModels = ["gpt-5.4-nano", "openrouter/gpt-5.4-nano"];
    if (cheapModels.includes(model)) {
      log.info(`[agent] Upgrading model from ${model} → ${DEFAULT_MODEL} for agentic profile '${profile.name}'`);
      model = DEFAULT_MODEL;
    }
  }

  let systemInjected = false;
  const start = Date.now();
  let steps = 0;
  let consecutiveErrors = 0;
  let recentErrors: string[] = [];
  let lastToolSig = "";
  let repeatCount = 0;
  const collectedImages: string[] = [];
  const profileTools = getToolsForProfile(profile);
  const maxSteps = profile.maxSteps || MAX_STEPS;
  const maxTokens = profile.maxTokens || 16384;
  const maxOutput = profile.maxOutputChars || MAX_OUTPUT_CHARS;
  const fallback = model.startsWith("openrouter/")
    ? pickAvailableModel(OR_FALLBACK_MODEL, "openrouter/gemini-2.0-flash", "openrouter/deepseek-chat")
    : pickAvailableModel(FALLBACK_MODEL, "gemini-2.0-flash", "deepseek-chat");

  log.info(
    `[agent] Profile: ${profile.name} | tools: ${profileTools.length} | maxSteps: ${maxSteps} | maxTokens: ${maxTokens}`,
  );

  while (steps < maxSteps) {
    steps++;
    yield { type: "thinking" };

    let response: OpenAI.Chat.ChatCompletion;
    try {
      response = await client.chat.completions.create({
        model,
        messages,
        tools: profileTools.length > 0 ? profileTools : undefined,
        tool_choice: profileTools.length > 0 ? "auto" : undefined,
        // @ts-ignore — LiteLLM extension: system passed as extra field
        system: systemPrompt,
        max_tokens: maxTokens,
        ...effortBody(model, profile.effort),
      } as any);
    } catch (firstErr: any) {
      if (firstErr?.message?.includes("system") && !systemInjected) {
        messages.unshift({ role: "system", content: systemPrompt });
        systemInjected = true;
        try {
          response = await client.chat.completions.create({
            model,
            messages,
            tools: profileTools.length > 0 ? profileTools : undefined,
            tool_choice: profileTools.length > 0 ? "auto" : undefined,
            max_tokens: maxTokens,
            ...effortBody(model, profile.effort),
          } as any);
        } catch (e2: any) {
          const err2 = String(e2.message ?? e2);
          if (model !== fallback && state.availableModels.has(fallback)) {
            log.warn(`[agent] Model ${model} failed (${err2}), trying ${fallback}`);
            yield* runAgent(userMessage, fallback, history, profile);
            return;
          }
          yield { type: "result", text: `AI service error: ${err2}`, elapsed: (Date.now() - start) / 1000, model };
          return;
        }
      } else {
        const err = String(firstErr.message ?? firstErr);
        if (model !== fallback && state.availableModels.has(fallback)) {
          log.warn(`[agent] Model ${model} failed (${err}), trying ${fallback}`);
          yield* runAgent(userMessage, fallback, history, profile);
          return;
        }
        yield { type: "result", text: `AI service error: ${err}`, elapsed: (Date.now() - start) / 1000, model };
        return;
      }
    }

    if (!response.choices?.length) {
      yield {
        type: "result",
        text: "AI service returned an empty response.",
        elapsed: (Date.now() - start) / 1000,
        model,
      };
      return;
    }

    const choice = response.choices[0];
    log.info(
      `[agent] Step ${steps}/${maxSteps}: finish_reason=${choice.finish_reason}, tool_calls=${choice.message?.tool_calls?.length ?? 0}, content_len=${choice.message?.content?.length ?? 0}`,
    );

    if (choice.finish_reason === "length") {
      log.warn(`[agent] Response truncated (finish_reason=length) at step ${steps}`);
      messages.push({
        role: "system",
        content:
          "YOUR PREVIOUS RESPONSE WAS TRUNCATED because it exceeded the output limit. " +
          "You MUST split your work into smaller pieces. When writing HTML files, write the CSS/first section " +
          "with `cat > /tmp/file.html <<'EOF'`, then append more with `cat >> /tmp/file.html <<'EOF'`. " +
          "Each command must be SHORT ENOUGH to fit in a single response. Try again with a smaller chunk.",
      } as any);
      yield { type: "progress", text: "⚠️ Output was truncated, retrying with smaller chunks…" };
      continue;
    }

    const msg = choice.message;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls } as any);

    if (!msg.tool_calls?.length) {
      yield {
        type: "result",
        text: msg.content ?? "(no response)",
        elapsed: (Date.now() - start) / 1000,
        model,
        ...(collectedImages.length ? { images: collectedImages } : {}),
      };
      return;
    }

    let stepHadError = false;
    for (const tc of msg.tool_calls) {
      const fnName = tc.function.name;
      const rawArgs = tc.function.arguments ?? "";
      let fnArgs: Record<string, any> = {};
      try {
        fnArgs = JSON.parse(rawArgs || "{}");
      } catch (parseErr) {
        log.warn(`[agent] Failed to parse tool args for ${fnName}: ${String(parseErr).slice(0, 100)}`);
        log.warn(`[agent] Raw args (first 200 chars): ${rawArgs.slice(0, 200)}`);
      }
      if (fnName === "run_command" && !fnArgs.command) {
        log.warn(`[agent] Empty command! Raw args length: ${rawArgs.length}, starts with: ${rawArgs.slice(0, 200)}`);
        log.warn(`[agent] Assistant content: ${(msg.content ?? "(none)").slice(0, 500)}`);
        log.warn(
          `[agent] All tool_calls: ${JSON.stringify(msg.tool_calls?.map((t) => ({ name: t.function.name, argsLen: t.function.arguments?.length ?? 0 })))}`,
        );
      }

      yield { type: "progress", text: toolLabel(fnName, fnArgs) };

      log.info(`[agent] Tool call: ${fnName}(${Object.keys(fnArgs).join(", ")})`);
      let toolResult = await dispatchTool(fnName, fnArgs);
      if (toolResult.length > maxOutput) {
        toolResult = toolResult.slice(0, maxOutput) + `\n... [truncated, ${toolResult.length} total chars]`;
      }
      log.info(`[agent]   → ${String(toolResult).slice(0, 200)}`);

      const { text: cleanResult, images } = extractImages(toolResult);
      collectedImages.push(...images);
      messages.push({ role: "tool", tool_call_id: tc.id, content: cleanResult || toolResult } as any);
      if (images.length > 0 && supportsVision(model)) {
        const contentParts: any[] = [{ type: "text", text: "Here is the screenshot I just captured:" }];
        for (const b64 of images) {
          contentParts.push({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${b64}` },
          });
        }
        messages.push({ role: "user", content: contentParts } as any);
      }

      if (String(toolResult).startsWith("ERROR")) {
        stepHadError = true;
        recentErrors.push(`${fnName}: ${String(toolResult).slice(0, 300)}`);
        if (recentErrors.length > 6) recentErrors.shift();
      }

      const sig = `${fnName}:${tc.function.arguments ?? ""}`;
      if (sig === lastToolSig) {
        repeatCount++;
      } else {
        lastToolSig = sig;
        repeatCount = 0;
      }
    }

    consecutiveErrors = stepHadError ? consecutiveErrors + 1 : 0;
    if (consecutiveErrors >= 4) {
      log.warn(`[agent] Bailing: ${consecutiveErrors} consecutive error steps`);
      const errorDetail = recentErrors.length
        ? "\n\nErrors encountered:\n" + recentErrors.map((e, i) => `${i + 1}. ${e}`).join("\n")
        : "";
      yield {
        type: "result",
        text: `I've encountered errors on ${consecutiveErrors} consecutive attempts and stopped to avoid wasting time.${errorDetail}\n\nPlease check the approach and try again with more specific instructions.`,
        elapsed: (Date.now() - start) / 1000,
        model,
        ...(collectedImages.length ? { images: collectedImages } : {}),
      };
      return;
    }

    if (repeatCount >= 3) {
      const repeatedAction = lastToolSig.split(":")[0] || "unknown";
      log.warn(`[agent] Bailing: same tool call repeated ${repeatCount + 1} times (${repeatedAction})`);
      yield {
        type: "result",
        text: `I got stuck in a loop — repeated the same "${repeatedAction}" call ${repeatCount + 1} times. Could you rephrase what you'd like me to do?`,
        elapsed: (Date.now() - start) / 1000,
        model,
        ...(collectedImages.length ? { images: collectedImages } : {}),
      };
      return;
    }

    if (steps === maxSteps - 3 && maxSteps > 5) {
      messages.push({
        role: "system",
        content:
          "WARNING: You are running low on steps (3 remaining). Wrap up now: finish the current operation, report what you've done, and stop. Do NOT start new searches or explorations.",
      } as any);
    }
  }

  yield {
    type: "result",
    text: "Reached the maximum number of steps. The task may be partially complete.",
    elapsed: (Date.now() - start) / 1000,
    model,
    ...(collectedImages.length ? { images: collectedImages } : {}),
  };
}
