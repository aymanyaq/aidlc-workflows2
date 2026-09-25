#!/usr/bin/env bun
// Offline builder for one host marketplace that lists several authored AIDLC
// plugins. A team publishes the output directory once (a git repository or a
// shared directory); each user adds that marketplace once and installs the
// workflows they need from it.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  bundledPluginHookTemplatesDir,
  bundledPluginTargetsPath,
} from "./aidlc-plugin-build.ts";
import {
  buildPluginProjection,
  readPluginTargets,
} from "./aidlc-plugin-emit.ts";
import {
  formatPluginValidation,
  validatePluginRoot,
} from "./aidlc-plugin-validate.ts";

const USAGE =
  "Usage: bun <tools-dir>/aidlc-plugin-catalog.ts <out-dir> <plugin-root>... " +
  "[--harness copilot,claude] [--name <marketplace>] [--owner <name>] [--json]";

// Hosts whose marketplace manifest is proved. Each reads it from its own plugin
// manifest directory, so one catalogue serves both: Copilot reads
// .plugin/marketplace.json ahead of .claude-plugin/marketplace.json, the one
// Claude Code reads. Nothing is written at the root, which Copilot would read
// first.
const CATALOG_HARNESSES = ["copilot", "claude"];
export const PLUGIN_CATALOG_MARKER = ".aidlc-plugin-catalog.json";
const PLUGIN_CATALOG_PRODUCER = "aidlc-plugin-catalog";
const SAFE_MARKETPLACE_NAME = /^[a-z0-9][a-z0-9-]*$/;

type CatalogEntry = {
  key: string;
  version: string;
  description: string;
};

export type CatalogResult = {
  catalog: string;
  name: string;
  harnesses: string[];
  plugins: CatalogEntry[];
};

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function readObject(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isCatalogOutput(out: string): boolean {
  if (!existsSync(out)) return true;
  if (readdirSync(out).length === 0) return true;
  try {
    return readObject(join(out, PLUGIN_CATALOG_MARKER)).producer === PLUGIN_CATALOG_PRODUCER;
  } catch {
    return false;
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function buildPluginCatalog(options: {
  out: string;
  pluginRoots: string[];
  harnesses: string[];
  name: string;
  owner: string;
}): CatalogResult {
  const out = resolve(options.out);
  const roots = options.pluginRoots.map((root) => resolve(root));
  for (const root of roots) {
    if (inside(root, out) || inside(out, root)) {
      throw new Error(`catalogue output ${out} overlaps plugin source ${root}; choose a separate directory`);
    }
  }
  if (!isCatalogOutput(out)) {
    throw new Error(
      `${out} is not empty and was not written by ${PLUGIN_CATALOG_PRODUCER}; choose an empty directory`,
    );
  }

  const failures = roots
    .map((root) => ({ root, result: validatePluginRoot(root) }))
    .filter(({ result }) => !result.valid);
  if (failures.length > 0) {
    throw new Error(
      failures.map(({ root, result }) => formatPluginValidation(root, result).trimEnd()).join("\n"),
    );
  }
  const keys = roots.map((root) => String(readObject(join(root, ".aidlc-plugin", "plugin.json")).name));
  const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
  if (duplicate) throw new Error(`plugin "${duplicate}" is listed more than once`);

  const targets = readPluginTargets(bundledPluginTargetsPath());
  for (const harness of options.harnesses) {
    if (!targets[harness]) throw new Error(`bundled plugin target table has no "${harness}" target`);
  }

  const order = keys.map((key, index) => ({ key, root: roots[index] }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const staging = mkdtempSync(join(dirname(out), `.${basename(out)}.staging-`));
  try {
    let entries: CatalogEntry[] = [];
    for (const harness of options.harnesses) {
      const target = targets[harness];
      entries = order.map(({ key, root }) => {
        const outDir = join(staging, harness, key);
        buildPluginProjection({
          pluginRoot: root,
          target,
          outDir,
          outputBoundary: staging,
          templateHooksDir: bundledPluginHookTemplatesDir(),
        });
        const manifest = readObject(join(outDir, target.manifestDir, "plugin.json"));
        return {
          key,
          version: String(manifest.version ?? ""),
          description: typeof manifest.description === "string" ? manifest.description : "",
        };
      });
      const manifestDir = join(staging, target.manifestDir);
      mkdirSync(manifestDir, { recursive: true });
      writeJson(join(manifestDir, "marketplace.json"), {
        name: options.name,
        owner: { name: options.owner },
        description: "AIDLC workflow catalogue.",
        plugins: entries.map((entry) => ({
          name: `aidlc-${entry.key}`,
          source: `./${harness}/${entry.key}`,
          version: entry.version,
          description: entry.description,
        })),
      });
    }
    writeJson(join(staging, PLUGIN_CATALOG_MARKER), {
      schema: 1,
      producer: PLUGIN_CATALOG_PRODUCER,
      name: options.name,
      harnesses: options.harnesses,
      plugins: entries.map((entry) => entry.key),
    });
    const previous = existsSync(out) ? `${staging}.previous` : null;
    if (previous) renameSync(out, previous);
    renameSync(staging, out);
    if (previous) rmSync(previous, { recursive: true, force: true });
    return { catalog: out, name: options.name, harnesses: options.harnesses, plugins: entries };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function flagValue(argv: string[], flag: string): string | undefined | null {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

export function main(argv: string[]): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const valueFlags = ["--harness", "--name", "--owner"];
  const positional: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (valueFlags.includes(arg)) index++;
    else if (arg !== "--json") positional.push(arg);
  }
  const values = Object.fromEntries(valueFlags.map((flag) => [flag, flagValue(argv, flag)]));
  if (
    positional.length < 2 ||
    positional.some((arg) => arg.startsWith("-")) ||
    Object.values(values).some((value) => value === null)
  ) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const harnesses = [...new Set((values["--harness"] ?? "copilot").split(",").map((h) => h.trim()))];
  const unsupported = harnesses.filter((harness) => !CATALOG_HARNESSES.includes(harness));
  const name = values["--name"] ?? "aidlc-workflows";
  if (unsupported.length > 0 || !SAFE_MARKETPLACE_NAME.test(name)) {
    process.stderr.write(
      `${USAGE}\n` +
        (unsupported.length > 0
          ? `Unsupported catalogue harness ${unsupported.join(", ")} (supported: ${CATALOG_HARNESSES.join(", ")})\n`
          : `Marketplace name "${name}" must be lowercase letters, digits and hyphens\n`),
    );
    return 2;
  }
  const [out, ...pluginRoots] = positional;
  const json = argv.includes("--json");
  try {
    const result = buildPluginCatalog({
      out,
      pluginRoots,
      harnesses,
      name,
      owner: values["--owner"] ?? name,
    });
    if (json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, ...result })}\n`);
    } else {
      const lines = [
        "Plugin catalogue: COMPLETE",
        `Marketplace: ${result.name}`,
        `Output: ${result.catalog}`,
        `Harnesses: ${result.harnesses.join(", ")}`,
        ...result.plugins.map((plugin) => `  aidlc-${plugin.key} ${plugin.version}`),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: false, message })}\n`);
    } else {
      process.stderr.write(`Plugin catalogue: FAILED\n${message}\n`);
    }
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
