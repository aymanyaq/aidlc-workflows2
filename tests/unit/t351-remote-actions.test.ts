// covers: file:core/hooks/aidlc-plan-approval-guard.ts, file:core/tools/aidlc-stage-schema.ts,
// file:core/tools/aidlc-sensor-required-sections.ts, file:harness/copilot/hooks/aidlc-copilot-adapter.ts

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actionToolMatches,
  isMcpToolName,
  remoteActionRefusal,
} from "../../core/hooks/aidlc-plan-approval-guard.ts";
import { emitStageFrontmatter, parseStageFrontmatter } from "../../core/tools/aidlc-lib.ts";
import { remoteOutcomeFindings } from "../../core/tools/aidlc-sensor-required-sections.ts";
import { validateStageFrontmatter } from "../../core/tools/aidlc-stage-schema.ts";
import {
  AIDLC_SRC,
  DEFAULT_RECORD_DIR,
  intentsDirOf,
  seededRecordDir,
  seededStateFile,
} from "../harness/fixtures.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCRATCH: string[] = [];

afterAll(() => {
  for (const dir of SCRATCH) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  SCRATCH.push(dir);
  return dir;
}

// A plan stage whose approval gate authorizes the action stage after it.
const GRAPH = [
  {
    slug: "acme-plan-change",
    number: "2.1",
    name: "Plan the change",
    phase: "inception",
    execution: "ALWAYS",
    lead_agent: "acme-operator-agent",
    support_agents: [],
    mode: "subagent",
    produces: ["acme-change-plan"],
    consumes: [],
    requires_stage: [],
  },
  {
    slug: "acme-file-change",
    number: "2.2",
    name: "File the change",
    phase: "inception",
    execution: "ALWAYS",
    lead_agent: "acme-operator-agent",
    support_agents: [],
    mode: "subagent",
    produces: ["acme-change-record"],
    action_tools: ["servicenow/create_change_request", "tickets/*"],
    action_record: "acme-change-record",
    consumes: [{ artifact: "acme-change-plan", required: true }],
    requires_stage: ["acme-plan-change"],
  },
];

function stateText(current: string, plan: string, file: string): string {
  return `# AI-DLC State Tracking

## Project Information
- **Project**: t351 fixture
- **Scope**: acme-change

## Current Status
- **Lifecycle Phase**: INCEPTION
- **Current Stage**: ${current}

## Stage Progress
- [${plan}] acme-plan-change — EXECUTE
- [${file}] acme-file-change — EXECUTE
`;
}

const STAGE_SOURCE = `---
slug: acme-file-change
number: 2.2
name: File the change
plugin: acme
phase: inception
execution: ALWAYS
condition: Always
lead_agent: acme-operator-agent
support_agents: []
mode: subagent
produces:
  - acme-change-record
action_tools:
  - servicenow/create_change_request
  - tickets/*
action_record: acme-change-record
consumes:
  - artifact: acme-change-plan
    required: true
requires_stage:
  - acme-plan-change
inputs: The approved change plan
outputs: The change record
---
body
`;

describe("t351 stage action declarations", () => {
  test("action_tools and action_record parse, validate, and round-trip", () => {
    const parsed = parseStageFrontmatter(STAGE_SOURCE);
    expect(parsed.action_tools).toEqual(["servicenow/create_change_request", "tickets/*"]);
    expect(parsed.action_record).toBe("acme-change-record");
    expect(validateStageFrontmatter(parsed)).toEqual(expect.objectContaining({ valid: true }));
    expect(parseStageFrontmatter(`${emitStageFrontmatter(parsed)}\nbody\n`)).toEqual(parsed);
    const plain = parseStageFrontmatter(STAGE_SOURCE.replace(/action_tools:\n( {2}- .*\n)+action_record: .*\n/, ""));
    expect("action_tools" in plain).toBe(false);
    expect(validateStageFrontmatter(plain)).toEqual(expect.objectContaining({ valid: true }));
  });

  test("an action stage needs a record it produces, a malformed-free tool list, and an approving stage before it", () => {
    const parsed = parseStageFrontmatter(STAGE_SOURCE);
    const errors = (value: Record<string, unknown>): string[] => {
      const result = validateStageFrontmatter(value);
      return result.valid ? [] : result.errors;
    };
    const { action_record: _record, ...withoutRecord } = parsed;
    expect(errors(withoutRecord)).toContain(
      "action_tools requires action_record, the produces entry that records each remote outcome",
    );
    expect(errors({ ...parsed, action_record: "elsewhere" })).toContain('action_record "elsewhere" is not in produces');
    expect(errors({ ...parsed, requires_stage: [] })).toContain(
      "action_tools requires requires_stage: the approval gate of an earlier stage authorizes the action",
    );
    expect(errors({ ...parsed, action_tools: ["servicenow"] })).toContain(
      'action_tools[0] must be <server>/<tool> or <server>/*, got "servicenow"',
    );
    const { action_tools: _tools, ...withoutTools } = parsed;
    expect(errors(withoutTools)).toContain("action_record requires action_tools, the MCP tools the stage acts through");
  });
});

describe("t351 remote-action decision", () => {
  test("a declared tool matches each host's MCP naming, and a wildcard its whole server", () => {
    for (const name of [
      "mcp__servicenow__create_change_request",
      "servicenow-create_change_request",
      "servicenow/create_change_request",
    ]) {
      expect(actionToolMatches("servicenow/create_change_request", name)).toBe(true);
      expect(isMcpToolName(name)).toBe(true);
    }
    expect(actionToolMatches("servicenow/create_change_request", "mcp__servicenow__get_change")).toBe(false);
    expect(actionToolMatches("tickets/*", "tickets-close_ticket")).toBe(true);
    expect(actionToolMatches("tickets/*", "mcp__tickets__open")).toBe(true);
    expect(actionToolMatches("tickets/*", "tickets-")).toBe(false);
    for (const name of ["Bash", "Write", "Task", "report_intent", "web_fetch"]) {
      expect(isMcpToolName(name)).toBe(false);
    }
  });

  test("a declared tool runs only in its stage, after every approving stage completed", () => {
    const states = (plan: string): Map<string, string> =>
      new Map([["acme-plan-change", plan], ["acme-file-change", "in-progress"]]);
    const tool = "mcp__servicenow__create_change_request";
    expect(remoteActionRefusal(GRAPH, tool, "acme-plan-change", states("in-progress"))?.reason)
      .toContain("runs only in the acme-file-change stage");
    expect(remoteActionRefusal(GRAPH, tool, "acme-file-change", states("awaiting-approval"))?.reason)
      .toContain("may call it only after acme-plan-change is approved and completed");
    expect(remoteActionRefusal(GRAPH, tool, "acme-file-change", states("skipped"))).not.toBeNull();
    expect(remoteActionRefusal(GRAPH, tool, "acme-file-change", states("completed"))).toBeNull();
    expect(remoteActionRefusal(GRAPH, "mcp__docs__lookup", "acme-plan-change", states("in-progress"))).toBeNull();
  });
});

function writeGraph(dir: string): string {
  const path = join(dir, "stage-graph.json");
  writeFileSync(path, JSON.stringify(GRAPH));
  return path;
}

function claudeProject(): string {
  const dir = scratch("t351-claude-");
  cpSync(join(AIDLC_SRC, "hooks"), join(dir, ".claude", "hooks"), { recursive: true });
  cpSync(join(AIDLC_SRC, "tools"), join(dir, ".claude", "tools"), { recursive: true });
  mkdirSync(join(dir, "aidlc", "spaces", "default", "intents"), { recursive: true });
  return dir;
}

function runGuard(
  dir: string,
  toolName: string,
  state: string | null,
  env: Record<string, string> = {},
): { code: number; stderr: string } {
  const statePath = join(dir, "aidlc", "spaces", "default", "intents", "aidlc-state.md");
  if (state === null) rmSync(statePath, { force: true });
  else writeFileSync(statePath, state);
  const result = spawnSync(process.execPath, [join(dir, ".claude", "hooks", "aidlc-plan-approval-guard.ts")], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { summary: "x" }, cwd: dir }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, AIDLC_STAGE_GRAPH: writeGraph(dir), ...env },
    encoding: "utf-8",
  });
  return { code: result.status ?? -1, stderr: result.stderr ?? "" };
}

