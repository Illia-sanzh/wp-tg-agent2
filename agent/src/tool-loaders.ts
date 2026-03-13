import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type OpenAI from "openai";
import axios from "axios";
import { log, SKILLS_DIR, WP_URL, WP_ADMIN_USER, WP_APP_PASSWORD, WP_MCP_ENDPOINT } from "./config";
import { state } from "./state";
import { httpRequest } from "./http";
import { TOOLS } from "./tool-defs";
import type { TaskProfile, MarkdownSkill } from "./types";

export const MCP_RUNNER_URL = "http://greenclaw-mcp-runner:9000";

export function loadCustomSkills(): OpenAI.Chat.ChatCompletionTool[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  let files: string[];
  try {
    files = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith(".yaml"))
      .sort();
  } catch {
    return [];
  }

  const tools: OpenAI.Chat.ChatCompletionTool[] = [];
  for (const file of files) {
    try {
      const skill = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, file), "utf8")) as Record<string, any>;
      if (!skill || typeof skill !== "object") continue;
      if (skill.disabled) continue;

      const name = (skill.name ?? "").trim();
      if (!name || !/^[a-zA-Z0-9_]+$/.test(name)) {
        log.warn(`[skills] ${file}: invalid/missing name, skipping.`);
        continue;
      }

      const props: Record<string, any> = {};
      const required: string[] = [];
      for (const p of skill.parameters ?? []) {
        const pName = (p.name ?? "").trim();
        if (!pName) continue;
        props[pName] = { type: p.type ?? "string", description: p.description ?? "" };
        if (p.required) required.push(pName);
      }

      tools.push({
        type: "function",
        function: {
          name: `skill_${name}`,
          description: skill.description ?? `Custom skill: ${name}`,
          parameters: { type: "object", properties: props, required },
        },
      });
      log.info(`[skills] Loaded skill_${name} (${file})`);
    } catch (e) {
      log.warn(`[skills] Failed to load ${file}: ${e}`);
    }
  }
  return tools;
}

export function loadMarkdownSkillList(): MarkdownSkill[] {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const skills: MarkdownSkill[] = [];
  try {
    for (const file of fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith(".md") && !f.toLowerCase().startsWith("readme"))
      .sort()) {
      try {
        const content = fs.readFileSync(path.join(SKILLS_DIR, file), "utf8").trim();
        if (content) skills.push({ name: file.replace(/\.md$/, ""), filename: file, content });
      } catch (e) {
        log.warn(`[skills] Failed to load markdown ${file}: ${e}`);
      }
    }
  } catch {}
  return skills;
}

export async function loadMcpTools(): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  try {
    const r = await axios.get(`${MCP_RUNNER_URL}/mcps`, { timeout: 5000, proxy: false });
    const mcps: Array<{ name: string; tools: Array<{ name: string; description: string; inputSchema: any }> }> =
      r.data.mcps ?? [];

    const tools: OpenAI.Chat.ChatCompletionTool[] = [];
    for (const mcp of mcps) {
      const mcpName = mcp.name ?? "";
      for (const tool of mcp.tools ?? []) {
        const tName = tool.name ?? "";
        if (!mcpName || !tName) continue;
        const fnName = `mcp_${mcpName}__${tName}`.replace(/-/g, "_");
        tools.push({
          type: "function",
          function: {
            name: fnName,
            description: `[MCP: ${mcpName}] ${tool.description ?? ""}`,
            parameters: tool.inputSchema ?? { type: "object", properties: {} },
          },
        });
      }
    }
    if (tools.length > 0) log.info(`[mcp] Loaded ${tools.length} tool(s) from ${mcps.length} MCP(s)`);
    return tools;
  } catch (e) {
    log.warn(`[mcp] Runner unreachable, skipping MCP tools: ${e}`);
    return [];
  }
}

// WP Abilities (WordPress MCP Adapter)

