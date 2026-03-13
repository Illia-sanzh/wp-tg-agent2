import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import axios from "axios";
import { toFile } from "openai";
import { log, SKILLS_DIR } from "../config";
import { state } from "../state";
import { whisperClient } from "../http";
import { uploadMediaToWp } from "../tool-impls";
import { TOOLS } from "../tool-defs";
import {
  MCP_RUNNER_URL,
  loadCustomSkills,
  loadMarkdownSkillList,
  loadMcpTools,
  loadWpAbilities,
} from "../tool-loaders";
import { getMarkdownSkills } from "../prompt";
import multer from "multer";

export const adminRouter = Router();
const upload = multer({ storage: multer.memoryStorage() });

// Upload media to WordPress
adminRouter.post("/upload", upload.single("file"), async (req: Request, res: Response) => {
  if (!req.file) {
    res.status(400).json({ error: "No file in request" });
    return;
  }
  const result = await uploadMediaToWp(
    req.file.buffer,
    req.file.originalname ?? "upload.jpg",
    req.file.mimetype ?? "image/jpeg",
  );
  if (result.error) {
    res.status(502).json(result);
    return;
  }
  res.json(result);
});

// Whisper transcription
adminRouter.post("/transcribe", upload.single("file"), async (req: Request, res: Response) => {
  if (!whisperClient) {
    res.status(503).json({ error: "Voice transcription unavailable. Add OPENAI_API_KEY to .env to enable Whisper." });
    return;
  }
  if (!req.file) {
    res.status(400).json({ error: "No audio file provided (field: 'file')" });
    return;
  }

  const audioBuffer = req.file.buffer;
  const filename = req.file.originalname ?? "voice.ogg";
  const contentType = req.file.mimetype ?? "audio/ogg";

  try {
    const transcript = await whisperClient.audio.transcriptions.create({
      model: "whisper-1",
      file: await toFile(audioBuffer, filename, { type: contentType }),
    });
    log.info(`[transcribe] ${audioBuffer.length}B → ${transcript.text.slice(0, 80)}`);
    res.json({ text: transcript.text });
  } catch (e) {
    log.error({ err: e }, "whisper transcription failed");
    res.status(502).json({ error: `Transcription failed: ${e}` });
  }
});

// Schedules
adminRouter.get("/schedules", (_req, res) => {
  res.json({ jobs: state.scheduler?.getJobs() ?? [] });
});

adminRouter.delete("/schedules/:jobId", (req, res) => {
  try {
    state.scheduler?.removeJob(req.params.jobId);
    res.json({ status: "cancelled", id: req.params.jobId });
  } catch (e) {
    res.status(404).json({ error: String(e) });
  }
});

// Skills listing
adminRouter.get("/skills", (_req, res) => {
  let mdNames: string[] = [];
  try {
    mdNames = fs
      .readdirSync(SKILLS_DIR)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
  } catch {}
  const scriptsDir = path.join(SKILLS_DIR, "scripts");
  let scriptNames: string[] = [];
  try {
    scriptNames = fs
      .readdirSync(scriptsDir)
      .filter((f) => f.endsWith(".js"))
      .map((f) => f.replace(/\.js$/, ""))
      .sort();
  } catch {}
  res.json({
    builtin: TOOLS.map((t) => t.function.name),
    custom: state.cachedCustomTools.map((t) => t.function.name),
    markdown: mdNames,
    scripts: scriptNames,
    count: TOOLS.length + state.cachedCustomTools.length + mdNames.length + scriptNames.length,
  });
});

adminRouter.post("/reload-skills", (_req, res) => {
  const oldCount = state.cachedCustomTools.length;
  state.cachedCustomTools = loadCustomSkills();
  state.cachedMarkdownSkillList = loadMarkdownSkillList();
  state.cachedMarkdownSkills = getMarkdownSkills(["*"]);
  res.json({
    loaded: state.cachedCustomTools.length,
    previous: oldCount,
    skills: state.cachedCustomTools.map((t) => t.function.name),
  });
});

// Skill CRUD

const BUILTIN_TOOL_NAMES = new Set([
  "run_command",
  "read_file",
  "write_file",
  "wp_rest",
  "wp_cli_remote",
  "schedule_task",
  "reply_to_forum",
]);
const FORBIDDEN_SKILL_COMMANDS = [
  "wp db drop",
  "wp db reset",
  "wp site empty",
  "wp eval",
  "wp eval-file",
  "wp shell",
  "rm -rf /",
  "mkfs",
  "dd if=",
  "> /dev/sda",
  "chmod 777 /",
];