describe("t351 plan-approval guard on remote actions", () => {
  test("Claude: a declared MCP action is refused before approval and allowed after it", () => {
    const dir = claudeProject();
    const tool = "mcp__servicenow__create_change_request";
    const early = runGuard(dir, tool, stateText("acme-plan-change", "-", " "));
    expect(early.code).toBe(2);
    expect(early.stderr).toContain("runs only in the acme-file-change stage");
    const unapproved = runGuard(dir, tool, stateText("acme-file-change", "?", "-"));
    expect(unapproved.code).toBe(2);
    expect(unapproved.stderr).toContain("only after acme-plan-change is approved and completed");
    expect(runGuard(dir, tool, stateText("acme-file-change", "x", "-")).code).toBe(0);
    expect(runGuard(dir, "mcp__tickets__close_ticket", stateText("acme-plan-change", "-", " ")).code).toBe(2);
  }, 60_000);

  test("Claude: undeclared MCP tools, no workflow, and the off-switch all allow", () => {
    const dir = claudeProject();
    expect(runGuard(dir, "mcp__docs__lookup", stateText("code-generation", "x", "x")).code).toBe(0);
    expect(runGuard(dir, "mcp__servicenow__create_change_request", null).code).toBe(0);
    expect(
      runGuard(dir, "mcp__servicenow__create_change_request", stateText("acme-plan-change", "-", " "), {
        AIDLC_DISABLE_PLAN_APPROVAL_GUARD: "1",
      }).code,
    ).toBe(0);
  }, 60_000);

  test("Copilot: the adapter routes a <server>-<tool> call to the guard and denies an unapproved action", () => {
    const dir = scratch("t351-copilot-");
    cpSync(join(REPO_ROOT, "dist", "copilot", ".aidlc"), join(dir, ".aidlc"), { recursive: true });
    const intents = intentsDirOf(dir);
    mkdirSync(seededRecordDir(dir), { recursive: true });
    writeFileSync(join(dir, "aidlc", "active-space"), "default\n");
    writeFileSync(join(intents, "active-intent"), `${DEFAULT_RECORD_DIR}\n`);
    writeFileSync(join(intents, "intents.json"), JSON.stringify([{
      uuid: "00000000-0000-7000-8000-000000000001",
      slug: DEFAULT_RECORD_DIR.replace(/-[0-9a-f]+$/, ""),
      status: "in-flight",
    }]));
    const adapter = (toolName: string, state: string): string => {
      writeFileSync(seededStateFile(dir), state);
      const result = spawnSync(process.execPath, [join(dir, ".aidlc", "hooks", "aidlc-copilot-adapter.ts"), "guard-tool-call"], {
        cwd: dir,
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: "t351-session",
          cwd: dir,
          tool_name: toolName,
          tool_input: { short_description: "x" },
        }),
        env: {
          ...process.env,
          AIDLC_PROJECT_DIR: undefined,
          CLAUDE_PROJECT_DIR: undefined,
          AIDLC_STAGE_GRAPH: writeGraph(dir),
        } as NodeJS.ProcessEnv,
        encoding: "utf-8",
      });
      return result.stdout ?? "";
    };
    const denied = adapter("servicenow-create_change_request", stateText("acme-file-change", "?", "-"));
    expect(denied).toContain("deny");
    expect(denied).toContain("only after acme-plan-change is approved and completed");
    expect(adapter("servicenow-create_change_request", stateText("acme-file-change", "x", "-"))).not.toContain("deny");
    expect(adapter("report_intent", stateText("acme-plan-change", "-", " "))).not.toContain("deny");
  }, 60_000);
});