async function wpMcpPost(body: any, extraHeaders?: Record<string, string>, timeout = 15_000): Promise<any> {
  const auth = `Basic ${Buffer.from(`${WP_ADMIN_USER}:${WP_APP_PASSWORD}`).toString("base64")}`;
  return httpRequest({
    method: "POST",
    url: WP_MCP_ENDPOINT,
    data: body,
    timeout,
    headers: { "Content-Type": "application/json", Authorization: auth, ...extraHeaders },
  });
}

export async function wpMcpSession(): Promise<Record<string, string>> {
  const initResp = await wpMcpPost({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "greenclaw-agent", version: "1.0" },
    },
  });

  const sessionId = initResp.headers?.["mcp-session-id"] ?? "";
  const sessionHeaders = sessionId ? { "Mcp-Session-Id": sessionId } : {};

  await wpMcpPost({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders, 5_000).catch(() => {});

  return sessionHeaders;
}

export async function wpMcpCall(
  sessionHeaders: Record<string, string>,
  toolName: string,
  args: Record<string, any>,
  id = 1,
): Promise<any> {
  const resp = await wpMcpPost(
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    },
    sessionHeaders,
    30_000,
  );
  if (resp.data?.error) throw new Error(resp.data.error.message ?? JSON.stringify(resp.data.error));
  return resp.data?.result;
}

export async function loadWpAbilities(): Promise<OpenAI.Chat.ChatCompletionTool[]> {
  if (!WP_MCP_ENDPOINT || !WP_APP_PASSWORD) {
    log.warn("[wp-abilities] Skipped: WP_URL or WP_APP_PASSWORD not set");
    return [];
  }

  try {
    const sessionHeaders = await wpMcpSession();

    const discoverResult = await wpMcpCall(sessionHeaders, "mcp-adapter-discover-abilities", {}, 2);
    const abilities: Array<{ name: string; label: string; description: string }> =
      discoverResult?.structuredContent?.abilities ??
      JSON.parse(discoverResult?.content?.[0]?.text ?? "{}").abilities ??
      [];

    if (abilities.length === 0) {
      log.info("[wp-abilities] No abilities discovered");
      return [];
    }

    state.wpAbilityNameMap.clear();
    const tools: OpenAI.Chat.ChatCompletionTool[] = [];
    for (const ability of abilities) {
      const safeSuffix = ability.name.replace(/[^a-zA-Z0-9_]/g, "_");
      const fnName = `wp_ability__${safeSuffix}`;
      state.wpAbilityNameMap.set(safeSuffix, ability.name);

      let inputSchema: any = { type: "object", properties: {} };
      try {
        const infoResult = await wpMcpCall(
          sessionHeaders,
          "mcp-adapter-get-ability-info",
          { ability_name: ability.name },
          3,
        );
        const info = infoResult?.structuredContent ?? JSON.parse(infoResult?.content?.[0]?.text ?? "{}");
        if (info.input_schema) inputSchema = info.input_schema;
      } catch {
        /* use default schema */
      }

      tools.push({
        type: "function",
        function: {
          name: fnName,
          description: `[WP Ability] ${ability.description || ability.label || ability.name}`,
          parameters: inputSchema,
        },
      });
    }

    log.info(`[wp-abilities] Loaded ${tools.length} tool(s): ${abilities.map((a) => a.name).join(", ")}`);
    return tools;
  } catch (e: any) {
    log.warn(`[wp-abilities] Failed to load: ${e.message}`);
    return [];
  }
}

export function getToolsForProfile(profile: TaskProfile): OpenAI.Chat.ChatCompletionTool[] {
  if (profile.tools.includes("*")) {
    return [...TOOLS, ...state.cachedCustomTools, ...state.cachedMcpTools, ...state.cachedWpAbilityTools];
  }
  const selected: OpenAI.Chat.ChatCompletionTool[] = [];
  const allAvailable = [...TOOLS, ...state.cachedCustomTools, ...state.cachedMcpTools, ...state.cachedWpAbilityTools];
  for (const tool of allAvailable) {
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

export function getAllTools(): OpenAI.Chat.ChatCompletionTool[] {
  return [...TOOLS, ...state.cachedCustomTools, ...state.cachedMcpTools, ...state.cachedWpAbilityTools];
}
