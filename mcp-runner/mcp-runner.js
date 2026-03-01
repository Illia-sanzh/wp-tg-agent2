"use strict";
/**
 * OpenClaw MCP Runner
 * ───────────────────
 * Lightweight Express HTTP server that:
 *   1. Installs whitelisted MCP npm packages into /mcps/<name>/
 *   2. Spawns them on-demand as child processes (stdio transport)
 *   3. Exposes their tools via a simple REST API the Python agent calls
 *
 * All outbound network access goes through Squid (HTTP_PROXY env var).
 * API keys for MCP servers are stored AES-256-GCM encrypted in /mcps/<name>/env.json.
 *
 * Endpoints:
 *   GET  /health
 *   GET  /mcps                      — list installed MCPs + their tools
 *   POST /mcps/install              — { "package": "...", "name": "...", "env": {} }
 *   DELETE /mcps/:name              — remove an installed MCP
 *   GET  /mcps/:name/tools          — list tools for one MCP
 *   POST /mcps/:name/call           — { "tool": "...", "arguments": {} }
 */

const express    = require("express");
const { execSync, spawn } = require("child_process");
const fs         = require("fs");
const path       = require("path");
const crypto     = require("crypto");

const app  = express();
const PORT = 9000;
const MCPS_DIR = "/mcps";

app.use(express.json({ limit: "1mb" }));

// Must stay in sync with MCP_CATALOG in telegram-bot/bot.ts
const WHITELIST = new Set([
  "@0xshariq/docker-mcp-server",
  "@advanced-communities/salesforce-mcp-server",
  "@agentx-ai/mailchimp-mcp-server",
  "@apify/actors-mcp-server",
  "@atlassian-mcp-server/bitbucket",
  "@azure/mcp",
  "@benborla29/mcp-server-mysql",
  "@brave/brave-search-mcp-server",
  "@browserbasehq/mcp-server-browserbase",
  "@chykalophia/clickup-mcp-server",
  "@circleci/mcp-server-circleci",
  "@cloudflare/mcp-server-cloudflare",
  "@cocal/google-calendar-mcp",
  "@contentful/mcp-server",
  "@elastic/mcp-server-elasticsearch",
  "@ergut/mcp-bigquery-server",
  "@gpwork4u/google-sheets-mcp",
  "@hubspot/mcp-server",
  "@iflow-mcp/trello-mcp-server",
  "@kimtaeyoon83/mcp-server-youtube-transcript",
  "@mendable/firecrawl-mcp",
  "@microagents/mcp-server-dropbox",
  "@modelcontextprotocol/server-aws-kb-retrieval",
  "@modelcontextprotocol/server-everything",
  "@modelcontextprotocol/server-fetch",
  "@modelcontextprotocol/server-filesystem",
  "@modelcontextprotocol/server-gdrive",
  "@modelcontextprotocol/server-github",
  "@modelcontextprotocol/server-gitlab",
  "@modelcontextprotocol/server-google-maps",
  "@modelcontextprotocol/server-memory",
  "@modelcontextprotocol/server-postgres",
  "@modelcontextprotocol/server-puppeteer",
  "@modelcontextprotocol/server-redis",
  "@modelcontextprotocol/server-sequentialthinking",
  "@modelcontextprotocol/server-slack",
  "@modelcontextprotocol/server-sqlite",
  "@modelcontextprotocol/server-time",
  "@mongodb-js/mongodb-mcp-server",
  "@motherduck/mcp-server-duckdb",
  "@neondatabase/mcp-server-neon",
  "@notionhq/notion-mcp-server",
  "@open-mcp/vercel",
  "@perplexity-ai/mcp-server",
  "@pinecone-database/mcp",
  "@playwright/mcp",
  "@prama13/turso-mcp",
  "@qdrant/mcp-server-qdrant",
  "@ryukimin/ghost-mcp",
  "@sanity/mcp-server",
  "@sentry/mcp-server",
  "@stripe/mcp",
  "@supabase/mcp-server-supabase",
  "@tbrgeek/spotify-mcp-server",
  "@techsend/gmail-mcp-server",
  "@twilio-alpha/mcp",
  "@upstash/mcp-server",
  "@zereight/mcp-confluence",
  "aws-s3-mcp",
  "box-mcp-server",
  "datadog-mcp-server",
  "discord-mcp-server",
  "exa-mcp-server",
  "jira-mcp",
  "kubernetes-mcp-server",
  "linear-mcp-server",
  "mcp-server-commands",
  "openapi-mcp-server",
  "replicate-mcp",
  "resend-mcp",
  "shopify-mcp-server",
  "strapi-mcp",
  "tavily-mcp",
  "telegram-mcp-server",
  "terraform-mcp-server",
  "todoist-mcp-server",
  "typesense-mcp-server",
  "wordpress-mcp",
]);

// ── Encryption helpers (AES-256-GCM) ─────────────────────────────────────────
const ENC_SECRET = process.env.MCP_ENV_SECRET || "";