const RECORD = `# Change record

## Summary

Filed the approved change.

## Remote Outcomes

| System | Operation | Identifier | Link | Performed | Result |
| --- | --- | --- | --- | --- | --- |
| ServiceNow | create_change_request | CHG0031234 | https://acme.service-now.com/chg/CHG0031234 | 2026-09-25T13:40Z | created |
`;

describe("t351 action record check", () => {
  test("the Remote Outcomes table must name every column and fill every cell of each row", () => {
    expect(remoteOutcomeFindings(RECORD)).toEqual([]);
    expect(remoteOutcomeFindings("# Record\n\n## Summary\n")).toEqual(["missing the ## Remote Outcomes section"]);
    expect(remoteOutcomeFindings(RECORD.replace("| Link ", "| URL "))[0]).toContain("missing column(s): Link");
    expect(remoteOutcomeFindings(RECORD.replace(/\| ServiceNow .*\n/, ""))[0]).toContain("has no rows");
    expect(remoteOutcomeFindings(RECORD.replace("| CHG0031234 |", "|  |"))).toEqual([
      "Remote Outcomes row 1 has no Identifier",
    ]);
  });

  test("the sensor checks the stage's action record and nothing else", () => {
    const dir = scratch("t351-sensor-");
    const sensor = join(REPO_ROOT, "core", "tools", "aidlc-sensor-required-sections.ts");
    const fire = (file: string, body: string): Record<string, unknown> => {
      const path = join(dir, file);
      writeFileSync(path, body);
      const result = spawnSync(process.execPath, [
        sensor,
        "--stage",
        "acme-file-change",
        "--output-path",
        path,
        "--action-record",
        "acme-change-record",
      ], { encoding: "utf-8" });
      return JSON.parse(result.stdout) as Record<string, unknown>;
    };
    expect(fire("acme-change-record.md", RECORD)).toEqual(expect.objectContaining({ pass: true, action_record: "ok" }));
    const incomplete = fire("acme-change-record.md", RECORD.replace("| created |", "|  |"));
    expect(incomplete).toEqual(expect.objectContaining({
      pass: false,
      action_record: "incomplete",
      action_record_findings: ["Remote Outcomes row 1 has no Result"],
    }));
    expect(fire("acme-change-plan.md", "# Plan\n\n## One\n\n## Two\n")).not.toHaveProperty("action_record");
  });
});
