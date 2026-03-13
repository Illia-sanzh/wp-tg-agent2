import type OpenAI from "openai";
import type { ThreadRecord, PendingBug, MarkdownSkill } from "./types";

export const state = {
  threadStore: new Map<string, ThreadRecord>(),
  pendingBugs: new Map<string, PendingBug>(),
  availableModels: new Set<string>(),
  modelsProbed: false,

  cachedCustomTools: [] as OpenAI.Chat.ChatCompletionTool[],
  cachedMarkdownSkillList: [] as MarkdownSkill[],
  cachedMarkdownSkills: "",
  cachedMcpTools: [] as OpenAI.Chat.ChatCompletionTool[],
  cachedWpAbilityTools: [] as OpenAI.Chat.ChatCompletionTool[],
  wpAbilityNameMap: new Map<string, string>(),

  taskCount: 0,
  lastTaskAt: 0,
  startedAt: Date.now(),

  // Typed as `any` to avoid circular import — assigned in main.ts at startup
  scheduler: null as any,
};
