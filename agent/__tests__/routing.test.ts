// Routing and profile tests for agent logic.
// Functions duplicated from agent.ts — Phase 4 will extract and import properly.

import { describe, it, expect } from "vitest";

// ── Duplicated types & constants from agent.ts ──────────────────────────────

interface TaskProfile {
  name: string;
  tools: string[];
  promptSections: string[];
  knowledgePatterns: string[];
  skillFileSections: string[];
  maxSteps: number;
  maxTokens: number;
  maxOutputChars: number;
  model?: string;
  singleShot?: boolean;
}

const TASK_PROFILES: Record<string, TaskProfile> = {
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
    tools: ["run_command", "read_file", "wp_rest", "wp_cli_remote", "write_file", "reply_to_forum", "wp_ability__"],
    promptSections: ["identity", "wp_config", "execution_rules", "efficiency_rules", "wp_mode", "abilities"],
    knowledgePatterns: [],
    skillFileSections: ["capabilities", "wpcli", "safety", "guardrails", "content_formatting", "common_skills"],
    maxSteps: 30,
    maxTokens: 8192,
    maxOutputChars: 10000,
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
  },
  web_design: {
    name: "web_design",
    tools: ["run_command", "read_file", "wp_rest", "write_file", "fetch_page", "skill_", "wp_cli_remote"],
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
    tools: ["run_command", "read_file", "write_file", "wp_rest", "wp_cli_remote", "reply_to_forum", "fetch_page"],
    promptSections: ["identity", "wp_config", "execution_rules", "efficiency_rules", "wp_mode"],
    knowledgePatterns: ["*"],
    skillFileSections: ["capabilities", "wpcli", "safety", "guardrails"],
    maxSteps: 80,
    maxTokens: 16384,
    maxOutputChars: 16000,
  },
  bug_fix: {
    name: "bug_fix",
    tools: ["mcp_server_github__", "reply_to_forum", "read_file", "wp_rest", "run_command", "write_file"],
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

// ── Duplicated functions from agent.ts ──────────────────────────────────────

function routeInboundEvent(event: string, autoRespond: boolean, metadata?: any): TaskProfile {
  if (!autoRespond) return TASK_PROFILES.inbound_notify;
  if (event === "new_topic" || event === "new_comment") {
    const topicType = (metadata?.type ?? "").toLowerCase();
    if (topicType === "bug") return TASK_PROFILES.inbound_notify;
    return TASK_PROFILES.forum_reply;
  }
  return TASK_PROFILES.inbound_notify;
}

interface MockTool {
  function: { name: string };
}

function getToolsForProfile(profile: TaskProfile, allTools: MockTool[]): MockTool[] {
  if (profile.tools.includes("*")) return allTools;
  const selected: MockTool[] = [];
  for (const tool of allTools) {
    const name = tool.function.name;
    for (const pattern of profile.tools) {
      if (name === pattern || name.startsWith(pattern)) {
        selected.push(tool);
        break;
      }
    }
  }
  return selected;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("routeInboundEvent", () => {
  it("returns inbound_notify when autoRespond is false", () => {
    expect(routeInboundEvent("new_topic", false).name).toBe("inbound_notify");
    expect(routeInboundEvent("new_comment", false).name).toBe("inbound_notify");
    expect(routeInboundEvent("vote", false).name).toBe("inbound_notify");
  });

  it("routes new_topic to forum_reply when autoRespond", () => {
    expect(routeInboundEvent("new_topic", true).name).toBe("forum_reply");
  });

  it("routes new_comment to forum_reply when autoRespond", () => {
    expect(routeInboundEvent("new_comment", true).name).toBe("forum_reply");
  });

  it("routes bug topics to inbound_notify (bug pipeline)", () => {
    expect(routeInboundEvent("new_topic", true, { type: "bug" }).name).toBe("inbound_notify");
    expect(routeInboundEvent("new_topic", true, { type: "Bug" }).name).toBe("inbound_notify");
    expect(routeInboundEvent("new_comment", true, { type: "BUG" }).name).toBe("inbound_notify");
  });

  it("routes non-bug topics to forum_reply", () => {
    expect(routeInboundEvent("new_topic", true, { type: "question" }).name).toBe("forum_reply");
    expect(routeInboundEvent("new_topic", true, { type: "feature" }).name).toBe("forum_reply");
  });

  it("routes vote/priority/type events to inbound_notify", () => {
    expect(routeInboundEvent("vote", true).name).toBe("inbound_notify");
    expect(routeInboundEvent("priority_change", true).name).toBe("inbound_notify");
    expect(routeInboundEvent("type_change", true).name).toBe("inbound_notify");
  });

  it("handles missing metadata gracefully", () => {
    expect(routeInboundEvent("new_topic", true, undefined).name).toBe("forum_reply");
    expect(routeInboundEvent("new_topic", true, {}).name).toBe("forum_reply");
    expect(routeInboundEvent("new_topic", true, null).name).toBe("forum_reply");
  });
});

describe("getToolsForProfile", () => {
  const mockTools: MockTool[] = [
    { function: { name: "run_command" } },
    { function: { name: "read_file" } },
    { function: { name: "write_file" } },
    { function: { name: "wp_rest" } },
    { function: { name: "wp_cli_remote" } },
    { function: { name: "schedule_task" } },
    { function: { name: "fetch_page" } },
    { function: { name: "reply_to_forum" } },
    { function: { name: "skill_deploy_site" } },
    { function: { name: "skill_backup_db" } },
    { function: { name: "mcp_server_github__create_issue" } },
    { function: { name: "mcp_server_github__create_pr" } },
    { function: { name: "wp_ability__manage_plugins" } },
  ];

  it("returns all tools for general profile (wildcard)", () => {
    const result = getToolsForProfile(TASK_PROFILES.general, mockTools);
    expect(result).toHaveLength(mockTools.length);
  });

  it("filters exact tool matches for wp_admin", () => {
    const result = getToolsForProfile(TASK_PROFILES.wp_admin, mockTools);
    const names = result.map((t) => t.function.name);
    expect(names).toContain("run_command");
    expect(names).toContain("read_file");
    expect(names).toContain("wp_rest");
    expect(names).toContain("write_file");
    expect(names).toContain("reply_to_forum");
    expect(names).not.toContain("fetch_page");
    expect(names).not.toContain("schedule_task");
  });

  it("matches prefix patterns (skill_, mcp_server_github__)", () => {
    const result = getToolsForProfile(TASK_PROFILES.web_design, mockTools);
    const names = result.map((t) => t.function.name);
    expect(names).toContain("skill_deploy_site");
    expect(names).toContain("skill_backup_db");
  });

  it("includes mcp_server_github__ tools for bug_fix profile", () => {
    const result = getToolsForProfile(TASK_PROFILES.bug_fix, mockTools);
    const names = result.map((t) => t.function.name);
    expect(names).toContain("mcp_server_github__create_issue");
    expect(names).toContain("mcp_server_github__create_pr");
    expect(names).toContain("reply_to_forum");
    expect(names).toContain("run_command");
  });

  it("includes wp_ability__ prefix tools for wp_admin", () => {
    const result = getToolsForProfile(TASK_PROFILES.wp_admin, mockTools);
    const names = result.map((t) => t.function.name);
    expect(names).toContain("wp_ability__manage_plugins");
  });

  it("returns only reply_to_forum for forum_reply", () => {
    const result = getToolsForProfile(TASK_PROFILES.forum_reply, mockTools);
    const names = result.map((t) => t.function.name);
    expect(names).toEqual(["reply_to_forum"]);
  });

  it("returns empty array for inbound_notify (no tools)", () => {
    const result = getToolsForProfile(TASK_PROFILES.inbound_notify, mockTools);
    expect(result).toHaveLength(0);
  });

  it("scheduling profile gets exactly its tools", () => {
    const result = getToolsForProfile(TASK_PROFILES.scheduling, mockTools);
    const names = result.map((t) => t.function.name);
    expect(names).toContain("schedule_task");
    expect(names).toContain("run_command");
    expect(names).toContain("wp_rest");
    expect(names).toHaveLength(3);
  });
});

describe("task profile constraints", () => {
  it("all profiles have required fields", () => {
    for (const [key, profile] of Object.entries(TASK_PROFILES)) {
      expect(profile.name, `${key} missing name`).toBeTruthy();
      expect(Array.isArray(profile.tools), `${key} tools not array`).toBe(true);
      expect(Array.isArray(profile.promptSections), `${key} promptSections not array`).toBe(true);
      expect(typeof profile.maxSteps, `${key} maxSteps not number`).toBe("number");
      expect(typeof profile.maxTokens, `${key} maxTokens not number`).toBe("number");
    }
  });

  it("inbound_notify has zero limits (no LLM call)", () => {
    const p = TASK_PROFILES.inbound_notify;
    expect(p.maxSteps).toBe(0);
    expect(p.maxTokens).toBe(0);
    expect(p.maxOutputChars).toBe(0);
    expect(p.tools).toHaveLength(0);
  });

  it("forum_reply is single-shot with cheap model", () => {
    const p = TASK_PROFILES.forum_reply;
    expect(p.singleShot).toBe(true);
    expect(p.model).toBe("cheap");
    expect(p.maxSteps).toBeLessThanOrEqual(2);
  });

  it("agentic profiles have reasonable step limits", () => {
    expect(TASK_PROFILES.wp_admin.maxSteps).toBeGreaterThanOrEqual(10);
    expect(TASK_PROFILES.web_design.maxSteps).toBeGreaterThanOrEqual(20);
    expect(TASK_PROFILES.plugin_dev.maxSteps).toBeGreaterThanOrEqual(40);
    expect(TASK_PROFILES.bug_fix.maxSteps).toBeGreaterThanOrEqual(20);
  });

  it("general profile uses wildcards for everything", () => {
    const p = TASK_PROFILES.general;
    expect(p.tools).toContain("*");
    expect(p.promptSections).toContain("*");
    expect(p.knowledgePatterns).toContain("*");
  });
});
