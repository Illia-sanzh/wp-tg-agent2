import { describe, it, expect } from "vitest";
import * as path from "path";
import * as yaml from "js-yaml";
import { FORBIDDEN_COMMANDS, WRITABLE_PATHS } from "../src/tool-impls";

function validateRunCommand(command: string): string | null {
  if (!command || !command.trim()) return "ERROR: No command provided.";
  const cmdLower = command.toLowerCase();
  for (const f of FORBIDDEN_COMMANDS) {
    if (cmdLower.includes(f)) return `ERROR: Command '${f}' is blocked for safety reasons.`;
  }
  return null;
}

const WP_PATH = "/wordpress";

function validateWritePath(filePath: string): string | null {
  if (!filePath) return "ERROR: No file path provided.";
  const normalized = path.resolve(filePath);
  const allowed = WRITABLE_PATHS.some((p) => normalized.startsWith(path.resolve(p)));
  if (!allowed) return `ERROR: Can only write to: ${WRITABLE_PATHS.join(", ")}`;
  return null;
}

function validateReadPath(filePath: string): string | null {
  if (!filePath) return "ERROR: No file path provided.";
  const normalized = path.resolve(filePath);
  const readablePaths = ["/tmp/", path.resolve(WP_PATH) + "/"];
  if (!readablePaths.some((p) => normalized.startsWith(p))) {
    return `ERROR: Can only read files under: ${readablePaths.join(", ")}`;
  }
  return null;
}

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

describe("runCommand validation", () => {
  it("rejects empty commands", () => {
    expect(validateRunCommand("")).toContain("ERROR");
    expect(validateRunCommand("   ")).toContain("ERROR");
  });

  it("blocks forbidden wp commands", () => {
    expect(validateRunCommand("wp db drop")).toContain("blocked");
    expect(validateRunCommand("wp db reset")).toContain("blocked");
    expect(validateRunCommand("wp site empty")).toContain("blocked");
    expect(validateRunCommand("wp eval 'echo 1'")).toContain("blocked");
    expect(validateRunCommand("wp eval-file /tmp/x.php")).toContain("blocked");
    expect(validateRunCommand("wp shell")).toContain("blocked");
  });

  it("blocks dangerous system commands", () => {
    expect(validateRunCommand("rm -rf /")).toContain("blocked");
    expect(validateRunCommand("mkfs /dev/sda1")).toContain("blocked");
    expect(validateRunCommand("dd if=/dev/zero of=/dev/sda")).toContain("blocked");
    expect(validateRunCommand("chmod 777 /")).toContain("blocked");
  });

  it("is case-insensitive", () => {
    expect(validateRunCommand("WP DB DROP")).toContain("blocked");
    expect(validateRunCommand("Wp Eval 'test'")).toContain("blocked");
  });

  it("allows safe commands", () => {
    expect(validateRunCommand("wp plugin list")).toBeNull();
    expect(validateRunCommand("ls -la /wordpress")).toBeNull();
    expect(validateRunCommand("wp post list --post_type=page")).toBeNull();
    expect(validateRunCommand("cat /wordpress/wp-config.php")).toBeNull();
  });

  it("blocks forbidden commands embedded in larger strings", () => {
    expect(validateRunCommand("echo test && wp db drop")).toContain("blocked");
    expect(validateRunCommand("wp eval-file /tmp/hack.php; ls")).toContain("blocked");
  });
});

describe("writeFile path validation", () => {
  it("rejects empty path", () => {
    expect(validateWritePath("")).toContain("ERROR");
  });

  it("allows writing to /tmp", () => {
    expect(validateWritePath("/tmp/test.txt")).toBeNull();
    expect(validateWritePath("/tmp/subdir/file.js")).toBeNull();
  });

  it("allows writing to wp-content/plugins", () => {
    expect(validateWritePath("/wordpress/wp-content/plugins/my-plugin/file.php")).toBeNull();
  });

  it("allows writing to wp-content/themes", () => {
    expect(validateWritePath("/wordpress/wp-content/themes/my-theme/style.css")).toBeNull();
  });

  it("allows writing to wp-content/mu-plugins", () => {
    expect(validateWritePath("/wordpress/wp-content/mu-plugins/custom.php")).toBeNull();
  });

  it("blocks writing to wp root", () => {
    expect(validateWritePath("/wordpress/wp-config.php")).toContain("ERROR");
  });

  it("blocks writing to system paths", () => {
    expect(validateWritePath("/etc/passwd")).toContain("ERROR");
    expect(validateWritePath("/root/.ssh/authorized_keys")).toContain("ERROR");
    expect(validateWritePath("/usr/bin/malicious")).toContain("ERROR");
  });

  it("blocks path traversal via ..", () => {
    expect(validateWritePath("/tmp/../etc/passwd")).toContain("ERROR");
    expect(validateWritePath("/wordpress/wp-content/plugins/../../wp-config.php")).toContain("ERROR");
  });

  it("blocks writing to wp-content root (not plugins/themes/mu-plugins)", () => {
    expect(validateWritePath("/wordpress/wp-content/uploads/shell.php")).toContain("ERROR");
    expect(validateWritePath("/wordpress/wp-content/index.php")).toContain("ERROR");
  });
});