function validateSkillYaml(raw: string): Record<string, any> | string {
  let skill: Record<string, any>;
  try {
    skill = yaml.load(raw) as Record<string, any>;
  } catch (e) {
    return `Invalid YAML: ${e}`;
  }
  if (!skill || typeof skill !== "object") return "YAML must be a mapping (key: value) at the top level.";

  const name = (skill.name ?? "").trim();
  if (!name) return "Missing required field: name";
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return "Skill name must contain only letters, numbers, and underscores.";
  if (BUILTIN_TOOL_NAMES.has(name)) return `Name '${name}' conflicts with a built-in tool. Choose a different name.`;

  const skillType = (skill.type ?? "").trim();
  if (!["command", "http", "webhook"].includes(skillType)) return "Field 'type' must be one of: command, http, webhook";

  if (skillType === "command") {
    const cmd = (skill.command ?? "").trim();
    if (!cmd) return "Field 'command' is required for type: command";
    const cmdLower = cmd.toLowerCase();
    for (const f of FORBIDDEN_SKILL_COMMANDS)
      if (cmdLower.includes(f)) return `Command contains blocked operation: '${f}'`;
  }
  if (skillType === "http" || skillType === "webhook") {
    if (!(skill.url ?? "").trim()) return "Field 'url' is required for type: http/webhook";
  }

  return skill;
}

adminRouter.get("/skills/:name", (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    res.status(400).json({ error: "Invalid skill name" });
    return;
  }
  if (!fs.existsSync(SKILLS_DIR)) {
    res.status(404).json({ error: "Skills directory not found" });
    return;
  }

  const jsPath = path.join(SKILLS_DIR, "scripts", `${name}.js`);
  if (fs.existsSync(jsPath)) {
    const content = fs.readFileSync(jsPath, "utf8");
    res.json({ name, type: "script", content });
    return;
  }

  const mdPath = path.join(SKILLS_DIR, `${name}.md`);
  if (fs.existsSync(mdPath)) {
    const content = fs.readFileSync(mdPath, "utf8");
    res.json({ name, type: "markdown", content });
    return;
  }

  try {
    for (const file of fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".yaml"))) {
      const raw = fs.readFileSync(path.join(SKILLS_DIR, file), "utf8");
      const skill = yaml.load(raw) as Record<string, any>;
      if (skill?.name === name) {
        res.json({ name, type: "yaml", yaml: raw });
        return;
      }
    }
  } catch {}
  res.status(404).json({ error: `Skill '${name}' not found` });
});

adminRouter.post("/skills", (req, res) => {
  const body = req.body ?? {};

  // Markdown skill
  const mdContent = String(body.markdown ?? "").trim();
  const mdName = String(body.name ?? "").trim();
  if (mdContent) {
    if (!mdName) {
      res.status(400).json({ error: "Markdown skills require a 'name' field" });
      return;
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(mdName)) {
      res.status(400).json({ error: "Name must be alphanumeric (plus _ and -)" });
      return;
    }
    fs.mkdirSync(SKILLS_DIR, { recursive: true });
    const filePath = path.join(SKILLS_DIR, `${mdName}.md`);
    fs.writeFileSync(filePath, mdContent);
    state.cachedMarkdownSkillList = loadMarkdownSkillList();
    state.cachedMarkdownSkills = getMarkdownSkills(["*"]);
    log.info(`[skills] Markdown skill created/updated: ${mdName}`);
    res.json({ status: "created", name: mdName, type: "markdown", file: `${mdName}.md` });
    return;
  }

  // Script skill
  const scriptContent = String(body.script ?? "").trim();
  const scriptName = String(body.name ?? "").trim();
  if (scriptContent && scriptName) {
    if (!/^[a-zA-Z0-9_-]+$/.test(scriptName)) {
      res.status(400).json({ error: "Name must be alphanumeric (plus _ and -)" });
      return;
    }
    const scriptsDir = path.join(SKILLS_DIR, "scripts");
    fs.mkdirSync(scriptsDir, { recursive: true });
    fs.writeFileSync(path.join(scriptsDir, `${scriptName}.js`), scriptContent);
    const companionYaml = yaml.dump({
      name: scriptName,
      type: "command",
      description:
        `Run the ${scriptName}.js script. Accepts an input file path. ` +
        "For HTML-to-block conversion, write HTML to a temp file first, " +
        "then pass the file path. Output is the converted result.",
      command: `node /app/config/skills/scripts/${scriptName}.js {input_file}`,
      parameters: [
        {
          name: "input_file",
          description: "Path to the input file (e.g. /tmp/input.html)",
          type: "string",
          required: true,
        },
      ],
    });
    fs.writeFileSync(path.join(SKILLS_DIR, `${scriptName}.yaml`), companionYaml);
    state.cachedCustomTools = loadCustomSkills();
    log.info(`[skills] Script skill created: ${scriptName} (js + yaml wrapper)`);
    res.json({
      status: "created",
      name: scriptName,
      type: "script",
      tool_name: `skill_${scriptName}`,
      file: `${scriptName}.js`,
    });
    return;
  }

  // YAML skill
  const raw = String(body.yaml ?? "").trim();
  if (!raw) {
    res.status(400).json({ error: "Request body must include 'yaml', 'markdown', or 'script' field" });
    return;
  }

  const result = validateSkillYaml(raw);
  if (typeof result === "string") {
    res.status(400).json({ error: result });
    return;
  }

  const name = result.name;
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  fs.writeFileSync(path.join(SKILLS_DIR, `${name}.yaml`), raw);
  state.cachedCustomTools = loadCustomSkills();
  log.info(`[skills] Created/updated: ${name}`);
  res.json({ status: "created", name, tool_name: `skill_${name}`, file: `${name}.yaml` });
});

