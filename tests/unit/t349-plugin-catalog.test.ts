// covers: file:core/tools/aidlc-plugin-catalog.ts

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { discoverPluginInventory } from "../../core/tools/aidlc-plugin.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SOURCE_TOOLS = join(REPO_ROOT, "dist", "claude", ".claude", "tools");
const SOURCE_PLUGIN = join(REPO_ROOT, "plugins", "test-pro");
const ORIGINAL_ENV = { ...process.env };
const scratch = mkdtempSync(join(tmpdir(), "aidlc-t349-"));
const tools = join(scratch, "runtime", "tools");
cpSync(SOURCE_TOOLS, tools, { recursive: true });
let fresh = 0;

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function run(tool: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [join(tools, tool), ...args], {
    cwd: scratch,
    encoding: "utf-8",
  });
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

function catalog(args: string[]): { status: number | null; stdout: string; stderr: string } {
  return run("aidlc-plugin-catalog.ts", args);
}

function path(label: string): string {
  fresh++;
  return join(scratch, `${label}-${fresh}`);
}

function plugin(name: string, description = `${name} workflow`): string {
  const root = join(path("plugins"), name);
  mkdirSync(join(root, ".aidlc-plugin"), { recursive: true });
  writeFileSync(join(root, ".aidlc-plugin", "plugin.json"), `${JSON.stringify({
    name,
    version: "1.2.0",
    description,
    author: { name: "Fixture" },
    dependencies: ["core"],
    aidlc: { contributes: { tools: "tools/" } },
  }, null, 2)}\n`);
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools", `${name}-tool.ts`), 'console.log("fixture");\n');
  return root;
}

function testPro(): string {
  const root = join(path("sources"), "test-pro");
  cpSync(SOURCE_PLUGIN, root, { recursive: true });
  return root;
}

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const file = join(directory, entry);
      if (statSync(file).isDirectory()) visit(file);
      else files[relative(root, file)] = readFileSync(file).toString("base64");
    }
  };
  visit(root);
  return files;
}

describe("t349 plugin catalogue", () => {
  test("one catalogue lists every plugin for each host, from that host's manifest directory", () => {
    const out = path("catalog");
    const result = catalog([
      out,
      plugin("beta"),
      plugin("alpha"),
      "--harness",
      "copilot,claude",
      "--name",
      "org-workflows",
      "--owner",
      "Platform team",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Plugin catalogue: COMPLETE");

    const listing = (harness: string): Record<string, unknown> => ({
      name: "org-workflows",
      owner: { name: "Platform team" },
      description: "AIDLC workflow catalogue.",
      plugins: ["alpha", "beta"].map((key) => ({
        name: `aidlc-${key}`,
        source: `./${harness}/${key}`,
        version: "1.2.0",
        description: `${key} workflow`,
      })),
    });
    expect(json(join(out, ".plugin", "marketplace.json"))).toEqual(listing("copilot"));
    expect(json(join(out, ".claude-plugin", "marketplace.json"))).toEqual(listing("claude"));
    expect(existsSync(join(out, "marketplace.json"))).toBe(false);
    for (const key of ["alpha", "beta"]) {
      expect(json(join(out, "copilot", key, ".plugin", "plugin.json")).name).toBe(`aidlc-${key}`);
      expect(json(join(out, "claude", key, ".claude-plugin", "plugin.json")).name).toBe(`aidlc-${key}`);
    }
    expect(json(join(out, ".aidlc-plugin-catalog.json"))).toEqual({
      schema: 1,
      producer: "aidlc-plugin-catalog",
      name: "org-workflows",
      harnesses: ["copilot", "claude"],
      plugins: ["alpha", "beta"],
    });
  }, 60_000);

  test("each listed projection is byte-identical to the single-plugin build", () => {
    const source = testPro();
    const out = path("catalog");
    expect(catalog([out, source]).status).toBe(0);
    const single = path("single");
    const built = run("aidlc-plugin-build.ts", [source, "copilot", single]);
    expect(built.status, built.stderr).toBe(0);
    expect(snapshot(join(out, "copilot", "test-pro"))).toEqual(snapshot(single));
  }, 60_000);

  test("a rebuild replaces its own catalogue and drops a plugin no longer listed", () => {
    const out = path("catalog");
    const alpha = plugin("alpha");
    expect(catalog([out, alpha, plugin("beta")]).status).toBe(0);
    expect(catalog([out, alpha]).status).toBe(0);
    expect(readdirSync(join(out, "copilot"))).toEqual(["alpha"]);
    expect((json(join(out, ".plugin", "marketplace.json")).plugins as unknown[]).length).toBe(1);
  }, 60_000);

  test("it refuses a foreign directory, an overlapping source, a duplicate, and an invalid plugin, writing nothing", () => {
    const foreign = path("foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "keep.txt"), "mine\n");
    const refused = catalog([foreign, plugin("alpha")]);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("was not written by aidlc-plugin-catalog");
    expect(readdirSync(foreign)).toEqual(["keep.txt"]);

    const alpha = plugin("alpha");
    expect(catalog([join(alpha, "catalog"), alpha]).stderr).toContain("overlaps plugin source");

    const duplicate = catalog([path("catalog"), alpha, plugin("alpha")]);
    expect(duplicate.stderr).toContain('plugin "alpha" is listed more than once');

    const invalid = plugin("gamma");
    writeFileSync(join(invalid, ".aidlc-plugin", "plugin.json"), JSON.stringify({ name: "other", version: "1.0.0" }));
    const out = path("catalog");
    const failed = catalog([out, alpha, invalid]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("Plugin catalogue: FAILED");
    expect(existsSync(out)).toBe(false);
  }, 60_000);

  test("usage errors exit 2", () => {
    expect(catalog([path("catalog")]).status).toBe(2);
    expect(catalog([path("catalog"), plugin("alpha"), "--harness", "codex"]).stderr)
      .toContain("Unsupported catalogue harness codex");
    expect(catalog([path("catalog"), plugin("alpha"), "--name", "Bad Name"]).status).toBe(2);
    expect(catalog([path("catalog"), plugin("alpha"), "--name"]).status).toBe(2);
  });

  test("a live Copilot install from the catalogue resolves through the engine's Copilot inventory", () => {
    const out = path("catalog");
    expect(catalog([out, testPro()]).status).toBe(0);
    const home = path("copilot-home");
    mkdirSync(home);
    writeFileSync(join(home, "settings.json"), JSON.stringify({
      extraKnownMarketplaces: { "aidlc-workflows": { source: { source: "directory", path: out } } },
      enabledPlugins: { "aidlc-test-pro@aidlc-workflows": true },
    }));
    process.env.AIDLC_COPILOT_HOME = home;
    process.env.AIDLC_HARNESS_NAME = "copilot";
    const inventory = discoverPluginInventory(".aidlc");
    expect(inventory.invalid).toEqual([]);
    expect(inventory.installed).toEqual([
      expect.objectContaining({ key: "test-pro", root: join(out, "copilot", "test-pro"), enabled: true }),
    ]);
  }, 60_000);
});