describe("readFile path validation", () => {
  it("rejects empty path", () => {
    expect(validateReadPath("")).toContain("ERROR");
  });

  it("blocks reading system files", () => {
    expect(validateReadPath("/etc/passwd")).toContain("ERROR");
    expect(validateReadPath("/etc/shadow")).toContain("ERROR");
    expect(validateReadPath("/root/.bashrc")).toContain("ERROR");
  });

  it("blocks reading outside allowed paths", () => {
    expect(validateReadPath("/var/log/syslog")).toContain("ERROR");
    expect(validateReadPath("/usr/bin/node")).toContain("ERROR");
  });

  it("blocks path traversal", () => {
    expect(validateReadPath("/wordpress/../etc/passwd")).toContain("ERROR");
  });
});

describe("validateSkillYaml", () => {
  it("rejects invalid YAML", () => {
    expect(validateSkillYaml("{{invalid")).toContain("Invalid YAML");
  });

  it("rejects non-object YAML", () => {
    expect(validateSkillYaml("just a string")).toContain("mapping");
    const arrResult = validateSkillYaml("- item1\n- item2");
    expect(typeof arrResult).toBe("string");
  });

  it("requires name field", () => {
    expect(validateSkillYaml("type: command\ncommand: ls")).toContain("Missing required field: name");
  });

  it("validates name format", () => {
    expect(validateSkillYaml("name: bad-name\ntype: command\ncommand: ls")).toContain(
      "letters, numbers, and underscores",
    );
    expect(validateSkillYaml("name: has spaces\ntype: command\ncommand: ls")).toContain(
      "letters, numbers, and underscores",
    );
  });

  it("blocks builtin tool name conflicts", () => {
    expect(validateSkillYaml("name: run_command\ntype: command\ncommand: ls")).toContain("conflicts");
    expect(validateSkillYaml("name: read_file\ntype: command\ncommand: cat")).toContain("conflicts");
    expect(validateSkillYaml("name: wp_rest\ntype: http\nurl: http://example.com")).toContain("conflicts");
  });

  it("requires valid type", () => {
    expect(validateSkillYaml("name: test_skill\ntype: invalid")).toContain("must be one of");
  });

  it("requires command for command type", () => {
    expect(validateSkillYaml("name: test_skill\ntype: command")).toContain("'command' is required");
  });

  it("requires url for http type", () => {
    expect(validateSkillYaml("name: test_skill\ntype: http")).toContain("'url' is required");
  });

  it("requires url for webhook type", () => {
    expect(validateSkillYaml("name: test_skill\ntype: webhook")).toContain("'url' is required");
  });

  it("blocks forbidden commands in skills", () => {
    expect(validateSkillYaml("name: evil\ntype: command\ncommand: wp db drop")).toContain("blocked");
    expect(validateSkillYaml("name: evil\ntype: command\ncommand: rm -rf /")).toContain("blocked");
    expect(validateSkillYaml("name: evil\ntype: command\ncommand: wp eval 'system()'")).toContain("blocked");
  });

  it("accepts valid command skill", () => {
    const result = validateSkillYaml("name: list_plugins\ntype: command\ncommand: wp plugin list --format=json");
    expect(typeof result).toBe("object");
    expect((result as any).name).toBe("list_plugins");
  });

  it("accepts valid http skill", () => {
    const result = validateSkillYaml("name: check_api\ntype: http\nurl: https://api.example.com/status");
    expect(typeof result).toBe("object");
    expect((result as any).type).toBe("http");
  });

  it("accepts valid webhook skill", () => {
    const result = validateSkillYaml("name: notify_slack\ntype: webhook\nurl: https://hooks.slack.com/test");
    expect(typeof result).toBe("object");
    expect((result as any).type).toBe("webhook");
  });
});