adminRouter.delete("/skills/:name", (req, res) => {
  const { name } = req.params;
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    res.status(400).json({ error: "Invalid skill name" });
    return;
  }
  if (!fs.existsSync(SKILLS_DIR)) {
    res.status(404).json({ error: "Skills directory not found" });
    return;
  }

  try {
    const jsPath = path.join(SKILLS_DIR, "scripts", `${name}.js`);
    if (fs.existsSync(jsPath)) {
      fs.unlinkSync(jsPath);
      const companion = path.join(SKILLS_DIR, `${name}.yaml`);
      if (fs.existsSync(companion)) fs.unlinkSync(companion);
      state.cachedCustomTools = loadCustomSkills();
      log.info(`[skills] Script skill deleted: ${name}`);
      res.json({ status: "deleted", name });
      return;
    }

    const mdPath = path.join(SKILLS_DIR, `${name}.md`);
    if (fs.existsSync(mdPath)) {
      fs.unlinkSync(mdPath);
      state.cachedMarkdownSkillList = loadMarkdownSkillList();
      state.cachedMarkdownSkills = getMarkdownSkills(["*"]);
      log.info(`[skills] Markdown skill deleted: ${name}`);
      res.json({ status: "deleted", name });
      return;
    }

    let found: string | null = null;
    for (const file of fs.readdirSync(SKILLS_DIR).filter((f) => f.endsWith(".yaml"))) {
      const s = yaml.load(fs.readFileSync(path.join(SKILLS_DIR, file), "utf8")) as Record<string, any>;
      if (s?.name === name) {
        found = file;
        break;
      }
    }
    if (!found) {
      res.status(404).json({ error: `Skill '${name}' not found` });
      return;
    }
    fs.unlinkSync(path.join(SKILLS_DIR, found));
    state.cachedCustomTools = loadCustomSkills();
    log.info(`[skills] Deleted: ${name}`);
    res.json({ status: "deleted", name });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// MCP proxy endpoints

async function mcpProxy(method: string, mcpPath: string, body?: any, timeout = 120_000) {
  return axios.request({ method, url: `${MCP_RUNNER_URL}${mcpPath}`, data: body, timeout, proxy: false });
}

adminRouter.get("/mcps", async (_req, res) => {
  try {
    const r = await mcpProxy("get", "/mcps", undefined, 10_000);
    res.status(r.status).json(r.data);
  } catch (e: any) {
    res.status(503).json({ error: `MCP runner unreachable: ${e.message}` });
  }
});

adminRouter.post("/mcps/install", async (req, res) => {
  try {
    const r = await mcpProxy("post", "/mcps/install", req.body, 120_000);
    if (r.status === 200 && !r.data.error) state.cachedMcpTools = await loadMcpTools();
    res.status(r.status).json(r.data);
  } catch (e: any) {
    res.status(503).json({ error: `MCP runner unreachable: ${e.message}` });
  }
});

adminRouter.delete("/mcps/:name", async (req, res) => {
  try {
    const r = await mcpProxy("delete", `/mcps/${req.params.name}`, undefined, 15_000);
    if (r.status === 200) state.cachedMcpTools = await loadMcpTools();
    res.status(r.status).json(r.data);
  } catch (e: any) {
    res.status(503).json({ error: `MCP runner unreachable: ${e.message}` });
  }
});

adminRouter.get("/mcps/:name/tools", async (req, res) => {
  try {
    const r = await mcpProxy("get", `/mcps/${req.params.name}/tools`, undefined, 10_000);
    res.status(r.status).json(r.data);
  } catch (e: any) {
    res.status(503).json({ error: `MCP runner unreachable: ${e.message}` });
  }
});

adminRouter.post("/reload-mcps", async (_req, res) => {
  const oldCount = state.cachedMcpTools.length;
  state.cachedMcpTools = await loadMcpTools();
  res.json({
    loaded: state.cachedMcpTools.length,
    previous: oldCount,
    tools: state.cachedMcpTools.map((t) => t.function.name),
  });
});

adminRouter.post("/reload-wp-abilities", async (_req, res) => {
  const oldCount = state.cachedWpAbilityTools.length;
  state.cachedWpAbilityTools = await loadWpAbilities();
  res.json({
    loaded: state.cachedWpAbilityTools.length,
    previous: oldCount,
    tools: state.cachedWpAbilityTools.map((t) => t.function.name),
  });
});
