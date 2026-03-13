import { MyContext } from "./types";
import { AGENT_URL } from "./config";
import { agentAxios, externalAxios } from "./http";
import { sanitize, clearFlows } from "./utils";

export function githubToRaw(url: string): string {
  const m = url.trim().match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (m) return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
  return url.trim();
}

export function isGithubSkillFileUrl(text: string): boolean {
  text = text.trim();
  if (/\s/.test(text)) return false;
  return /^https:\/\/(?:github\.com\/[^/]+\/[^/]+\/blob\/|raw\.githubusercontent\.com\/[^/]+\/[^/]+\/)[^\s]+\.(?:ya?ml|md|js)$/.test(
    text,
  );
}

export function parseGithubRepoUrl(url: string): { owner: string; repo: string; branch: string; path: string } | null {
  url = url.trim().replace(/\/+$/, "");
  let m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/?#]+)$/);
  if (m) return { owner: m[1], repo: m[2], branch: "", path: "" };
  m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.+))?$/);
  if (m) return { owner: m[1], repo: m[2], branch: m[3], path: m[4] ?? "" };
  return null;
}

export function isGithubRepoUrl(text: string): boolean {
  text = text.trim();
  if (/\s/.test(text)) return false;
  return parseGithubRepoUrl(text) !== null;
}

const EXCLUDED_MD = new Set(["readme", "contributing", "changelog", "license", "code_of_conduct", "security"]);

function isSkillFile(path: string): boolean {
  const lower = path.toLowerCase();
  if (/\.ya?ml$/i.test(lower)) return true;
  if (/\.md$/i.test(lower)) {
    const basename = lower.split("/").pop()?.replace(/\.md$/, "") ?? "";
    return !EXCLUDED_MD.has(basename);
  }
  if (/\.js$/i.test(lower) && /(?:^|\/|\\)scripts\//i.test(lower)) return true;
  return false;
}

async function listGithubSkillFiles(
  owner: string,
  repo: string,
  branch: string,
  pathPrefix: string,
): Promise<{ files: string[]; warn: string; branch: string }> {
  const headers = { Accept: "application/vnd.github.v3+json", "User-Agent": "greenclaw-bot/1.0" };

  if (!branch) {
    const r = await externalAxios.get(`https://api.github.com/repos/${owner}/${repo}`, { headers, timeout: 15_000 });
    if (r.status !== 200) throw new Error(`HTTP ${r.status} fetching repo info`);
    branch = r.data.default_branch ?? "main";
  }

  const r = await externalAxios.get(`https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, {
    headers,
    timeout: 25_000,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status} from GitHub API`);

  const tree: any[] = r.data.tree ?? [];
  const truncated: boolean = r.data.truncated ?? false;
  const prefix = pathPrefix ? pathPrefix.replace(/\/+$/, "") + "/" : "";

  const files = tree
    .filter((item) => item.type === "blob" && isSkillFile(item.path) && (!prefix || item.path.startsWith(prefix)))
    .map((item) => item.path as string)
    .sort();

  const warn = truncated ? "_(Note: repo has too many files; list may be incomplete)_" : "";
  return { files, warn, branch };
}

export async function installSkillFromUrl(ctx: MyContext, url: string): Promise<void> {
  const rawUrl = githubToRaw(url);
  const isMd = /\.md$/i.test(rawUrl);
  const isJs = /\.js$/i.test(rawUrl);
  const statusMsg = await ctx.reply("⬇️ Downloading skill from GitHub…");
  try {
    const r = await externalAxios.get(rawUrl, { timeout: 30_000, responseType: "text" });
    if (r.status !== 200) {
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        `❌ Failed to download skill: HTTP ${r.status}`,
      );
      return;
    }
    const content = typeof r.data === "string" ? r.data : String(r.data);
    const fileName = rawUrl.split("/").pop()!;
    let body: Record<string, string>;
    if (isJs) body = { script: content, name: fileName.replace(/\.js$/i, "") };
    else if (isMd) body = { markdown: content, name: fileName.replace(/\.md$/i, "") };
    else body = { yaml: content };
    const r2 = await agentAxios.post(`${AGENT_URL}/skills`, body, { timeout: 15_000 });
    if (r2.data.error) {
      await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `❌ Invalid skill: ${r2.data.error}`);
      return;
    }
    const name = r2.data.name ?? "?";
    const label = isJs ? "script tool" : isMd ? "knowledge skill" : "tool skill";
    await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, `✅ Skill "${name}" installed as ${label}!`);
  } catch (e: any) {
    const detail = e?.response?.data?.error ?? e?.message ?? String(e);
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `❌ Download/install failed: ${sanitize(detail)}`,
    );
  }
}

