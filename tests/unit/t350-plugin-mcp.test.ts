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
  test("a declared .mcp.json and grants to its servers validate cleanly", () => {
    const result = validate(acme({ mcp: MCP_CONFIG }));
    expect(result.valid).toBe(true);
    expect(result.warnings.filter((w) => w.rule !== "compose-hook-absent")).toEqual([]);
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

  test("the build ships the MCP servers to every harness in the form it reads", () => {
    const root = acme({ mcp: MCP_CONFIG });
    const source = readFileSync(join(root, ".mcp.json"));
    for (const harness of ["copilot", "claude"]) {
      expect(readFileSync(join(build(root, harness), ".mcp.json")).equals(source)).toBe(true);
    }
    const codex = build(root, "codex");
    expect(JSON.parse(readFileSync(join(codex, ".codex-plugin", "plugin.json"), "utf-8")).mcpServers)
      .toBe("./.mcp.json");
    const codexServers = JSON.parse(readFileSync(join(codex, ".mcp.json"), "utf-8")).mcpServers;
    expect(codexServers.servicenow).toEqual({ type: "streamable-http", url: "https://example.service-now.com/mcp" });
    expect(codexServers["acme-tickets"]).toEqual(MCP_CONFIG.mcpServers["acme-tickets"]);
    const cursor = build(root, "cursor");
    expect(JSON.parse(readFileSync(join(cursor, ".cursor-plugin", "plugin.json"), "utf-8")).mcpServers)
      .toBe("./mcp.json");
    expect(readFileSync(join(cursor, "mcp.json")).equals(source)).toBe(true);
    for (const harness of ["kiro", "kiro-ide", "opencode"]) {
      const out = build(root, harness);
      expect(readFileSync(join(out, ".aidlc-mcp.json")).equals(source)).toBe(true);
      expect(existsSync(join(out, ".mcp.json"))).toBe(false);
    }
    const plain = build(acme(), "cursor");
    expect(JSON.parse(readFileSync(join(plain, ".cursor-plugin", "plugin.json"), "utf-8")).mcpServers)
      .toBeUndefined();
    expect(existsSync(join(plain, "mcp.json"))).toBe(false);
  }, 120_000);

  function composeInto(harness: "kiro" | "kiro-ide" | "opencode", plugin: string): string {
    fresh++;
    const project = join(scratch, `${harness}-project-${fresh}`);
    cpSync(join(REPO_ROOT, "dist", harness), project, { recursive: true });
    const leaf = harness === "opencode" ? ".aidlc" : ".kiro";
    const sync = run([join(project, leaf, "tools", "aidlc-plugin.ts"), "sync"], {
      AIDLC_PLUGIN_ROOT: plugin,
      AIDLC_PROJECT_DIR: project,
      AIDLC_HARNESS_DIR: leaf,
      AIDLC_HARNESS_NAME: harness,
      CLAUDE_PLUGIN_ROOT: "",
      PLUGIN_ROOT: "",
      CLAUDE_PROJECT_DIR: "",
    });
    expect(sync.status, sync.stderr + sync.stdout).toBe(0);
    return project;
  }

  test("compose on Kiro CLI adds the servers to the workspace, and the conductor its tools and guard", () => {
    const plugin = build(acme({ mcp: MCP_CONFIG }), "kiro");
    const stockConductor = readFileSync(join(REPO_ROOT, "dist", "kiro", ".kiro", "agents", "aidlc.json"), "utf-8");
    const project = composeInto("kiro", plugin);
    const servers = JSON.parse(readFileSync(join(project, ".kiro", "settings", "mcp.json"), "utf-8")).mcpServers;
    expect(servers.servicenow).toEqual(MCP_CONFIG.mcpServers.servicenow);
    expect(servers["acme-tickets"].args[1]).toBe(`exec node "${plugin}/mcp/tickets.js"`);
    expect(servers.context7).toBeDefined();
    const conductor = JSON.parse(readFileSync(join(project, ".kiro", "agents", "aidlc.json"), "utf-8"));
    expect(conductor.tools).toEqual(expect.arrayContaining(["@servicenow", "@acme-tickets"]));
    expect(Object.keys(conductor.mcpServers).sort()).toEqual(["acme-tickets", "servicenow"]);
    const guardHooks = conductor.hooks.preToolUse.filter((hook: { matcher: string }) => hook.matcher.startsWith("@"));
    expect(guardHooks.map((hook: { matcher: string }) => hook.matcher).sort()).toEqual(["@acme-tickets", "@servicenow"]);
    expect(guardHooks[0].command).toMatch(/plan-approval-guard$/);

    // Installing a changed plugin again takes out exactly what compose merged
    // before and merges the new servers: here, none.
    rmSync(join(plugin, ".aidlc-mcp.json"));
    const again = run([join(project, ".kiro", "tools", "aidlc-plugin.ts"), "sync"], {
      AIDLC_PLUGIN_ROOT: plugin,
      AIDLC_PROJECT_DIR: project,
      AIDLC_HARNESS_DIR: ".kiro",
      AIDLC_HARNESS_NAME: "kiro",
      CLAUDE_PLUGIN_ROOT: "",
      PLUGIN_ROOT: "",
      CLAUDE_PROJECT_DIR: "",
    });
    expect(again.status, again.stderr).toBe(0);
    expect(readFileSync(join(project, ".kiro", "agents", "aidlc.json"), "utf-8")).toBe(stockConductor);
    const after = JSON.parse(readFileSync(join(project, ".kiro", "settings", "mcp.json"), "utf-8")).mcpServers;
    expect(after.servicenow).toBeUndefined();
    expect(after.context7).toBeDefined();
    expect(existsSync(join(project, ".kiro", "tools", "data", "plugin-mcp-acme.json"))).toBe(false);
  }, 120_000);

  test("compose on Kiro IDE grants a persona its MCP tools", () => {
    const project = composeInto("kiro-ide", build(acme({ mcp: MCP_CONFIG }), "kiro-ide"));
    expect(JSON.parse(readFileSync(join(project, ".kiro", "settings", "mcp.json"), "utf-8")).mcpServers.servicenow)
      .toEqual(MCP_CONFIG.mcpServers.servicenow);
    const agent = readFileSync(join(project, ".kiro", "agents", "acme-operator-agent.md"), "utf-8");
    expect(agent).toContain('"@servicenow/create_change_request", "@acme-tickets"]');
  }, 60_000);

  test("compose on OpenCode adds the servers to opencode.json in OpenCode's shape", () => {
    const plugin = build(acme({ mcp: MCP_CONFIG }), "opencode");
    const project = composeInto("opencode", plugin);
    const config = JSON.parse(readFileSync(join(project, "opencode.json"), "utf-8"));
    expect(config.mcp.servicenow).toEqual({ type: "remote", url: "https://example.service-now.com/mcp", enabled: true });
    expect(config.mcp["acme-tickets"]).toEqual({
      type: "local",
      command: ["sh", "-c", `exec node "${plugin}/mcp/tickets.js"`],
      enabled: true,
    });
    expect(config.skills).toBeDefined();
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
