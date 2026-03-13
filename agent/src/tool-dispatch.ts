import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import axios from "axios";
import { log, MAX_OUTPUT_CHARS, SKILLS_DIR, WP_MCP_ENDPOINT, WP_APP_PASSWORD } from "./config";
import { state } from "./state";
import { httpRequest } from "./http";
import {
  runCommand,
  fetchPage,
  wpRest,
  wpCliRemote,
  scheduleTaskFn,
  writeFile,
  readFile,
  replyToForum,
} from "./tool-impls";
import { MCP_RUNNER_URL, wpMcpSession, wpMcpCall } from "./tool-loaders";

async function dispatchSkill(toolName: string, args: Record<string, any>): Promise<string> {
  const rawName = toolName.replace(/^skill_/, "");
  if (!fs.existsSync(SKILLS_DIR)) return `ERROR: Custom skill '${rawName}' not found. Try /skill reload.`;

  let skillData: Record<string, any> | null = null;
  try {
    const files = fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".yaml"));
    for (const file of files) {
      try {
        const s = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, file), "utf8")) as Record<string, any>;
        if (s && s.name === rawName) {
          skillData = s;
          break;
        }
      } catch {}
    }
  } catch {}

  if (!skillData) return `ERROR: Custom skill '${rawName}' not found. Try /skill reload.`;

  const skillType = skillData.type ?? "command";
  const filteredArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "reason"));

  if (skillType === "command") {
    let cmd = skillData.command ?? "";
    for (const [k, v] of Object.entries(filteredArgs)) cmd = cmd.replace(`{${k}}`, String(v));
    return runCommand(cmd);
  }

  if (skillType === "http" || skillType === "webhook") {
    let url = skillData.url ?? "";
    const method = (skillData.method ?? "GET").toUpperCase();
    for (const [k, v] of Object.entries(filteredArgs)) url = url.replace(`{${k}}`, String(v));
    const body = skillType === "webhook" ? filteredArgs : undefined;
    try {
      const resp = await httpRequest({ method, url, data: body, timeout: 30_000 });
      let text = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data);
      if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS) + "... [truncated]";
      return `HTTP ${resp.status}\n${text}`;
    } catch (e: any) {
      return `ERROR in skill ${rawName}: ${e.message}`;
    }
  }

  return `ERROR: Unknown skill type '${skillType}' in ${rawName}.yaml`;
}

async function dispatchMcpTool(toolName: string, args: Record<string, any>): Promise<string> {
  const filteredArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "reason"));
  const withoutPrefix = toolName.slice("mcp_".length);
  const idx = withoutPrefix.indexOf("__");
  if (idx < 0) return `ERROR: Malformed MCP tool name '${toolName}'`;

  const mcpNameU = withoutPrefix.slice(0, idx);
  const fnName = withoutPrefix.slice(idx + 2);
  const mcpName = mcpNameU.replace(/_/g, "-");

  try {
    let r = await axios.post(
      `${MCP_RUNNER_URL}/mcps/${mcpName}/call`,
      { tool: fnName, arguments: filteredArgs },
      { timeout: 60_000, proxy: false },
    );
    if (r.status === 404) {
      r = await axios.post(
        `${MCP_RUNNER_URL}/mcps/${mcpNameU}/call`,
        { tool: fnName, arguments: filteredArgs },
        { timeout: 60_000, proxy: false },
      );
      if (r.status === 404) return `ERROR: MCP '${mcpName}' not found. Install it with /mcp install.`;
    }
    const data = r.data;
    if (data.error) return `ERROR from MCP ${mcpName}: ${data.error}`;
    return String(data.result ?? "(no result)");
  } catch (e: any) {
    return `ERROR calling MCP tool ${toolName}: ${e.message}`;
  }
}

async function dispatchWpAbility(toolName: string, args: Record<string, any>): Promise<string> {
  if (!WP_MCP_ENDPOINT || !WP_APP_PASSWORD) {
    return "ERROR: WP_URL or WP_APP_PASSWORD not configured for WP Abilities.";
  }

  const filteredArgs = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "reason"));
  const safeSuffix = toolName.slice("wp_ability__".length);
  const abilityName = state.wpAbilityNameMap.get(safeSuffix) ?? safeSuffix.replace(/_/g, "-");

  try {
    const sessionHeaders = await wpMcpSession();
    const result = await wpMcpCall(sessionHeaders, "mcp-adapter-execute-ability", {
      ability_name: abilityName,
      parameters: filteredArgs,
    });

    if (result?.structuredContent) return JSON.stringify(result.structuredContent);
    const content: Array<{ text?: string }> = result?.content ?? [];
    const text = content.map((c) => c.text ?? JSON.stringify(c)).join("\n");
    return text || JSON.stringify(result ?? "(no result)");
  } catch (e: any) {
    if (e.response) {
      return `ERROR calling WP Ability: HTTP ${e.response.status} — ${JSON.stringify(e.response.data).slice(0, 500)}`;
    }
    return `ERROR calling WP Ability ${abilityName}: ${e.message}`;
  }
}