function encryptEnv(obj) {
  if (!ENC_SECRET || Object.keys(obj).length === 0) return null;
  const key   = Buffer.from(ENC_SECRET.slice(0, 64), "hex"); // 32 bytes
  const iv    = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plain  = JSON.stringify(obj);
  const enc    = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag    = cipher.getAuthTag();
  return { iv: iv.toString("hex"), tag: tag.toString("hex"), data: enc.toString("hex") };
}

function decryptEnv(stored) {
  if (!stored || !ENC_SECRET) return {};
  try {
    const key    = Buffer.from(ENC_SECRET.slice(0, 64), "hex");
    const iv     = Buffer.from(stored.iv, "hex");
    const tag    = Buffer.from(stored.tag, "hex");
    const data   = Buffer.from(stored.data, "hex");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain  = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(plain.toString("utf8"));
  } catch {
    return {};
  }
}

// ── Manifest helpers ──────────────────────────────────────────────────────────

function mcpDir(name)      { return path.join(MCPS_DIR, name); }
function manifestPath(name){ return path.join(mcpDir(name), "manifest.json"); }
function envPath(name)     { return path.join(mcpDir(name), "env.json"); }

function listInstalled() {
  if (!fs.existsSync(MCPS_DIR)) return [];
  return fs.readdirSync(MCPS_DIR).filter(n => {
    return fs.existsSync(manifestPath(n));
  });
}

function readManifest(name) {
  try { return JSON.parse(fs.readFileSync(manifestPath(name), "utf8")); }
  catch { return null; }
}

function readEnv(name) {
  try { return decryptEnv(JSON.parse(fs.readFileSync(envPath(name), "utf8"))); }
  catch { return {}; }
}

// ── Find the MCP server entry point ──────────────────────────────────────────

function findMcpBin(name, pkgName) {
  const dir   = mcpDir(name);
  const nmBin = path.join(dir, "node_modules", ".bin");
  // Try package.json bin field
  try {
    const pkg = JSON.parse(fs.readFileSync(
      path.join(dir, "node_modules", pkgName, "package.json"), "utf8"
    ));
    if (pkg.bin) {
      const binName = typeof pkg.bin === "string"
        ? path.join(dir, "node_modules", pkgName, pkg.bin)
        : Object.values(pkg.bin).map(b => path.join(dir, "node_modules", pkgName, b))[0];
      if (binName && fs.existsSync(binName)) return binName;
    }
    if (pkg.main) {
      const mainPath = path.join(dir, "node_modules", pkgName, pkg.main);
      if (fs.existsSync(mainPath)) return mainPath;
    }
  } catch {}
  // Fallback: look in .bin
  const short = pkgName.replace(/^@[^/]+\//, "");
  const binPath = path.join(nmBin, short);
  if (fs.existsSync(binPath)) return binPath;
  return null;
}

// ── Spawn MCP server and do JSON-RPC introspection ───────────────────────────

function introspectTools(name, pkgName, env) {
  return new Promise((resolve, reject) => {
    const bin = findMcpBin(name, pkgName);
    if (!bin) {
      console.warn(`[mcp-runner] No entry point found for ${pkgName}`);
      return resolve([]);
    }
    console.log(`[mcp-runner] Introspecting ${name} via ${bin}`);

    const proc = spawn("node", [bin], {
      env:   { ...process.env, ...env, PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buf = "";
    const tools = [];
    let phase = "init"; // init → list → done
    let stderr = "";
    const timeout = setTimeout(() => {
      console.warn(`[mcp-runner] Introspection timed out for ${name} (phase=${phase})`);
      proc.kill("SIGKILL");
      resolve(tools);
    }, 30000);

    proc.stdout.on("data", d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (phase === "init" && msg.id === 1) {
          console.log(`[mcp-runner] ${name}: initialized OK, requesting tools`);
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
          phase = "list";
        } else if (phase === "list" && msg.id === 2) {
          if (msg.result && msg.result.tools) tools.push(...msg.result.tools);
          console.log(`[mcp-runner] ${name}: discovered ${tools.length} tool(s)`);
          phase = "done";
          proc.stdin.end();
        }
      }
    });

    proc.stderr.on("data", d => { stderr += d.toString(); });

    proc.on("close", code => {
      clearTimeout(timeout);
      if (phase !== "done") {
        console.warn(`[mcp-runner] ${name}: process exited (code=${code}, phase=${phase})`);
        if (stderr) console.warn(`[mcp-runner] ${name} stderr: ${stderr.slice(0, 500)}`);
      }
      resolve(tools);
    });

    proc.on("error", err => {
      clearTimeout(timeout);
      console.warn(`[mcp-runner] ${name}: spawn error: ${err.message}`);
      resolve([]);
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {},
                clientInfo: { name: "openclaw-mcp-runner", version: "1.0" } },
    }) + "\n");
  });
}

// ── GET /health ────────────────────────────────────────────────────────────────

app.get("/health", (req, res) => {
  const installed = listInstalled();
  res.json({ status: "ok", installed: installed.length, mcps: installed });
});

// ── GET /mcps ─────────────────────────────────────────────────────────────────

