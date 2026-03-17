import { describe, it, expect } from "vitest";
import { TASK_PROFILES } from "../src/profiles";
import { routeInboundEvent } from "../src/models";
import type { TaskProfile } from "../src/types";

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
    { function: { name: "web_search" } },
    { function: { name: "screenshot" } },
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
    expect(names).toContain("fetch_page");
    expect(names).toContain("web_search");
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