export async function dispatchTool(name: string, args: Record<string, any>): Promise<string> {
  if (name === "run_command") return runCommand(args.command ?? "");
  if (name === "read_file") return readFile(args.path ?? "");
  if (name === "write_file") return writeFile(args.path ?? "", args.content ?? "", args.append === true);
  if (name === "wp_rest") return wpRest(args.method ?? "GET", args.endpoint ?? "/", args.body, args.params);
  if (name === "wp_cli_remote") return wpCliRemote(args.command ?? "");
  if (name === "schedule_task") return scheduleTaskFn(args.task ?? "", args.run_at, args.cron, args.label);
  if (name === "reply_to_forum") return replyToForum(args.post_id ?? 0, args.content ?? "");
  if (name === "fetch_page") return fetchPage(args.url ?? "");
  if (name.startsWith("skill_")) return dispatchSkill(name, args);
  if (name.startsWith("mcp_")) return dispatchMcpTool(name, args);
  if (name.startsWith("wp_ability__")) return dispatchWpAbility(name, args);
  return `ERROR: Unknown tool '${name}'`;
}

export function toolLabel(fnName: string, fnArgs: Record<string, any>): string {
  const reason = (fnArgs.reason ?? "").trim();
  if (fnName === "run_command") {
    if (reason) return `🖥 ${reason.slice(0, 120)}`;
    const cmd = fnArgs.command ?? "";
    let firstLine = "";
    for (const line of cmd.split("\n")) {
      const stripped = line.trim();
      if (stripped && !stripped.startsWith("#")) {
        firstLine = stripped;
        break;
      }
    }
    return `🖥 ${(firstLine || cmd.replace(/\s+/g, " ")).slice(0, 110) || "(command)"}`;
  }
  if (fnName === "wp_rest")
    return reason ? `🌐 ${reason.slice(0, 120)}` : `🌐 ${fnArgs.method ?? "GET"} ${fnArgs.endpoint ?? ""}`;
  if (fnName === "wp_cli_remote")
    return reason ? `🔧 ${reason.slice(0, 120)}` : `🔧 wp ${(fnArgs.command ?? "").slice(0, 100)}`;
  if (fnName === "schedule_task")
    return reason ? `⏰ ${reason.slice(0, 120)}` : `⏰ Scheduling: ${(fnArgs.label ?? fnArgs.task ?? "").slice(0, 80)}`;
  if (fnName === "read_file")
    return reason ? `📖 ${reason.slice(0, 120)}` : `📖 Reading: ${(fnArgs.path ?? "").slice(0, 100)}`;
  if (fnName === "write_file")
    return reason ? `📝 ${reason.slice(0, 120)}` : `📝 Writing: ${(fnArgs.path ?? "").slice(0, 100)}`;
  if (fnName === "reply_to_forum")
    return reason ? `💬 ${reason.slice(0, 120)}` : `💬 Replying to forum post ${fnArgs.post_id ?? ""}`;
  if (fnName === "fetch_page")
    return reason ? `🌍 ${reason.slice(0, 120)}` : `🌍 Fetching: ${(fnArgs.url ?? "").slice(0, 100)}`;
  if (fnName.startsWith("skill_"))
    return reason ? `🔌 ${reason.slice(0, 120)}` : `🔌 Skill: ${fnName.replace(/^skill_/, "")}`;
  if (fnName.startsWith("wp_ability__"))
    return reason ? `🔮 ${reason.slice(0, 120)}` : `🔮 WP: ${fnName.slice("wp_ability__".length).replace(/_/g, " ")}`;
  if (fnName.startsWith("mcp_server_github__"))
    return reason
      ? `🐙 ${reason.slice(0, 120)}`
      : `🐙 GitHub: ${fnName.slice("mcp_server_github__".length).replace(/_/g, " ")}`;
  if (fnName.startsWith("mcp_"))
    return reason ? `🔗 ${reason.slice(0, 120)}` : `🔗 MCP: ${fnName.slice(4).replace(/_/g, " ")}`;
  return `⚙️ ${reason || fnName}`;
}