app.get("/mcps", (req, res) => {
  const names = listInstalled();
  const mcps  = names.map(n => {
    const manifest = readManifest(n) || {};
    return { name: n, package: manifest.package || "", tools: manifest.tools || [] };
  });
  res.json({ mcps });
});

// ── POST /mcps/install ────────────────────────────────────────────────────────

app.post("/mcps/install", async (req, res) => {
  const { package: pkg, name: shortName, env: envVars = {} } = req.body || {};

  if (!pkg) return res.status(400).json({ error: "Missing 'package' field" });
  if (!WHITELIST.has(pkg)) {
    return res.status(403).json({ error: `Package '${pkg}' is not on the approved whitelist.` });
  }

  const name = shortName || pkg.replace(/^@[^/]+\//, "");
  const dir  = mcpDir(name);
  fs.mkdirSync(dir, { recursive: true });

  try {
    // npm install into isolated directory
    execSync(`npm install ${pkg} --prefix ${dir} --save`, {
      timeout: 90000,
      stdio:   "pipe",
      env:     process.env,
    });
  } catch (e) {
    return res.status(500).json({ error: `npm install failed: ${e.message}` });
  }

  // Store encrypted env vars
  if (Object.keys(envVars).length > 0) {
    const encrypted = encryptEnv(envVars);
    if (encrypted) fs.writeFileSync(envPath(name), JSON.stringify(encrypted));
  }

  // Introspect tools
  let tools = [];
  try {
    tools = await introspectTools(name, pkg, envVars);
  } catch (e) {
    console.warn(`[mcp-runner] Tool introspection failed for ${name}: ${e.message}`);
  }

  // Save manifest
  const manifest = { package: pkg, name, tools, installedAt: new Date().toISOString() };
  fs.writeFileSync(manifestPath(name), JSON.stringify(manifest, null, 2));

  res.json({ status: "installed", name, package: pkg, tools });
});

// ── DELETE /mcps/:name ────────────────────────────────────────────────────────

app.delete("/mcps/:name", (req, res) => {
  const name = req.params.name;
  const dir  = mcpDir(name);
  if (!fs.existsSync(dir) || !fs.existsSync(manifestPath(name))) {
    return res.status(404).json({ error: `MCP '${name}' not found` });
  }
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ status: "removed", name });
});

// ── GET /mcps/:name/tools ─────────────────────────────────────────────────────

app.get("/mcps/:name/tools", (req, res) => {
  const name     = req.params.name;
  const manifest = readManifest(name);
  if (!manifest) return res.status(404).json({ error: `MCP '${name}' not found` });
  res.json({ name, tools: manifest.tools || [] });
});

// ── POST /mcps/:name/call ─────────────────────────────────────────────────────

app.post("/mcps/:name/call", async (req, res) => {
  const name = req.params.name;
  const manifest = readManifest(name);
  if (!manifest) return res.status(404).json({ error: `MCP '${name}' not found` });

  const { tool, arguments: toolArgs = {} } = req.body || {};
  if (!tool) return res.status(400).json({ error: "Missing 'tool' field" });

  const env = readEnv(name);

  try {
    const result = await callMcpTool(name, manifest.package, env, tool, toolArgs);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Spawn MCP server, initialize properly, then call a tool ──────────────────

function callMcpTool(name, pkgName, env, tool, toolArgs) {
  return new Promise((resolve, reject) => {
    const bin = findMcpBin(name, pkgName);
    if (!bin) return reject(new Error(`Cannot find entry point for ${pkgName}`));

    const proc = spawn("node", [bin], {
      env:   { ...process.env, ...env, PATH: process.env.PATH },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buf = "";
    let phase = "init";
    const timeout = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error("MCP process timed out after 30s"));
    }, 30000);

    proc.stdout.on("data", d => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (phase === "init" && msg.id === 1) {
          proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
          proc.stdin.write(JSON.stringify({
            jsonrpc: "2.0", id: 2, method: "tools/call",
            params: { name: tool, arguments: toolArgs },
          }) + "\n");
          phase = "call";
        } else if (phase === "call" && msg.id === 2) {
          phase = "done";
          proc.stdin.end();
          if (msg.error) {
            resolve({ error: msg.error.message || JSON.stringify(msg.error) });
          } else {
            const content = msg.result?.content || [];
            const text = content.map(c => c.text || JSON.stringify(c)).join("\n");
            resolve({ result: text, raw: msg.result });
          }
        }
      }
    });

    proc.stderr.on("data", () => {});

    proc.on("close", () => {
      clearTimeout(timeout);
      if (phase !== "done") resolve({ error: "No response from MCP server" });
    });

    proc.on("error", err => {
      clearTimeout(timeout);
      reject(err);
    });

    proc.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {},
                clientInfo: { name: "openclaw-mcp-runner", version: "1.0" } },
    }) + "\n");
  });
}

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[mcp-runner] Listening on port ${PORT}`);
  const installed = listInstalled();
  console.log(`[mcp-runner] ${installed.length} MCP(s) installed: ${installed.join(", ") || "none"}`);
});
