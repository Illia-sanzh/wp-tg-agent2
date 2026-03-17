import { DEFAULT_MODEL } from "./config";
import type { TaskProfile } from "./types";

export function effortBody(model: string, effort?: "low" | "medium" | "high"): Record<string, any> {
  if (!effort || effort === "high") return {};
  const isClaude = model.includes("claude");
  if (!isClaude) return {};
  return { extra_body: { output_config: { effort } } };
}

export const ROUTER_MODEL =
  process.env.ROUTER_MODEL ?? (DEFAULT_MODEL.startsWith("openrouter/") ? "openrouter/claude-haiku" : "claude-haiku");

export const TASK_PROFILES: Record<string, TaskProfile> = {
  forum_reply: {
    name: "forum_reply",
    tools: ["reply_to_forum"],
    promptSections: ["identity", "wp_config"],
    knowledgePatterns: [],
    skillFileSections: [],
    maxSteps: 2,
    maxTokens: 1024,
    maxOutputChars: 2000,
    model: "cheap",
    singleShot: true,
    effort: "low",
  },
  inbound_notify: {
    name: "inbound_notify",
    tools: [],
    promptSections: ["identity"],
    knowledgePatterns: [],
    skillFileSections: [],
    maxSteps: 0,
    maxTokens: 0,
    maxOutputChars: 0,
  },
  wp_admin: {
    name: "wp_admin",
    tools: [
      "run_command",
      "read_file",
      "wp_rest",
      "wp_cli_remote",
      "write_file",
      "reply_to_forum",
      "web_search",
      "fetch_page",
      "wp_ability__",
    ],
    promptSections: ["identity", "wp_config", "execution_rules", "efficiency_rules", "wp_mode", "abilities"],
    knowledgePatterns: [],
    skillFileSections: ["capabilities", "wpcli", "safety", "guardrails", "content_formatting", "common_skills"],
    maxSteps: 30,
    maxTokens: 8192,
    maxOutputChars: 10000,
    effort: "medium",
  },
  scheduling: {
    name: "scheduling",
    tools: ["schedule_task", "run_command", "wp_rest"],
    promptSections: ["identity", "wp_config", "execution_rules", "scheduling"],
    knowledgePatterns: [],
    skillFileSections: [],
    maxSteps: 5,
    maxTokens: 2048,
    maxOutputChars: 4000,
    effort: "low",
  },
  web_design: {
    name: "web_design",
    tools: [
      "run_command",
      "read_file",
      "wp_rest",
      "write_file",
      "fetch_page",
      "web_search",
      "screenshot",
      "skill_",
      "wp_cli_remote",
    ],
    promptSections: [
      "identity",
      "wp_config",
      "execution_rules",
      "efficiency_rules",
      "wp_mode",
      "web_design",
      "custom_skills",
    ],
    knowledgePatterns: ["*"],
    skillFileSections: ["capabilities", "wpcli", "safety", "content_formatting", "web_design_workflow"],
    maxSteps: 60,
    maxTokens: 16384,
    maxOutputChars: 12000,
  },
  plugin_dev: {
    name: "plugin_dev",
    tools: [
      "run_command",
      "read_file",
      "write_file",
      "wp_rest",
      "wp_cli_remote",
      "reply_to_forum",
      "fetch_page",
      "web_search",
      "screenshot",
    ],
    promptSections: ["identity", "wp_config", "execution_rules", "efficiency_rules", "wp_mode", "plugin_dev"],
    knowledgePatterns: ["plugin", "block", "gutenberg"],
    skillFileSections: ["capabilities", "wpcli", "safety", "guardrails"],
    maxSteps: 80,
    maxTokens: 16384,
    maxOutputChars: 16000,
  },
  bug_fix: {
    name: "bug_fix",
    tools: [
      "mcp_server_github__",
      "reply_to_forum",
      "read_file",
      "wp_rest",
      "run_command",
      "write_file",
      "web_search",
      "fetch_page",
      "screenshot",
    ],
    promptSections: ["identity", "execution_rules", "efficiency_rules", "bug_fix_workflow"],
    knowledgePatterns: [],
    skillFileSections: [],
    maxSteps: 50,
    maxTokens: 16384,
    maxOutputChars: 16000,
  },
  general: {
    name: "general",
    tools: ["*"],
    promptSections: ["*"],
    knowledgePatterns: ["*"],
    skillFileSections: ["*"],
    maxSteps: 60,
    maxTokens: 16384,
    maxOutputChars: 12000,
  },
};

export const DEFAULT_PROFILE = TASK_PROFILES.general;