export async function browseGithubSkills(
  ctx: MyContext,
  repoInfo: { owner: string; repo: string; branch: string; path: string },
): Promise<void> {
  const { owner, repo, path } = repoInfo;
  let { branch } = repoInfo;

  const loc = `\`${owner}/${repo}\`` + (path ? `\`/${path}\`` : "");
  const statusMsg = await ctx.reply(`🔍 Scanning ${loc} for skill files…`, { parse_mode: "Markdown" });

  let files: string[], warn: string;
  try {
    ({ files, warn, branch } = await listGithubSkillFiles(owner, repo, branch, path));
  } catch (e) {
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `❌ GitHub API error: ${sanitize(String(e))}`,
    );
    return;
  }

  if (!files.length) {
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      `❌ No \`.yaml\`/\`.yml\` files found in ${loc}.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  clearFlows(ctx);
  ctx.session.skillBrowseRepo = { owner, repo, branch };
  ctx.session.skillBrowseFiles = files;
  ctx.session.skillBrowseStep = "waiting";

  const MAX_SHOWN = 40;
  const shown = files.slice(0, MAX_SHOWN);
  const lines = [`📦 Found *${files.length}* skill file(s) in \`${owner}/${repo}\`:\n`];
  shown.forEach((f, i) => lines.push(`\`${i + 1}.\` \`${f}\``));
  if (files.length > MAX_SHOWN) lines.push(`\n_…and ${files.length - MAX_SHOWN} more (first ${MAX_SHOWN} shown)_`);
  if (warn) lines.push(`\n${warn}`);
  lines.push(
    "\nReply with:\n" +
      "• A number — e.g. `3`\n" +
      "• Multiple numbers — e.g. `1 3 5`\n" +
      "• A range — e.g. `2-5`\n" +
      "• `all` — install everything\n" +
      "• `/cancel` to abort",
  );
  await ctx.api.editMessageText(statusMsg.chat.id, statusMsg.message_id, lines.join("\n"), { parse_mode: "Markdown" });
}

export async function handleSkillBrowseStep(ctx: MyContext): Promise<boolean> {
  if (ctx.session.skillBrowseStep !== "waiting") return false;
  const text = (ctx.message?.text ?? "").trim();
  if (!text) return false;

  const files = ctx.session.skillBrowseFiles ?? [];
  const repoMeta = ctx.session.skillBrowseRepo ?? { owner: "", repo: "", branch: "main" };

  const selected = new Set<number>();
  if (text.toLowerCase() === "all") {
    for (let i = 0; i < files.length; i++) selected.add(i);
  } else {
    for (const token of text.split(/[\s,]+/)) {
      const rangeM = token.match(/^(\d+)-(\d+)$/);
      if (rangeM) {
        const lo = parseInt(rangeM[1], 10),
          hi = parseInt(rangeM[2], 10);
        for (let i = lo; i <= Math.min(hi, files.length); i++) {
          if (i >= 1) selected.add(i - 1);
        }
      } else if (/^\d+$/.test(token)) {
        const i = parseInt(token, 10);
        if (i >= 1 && i <= files.length) selected.add(i - 1);
      }
    }
  }

  if (!selected.size) {
    await ctx.reply("❓ Please reply with a number, range, or `all`.\nExample: `3`, `1 2 5`, `2-4`, `all`", {
      parse_mode: "Markdown",
    });
    return true;
  }

  delete ctx.session.skillBrowseStep;
  delete ctx.session.skillBrowseFiles;
  delete ctx.session.skillBrowseRepo;

  const chosen = [...selected].sort((a, b) => a - b).map((i) => files[i]);

  const statusMsg =
    chosen.length === 1
      ? await ctx.reply(`⬇️ Installing \`${chosen[0]}\`…`, { parse_mode: "Markdown" })
      : await ctx.reply(`⬇️ Installing ${chosen.length} skill(s)…`);

  const results: string[] = [];
  for (const fpath of chosen) {
    const rawUrl = `https://raw.githubusercontent.com/${repoMeta.owner}/${repoMeta.repo}/${repoMeta.branch}/${fpath}`;
    try {
      const r = await externalAxios.get(rawUrl, { timeout: 20_000, responseType: "text" });
      if (r.status !== 200) {
        results.push(`❌ \`${fpath}\` — HTTP ${r.status}`);
        continue;
      }

      const isMd = /\.md$/i.test(fpath);
      const isJs = /\.js$/i.test(fpath);
      const content = typeof r.data === "string" ? r.data : String(r.data);
      const fileName = fpath.split("/").pop()!;
      let body: Record<string, string>;
      if (isJs) body = { script: content, name: fileName.replace(/\.js$/i, "") };
      else if (isMd) body = { markdown: content, name: fileName.replace(/\.md$/i, "") };
      else body = { yaml: content };
      const r2 = await agentAxios.post(`${AGENT_URL}/skills`, body, { timeout: 15_000 });
      if (r2.data.error) {
        results.push(`❌ ${fpath} — ${r2.data.error}`);
      } else {
        const label = isJs ? " (script tool)" : isMd ? " (knowledge)" : "";
        results.push(`✅ ${r2.data.name ?? fpath}${label}`);
      }
    } catch (e: any) {
      const detail = e?.response?.data?.error ?? e?.message ?? String(e);
      results.push(`❌ ${fpath} — ${sanitize(detail)}`);
    }
  }

  try {
    await ctx.api.editMessageText(
      statusMsg.chat.id,
      statusMsg.message_id,
      "📦 Install results:\n\n" + results.join("\n"),
    );
  } catch {
    await ctx.reply("📦 Install results:\n\n" + results.join("\n"));
  }
  return true;
}
