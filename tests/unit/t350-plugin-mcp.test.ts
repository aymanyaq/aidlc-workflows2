// covers: file:core/tools/aidlc-plugin-validate.ts, file:core/tools/aidlc-plugin-emit.ts,
// file:scripts/plugin-hooks-template/compose.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t350-"));
const tools = join(scratch, "runtime", "tools");
cpSync(join(REPO_ROOT, "dist", "claude", ".claude", "tools"), tools, { recursive: true });
let fresh = 0;

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

type Finding = { file: string; rule: string; message: string };

function run(command: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, command, {
    cwd: scratch,
    encoding: "utf-8",
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

const MCP_CONFIG = {
  mcpServers: {
    servicenow: { type: "http", url: "https://example.service-now.com/mcp" },
    "acme-tickets": {
      type: "stdio",
      command: "sh",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal MCP config placeholder, expanded by the host or the shell
      args: ["-c", 'exec node "${CLAUDE_PLUGIN_ROOT}/mcp/tickets.js"'],
    },
  },
};

function acme(options: { mcp?: unknown; grants?: string } = {}): string {
  fresh++;
  const root = join(scratch, `plugins-${fresh}`, "acme");
  mkdirSync(join(root, ".aidlc-plugin"), { recursive: true });
  writeFileSync(join(root, ".aidlc-plugin", "plugin.json"), `${JSON.stringify({
    name: "acme",
    version: "0.1.0",
    description: "Acts on the change system",
    author: { name: "Fixture" },
    dependencies: ["core"],
    aidlc: { contributes: { agents: "agents/" } },
  }, null, 2)}\n`);
  mkdirSync(join(root, "agents"), { recursive: true });
  writeFileSync(join(root, "agents", "acme-operator-agent.md"), [
    "---",
    "name: acme-operator-agent",
    "display_name: Change Operator",
    "plugin: acme",
    "description: Files approved change requests.",
    "disallowedTools: Task",
    options.grants ?? "mcp_tools:\n  - servicenow/create_change_request\n  - acme-tickets/*",
    "---",
    "",
    "# Change Operator",
    "",
  ].join("\n"));
  if (options.mcp !== undefined) {
    writeFileSync(
      join(root, ".mcp.json"),
      typeof options.mcp === "string" ? options.mcp : `${JSON.stringify(options.mcp, null, 2)}\n`,
    );
  }
  return root;
}

function validate(root: string): { valid: boolean; errors: Finding[]; warnings: Finding[] } {
  return JSON.parse(run([join(tools, "aidlc-plugin-validate.ts"), root, "--json"]).stdout);
}

function build(root: string, harness: string): string {
  fresh++;
  const out = join(scratch, `build-${fresh}`, harness);
  const result = run([join(tools, "aidlc-plugin-build.ts"), root, harness, out]);
  expect(result.status, result.stderr).toBe(0);
  return out;
}

describe("t350 plugin MCP servers and agent MCP grants", () => {
  test("a declared .mcp.json and grants to its servers validate, with the harness note", () => {
    const result = validate(acme({ mcp: MCP_CONFIG }));
    expect(result.valid).toBe(true);
    expect(result.warnings.map((w) => w.rule)).toContain("mcp-harnesses");
    expect(result.warnings.filter((w) => w.rule === "agent-mcp-tools")).toEqual([]);
  });

  test("malformed MCP config and grants are refused; a grant to an undeclared server warns", () => {
    expect(validate(acme({ mcp: "{not-json" })).errors.map((e) => e.rule)).toContain("mcp-config");
    expect(validate(acme({ mcp: { servers: {} } })).errors[0]?.message)
      .toContain("mcp.json must be a JSON object with an mcpServers object");
    expect(validate(acme({ mcp: { mcpServers: { broken: { type: "stdio" } } } })).errors[0]?.message)
      .toContain('MCP server "broken" needs a command (local) or a url (remote)');
    const badGrant = validate(acme({ mcp: MCP_CONFIG, grants: "mcp_tools: [servicenow, servicenow/create_change_request]" }));
    expect(badGrant.errors).toEqual([expect.objectContaining({
      rule: "agent-mcp-tools",
      message: 'mcp_tools entry "servicenow" must be <server>/<tool> or <server>/*',
    })]);
    const undeclared = validate(acme({ grants: "mcp_tools: [jira/create_issue]" }));
    expect(undeclared.valid).toBe(true);
    expect(undeclared.warnings).toContainEqual(expect.objectContaining({
      rule: "agent-mcp-tools",
      message: 'MCP server "jira" is not declared in this plugin\'s .mcp.json',
    }));
  });

  test("the build ships .mcp.json to the Copilot and Claude plugins only", () => {
    const root = acme({ mcp: MCP_CONFIG });
    const source = readFileSync(join(root, ".mcp.json"));
    for (const harness of ["copilot", "claude"]) {
      expect(readFileSync(join(build(root, harness), ".mcp.json")).equals(source)).toBe(true);
    }
    expect(existsSync(join(build(root, "codex"), ".mcp.json"))).toBe(false);
  }, 60_000);

  test("compose on Copilot grants an agent its MCP tools through the custom-agent tools list", () => {
    const plugin = build(acme({ mcp: MCP_CONFIG }), "copilot");
    const agentPath = join(plugin, "agents", "acme-operator-agent.md");
    writeFileSync(
      agentPath,
      readFileSync(agentPath, "utf-8").replace("  - acme-tickets/*", "  - acme-tickets/*\n  - not a grant"),
    );
    fresh++;
    const project = join(scratch, `copilot-project-${fresh}`);
    cpSync(join(REPO_ROOT, "dist", "copilot"), project, { recursive: true });
    const sync = run([join(project, ".aidlc", "tools", "aidlc-plugin.ts"), "sync"], {
      AIDLC_PLUGIN_ROOT: plugin,
      AIDLC_PROJECT_DIR: project,
      AIDLC_HARNESS_DIR: ".aidlc",
      AIDLC_HARNESS_NAME: "copilot",
      CLAUDE_PLUGIN_ROOT: "",
      PLUGIN_ROOT: "",
      CLAUDE_PROJECT_DIR: "",
    });
    expect(sync.status, sync.stderr).toBe(0);
    const agent = readFileSync(join(project, ".github", "agents", "acme-operator-agent.md"), "utf-8");
    expect(agent).toContain(
      'tools: ["read", "edit", "search", "execute", "web", "todo", "servicenow/create_change_request", "acme-tickets/*"]',
    );
    expect(agent).not.toContain("mcp_tools");
    expect(agent).not.toContain("not a grant");
    const health = join(project, "aidlc");
    const drops = readdirSync(health, { recursive: true })
      .map(String)
      .filter((file) => file.endsWith("plugin-compose-acme.drops"));
    expect(drops.length).toBe(1);
    expect(readFileSync(join(health, drops[0]), "utf-8")).toContain(
      'mcp_tools entry "not a grant" is not <server>/<tool> or <server>/*; not granted',
    );
  }, 60_000);
});
