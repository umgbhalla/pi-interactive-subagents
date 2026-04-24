/**
 * Subagents extension (single-tool edition).
 *
 * Exposes exactly one tool — `mapreduce` — which forks the current pi session
 * into 1..8 parallel tracks. Each track runs in its own mux pane, inherits the
 * full conversation context, and blocks the caller until all tracks finish.
 *
 * Depth enforcement:
 *   - Root (main) session: unlimited depth.
 *   - Child session: depth budget persisted in a global SQLite ledger
 *     (~/.pi/subagents/lineage.db) and re-read at tool registration AND at
 *     every execute call.
 *   - Per track: caller sets `depth` (0..10, default 0). Effective depth is
 *     clamped to `min(track.depth, parent_remaining - 1, 10)`.
 *   - `mapreduce` is simply not registered when the effective remaining depth
 *     is 0 — the LLM does not see the tool.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Spacer, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  isNonVisualMode,
  muxSetupHint,
  muxCliPromptSnippet,
  createSurface,
  sendCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  exitStatusVar,
} from "./cmux.ts";
import {
  getNewEntries,
  findLastAssistantMessage,
  writeSanitizedForkSession,
} from "./session.ts";
import { resolveHintedModel, type ModelHint } from "./model-hints.ts";
import { buildSubagentToolArg } from "./tool-selection.ts";
import * as lineage from "./lineage.ts";

// ────────────────────────────────────────────────────────────────────────────
// Constants & types
// ────────────────────────────────────────────────────────────────────────────

const HARD_DEPTH_CAP = 10;
const SPAWNING_TOOLS = new Set(["mapreduce"]);

const MapReduceTrack = Type.Object({
  name: Type.String({ description: "Short track label (e.g. 'optimize queries', 'refactor auth')." }),
  prompt: Type.String({ description: "What this fork should do. It inherits full conversation context." }),
  depth: Type.Optional(Type.Integer({
    minimum: 0,
    maximum: HARD_DEPTH_CAP,
    description:
      "How many more levels of `mapreduce` this track is itself allowed to invoke. " +
      "Default 0 (terminal — this track cannot branch further). " +
      "Clamped to (parent_remaining - 1). Hard cap: " + String(HARD_DEPTH_CAP) + ".",
  })),
});

const MapReduceParams = Type.Object({
  tracks: Type.Array(MapReduceTrack, {
    minItems: 1,
    maxItems: 8,
    description: "Parallel forks to run. A single track is a context-preserving iterate.",
  }),
  model: Type.Optional(Type.String({ description: "Model override for all forks." })),
  modelHint: Type.Optional(Type.Union([
    Type.Literal("frontend"),
    Type.Literal("non-frontend"),
  ], { description: "Model family hint for all forks. Ignored when model is explicit." })),
});

interface AgentDefaults {
  model?: string;
  frontendModel?: string;
  nonFrontendModel?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  cwd?: string;
  body?: string;
}

interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

interface RunningSubagent {
  id: string;            // short id for widget keying
  lineageId: string;     // DB primary key for this child
  name: string;
  task: string;
  model?: string;
  modelHint?: ModelHint;
  effectiveDepth: number;
  surface: string;
  startTime: number;
  sessionFile: string;
  entries?: number;
  bytes?: number;
  forkCleanupFile?: string;
  abortController?: AbortController;
}

interface LaunchSpec {
  name: string;
  task: string;
  effectiveDepth: number;
  model?: string;
  modelHint?: ModelHint;
  agent?: string;          // kept for agent-frontmatter overrides (unused by mapreduce directly)
  systemPrompt?: string;
  skills?: string;
  tools?: string;
  cwd?: string;
}

const runningSubagents = new Map<string, RunningSubagent>();

// ────────────────────────────────────────────────────────────────────────────
// Agent defaults loading (still useful if future tracks want typed profiles)
// ────────────────────────────────────────────────────────────────────────────

function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools.split(",").map((s) => s.trim()).filter(Boolean)) {
      denied.add(t);
    }
  }
  return denied;
}

function loadAgentDefaults(agentName: string): AgentDefaults | null {
  const paths = [
    join(process.cwd(), ".pi", "agents", `${agentName}.md`),
    join(homedir(), ".pi", "agent", "agents", `${agentName}.md`),
    join(dirname(new URL(import.meta.url).pathname), "../../agents", `${agentName}.md`),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const content = readFileSync(p, "utf8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) continue;
    const frontmatter = match[1];
    const get = (key: string) => {
      const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
      return m ? m[1].trim() : undefined;
    };
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, "").trim();
    const spawningRaw = get("spawning");
    return {
      model: get("model"),
      frontendModel: get("model-frontend") ?? get("frontend-model"),
      nonFrontendModel: get("model-non-frontend") ?? get("non-frontend-model") ?? get("model-backend") ?? get("backend-model"),
      tools: get("tools"),
      skills: get("skill") ?? get("skills"),
      thinking: get("thinking"),
      denyTools: get("deny-tools"),
      spawning: spawningRaw != null ? spawningRaw === "true" : undefined,
      cwd: get("cwd"),
      body: body || undefined,
    };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Depth resolution
// ────────────────────────────────────────────────────────────────────────────

function currentLineageId(): string | undefined {
  return process.env.PI_SUBAGENT_LINEAGE_ID || undefined;
}

/**
 * Effective remaining depth for THIS session. Root (no lineage id) is
 * unlimited. Children take `min(env_hint, db_row)`; either being 0 blocks.
 */
function resolveRemainingDepth(): number {
  const id = currentLineageId();
  if (!id) return Number.POSITIVE_INFINITY;
  const envRaw = Number.parseInt(process.env.PI_SUBAGENT_DEPTH_REMAINING ?? "0", 10);
  const envDepth = Number.isFinite(envRaw) && envRaw >= 0 ? envRaw : 0;
  const row = lineage.get(id);
  const dbDepth = row?.remaining_depth ?? 0;
  return Math.min(envDepth, dbDepth);
}

function clampDepth(requested: number | undefined, parentRemaining: number): number {
  const base = Math.max(0, Math.min(HARD_DEPTH_CAP, requested ?? 0));
  const parentAllowed = parentRemaining === Number.POSITIVE_INFINITY
    ? HARD_DEPTH_CAP
    : Math.max(0, parentRemaining - 1);
  return Math.min(base, parentAllowed);
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

function compatModeNote(): string {
  return isNonVisualMode() ? "\n\n⚠️ " + muxSetupHint() : "";
}

// ────────────────────────────────────────────────────────────────────────────
// Widget (shows running mapreduce tracks in a bordered box above editor)
// ────────────────────────────────────────────────────────────────────────────

let latestCtx: ExtensionContext | null = null;
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

function borderLine(left: string, right: string, width: number): string {
  const contentWidth = Math.max(0, width - 2);
  const rightVis = visibleWidth(right);
  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

function borderTop(title: string, info: string, width: number): string {
  const inner = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

function borderBottom(width: number): string {
  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;
  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => ({
      invalidate() {},
      render(width: number) {
        const count = runningSubagents.size;
        const lines: string[] = [borderTop("mapreduce", `${count} running`, width)];
        for (const [, agent] of runningSubagents) {
          const elapsed = formatElapsedMMSS(agent.startTime);
          const depthTag = agent.effectiveDepth > 0 ? ` d=${agent.effectiveDepth}` : "";
          const left = ` ${elapsed}  ${agent.name}${depthTag} `;
          const right =
            agent.entries != null && agent.bytes != null
              ? ` ${agent.entries} msgs (${formatBytes(agent.bytes)}) `
              : " starting… ";
          lines.push(borderLine(left, right, width));
        }
        lines.push(borderBottom(width));
        return lines;
      },
    }),
    { placement: "aboveEditor" },
  );
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget();
  widgetInterval = setInterval(() => updateWidget(), 1000);
}

// ────────────────────────────────────────────────────────────────────────────
// Launch & watch a single fork
// ────────────────────────────────────────────────────────────────────────────

async function launchSubagent(
  spec: LaunchSpec,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string }; cwd: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = spec.agent ? loadAgentDefaults(spec.agent) : null;
  const { model: effectiveModel, modelHint: effectiveModelHint } = resolveHintedModel({
    explicitModel: spec.model,
    modelHint: spec.modelHint,
    agentDefaults: agentDefs,
  });
  const effectiveTools = spec.tools ?? agentDefs?.tools;
  const effectiveSkills = spec.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");

  const sessionDir = dirname(sessionFile);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [id, Math.random().toString(16).slice(2, 10), Math.random().toString(16).slice(2, 10), Math.random().toString(16).slice(2, 6)].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Record lineage BEFORE spawning so the child's pre-exec env matches the DB.
  const lineageId = randomUUID();
  const parentLineageId = currentLineageId() ?? null;
  const rootLineageId = process.env.PI_SUBAGENT_ROOT_LINEAGE_ID || lineageId;
  try {
    lineage.insert({
      lineage_id: lineageId,
      parent_lineage_id: parentLineageId,
      root_lineage_id: rootLineageId,
      session_file: subagentSessionFile,
      track_name: spec.name,
      remaining_depth: spec.effectiveDepth,
      granted_depth: spec.effectiveDepth,
      created_at: Date.now(),
      finished_at: null,
      status: "running",
    });
  } catch (err) {
    throw new Error(`mapreduce unavailable: lineage DB write failed (${(err as Error).message})`);
  }

  const surface = createSurface(spec.name);
  await new Promise<void>((resolve) => setTimeout(resolve, 500));

  // Fork-mode task: conversation context is inherited via writeSanitizedForkSession.
  const modeHint =
    "Complete your task. When finished, call the `subagent_done` tool. " +
    "That tool hard-exits this session — the agent loop will NOT take another turn after it runs.";
  const summaryInstruction =
    "Your FINAL assistant message (before calling `subagent_done`) becomes the summary returned to the caller. Make it count.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? spec.systemPrompt ?? null;

  const fullTask = [
    identity
      ? "Continue from the current conversation context. For this fork only, adopt the following role and constraints:"
      : "Continue from the current conversation context.",
    identity,
    modeHint,
    spec.task,
    summaryInstruction,
  ].filter(Boolean).join("\n\n");

  writeSanitizedForkSession(sessionFile, subagentSessionFile);

  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    const model = effectiveThinking ? `${effectiveModel}:${effectiveThinking}` : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  const toolArg = buildSubagentToolArg(effectiveTools);
  if (toolArg) parts.push("--tools", shellEscape(toolArg));

  if (effectiveSkills) {
    for (const skill of effectiveSkills.split(",").map((s) => s.trim()).filter(Boolean)) {
      parts.push(shellEscape(`/skill:${skill}`));
    }
  }

  const envParts: string[] = [];
  if (denySet.size > 0) envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(spec.name)}`);
  if (spec.agent) envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(spec.agent)}`);
  envParts.push(`PI_SUBAGENT_LINEAGE_ID=${shellEscape(lineageId)}`);
  envParts.push(`PI_SUBAGENT_ROOT_LINEAGE_ID=${shellEscape(rootLineageId)}`);
  envParts.push(`PI_SUBAGENT_DEPTH_REMAINING=${String(spec.effectiveDepth)}`);
  const envPrefix = envParts.join(" ") + " ";

  parts.push(shellEscape(fullTask));

  const rawCwd = spec.cwd ?? agentDefs?.cwd ?? null;
  const effectiveCwd = rawCwd
    ? (rawCwd.startsWith("/") ? rawCwd : join(process.cwd(), rawCwd))
    : null;
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
  sendCommand(surface, command);

  const running: RunningSubagent = {
    id,
    lineageId,
    name: spec.name,
    task: spec.task,
    model: effectiveModel,
    modelHint: effectiveModelHint,
    effectiveDepth: spec.effectiveDepth,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
  };

  runningSubagents.set(id, running);
  return running;
}

async function watchSubagent(running: RunningSubagent, signal: AbortSignal): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile, forkCleanupFile, lineageId } = running;

  try {
    const exitCode = await pollForExit(surface, signal, {
      interval: 1000,
      onTick() {
        try {
          if (existsSync(sessionFile)) {
            const stat = statSync(sessionFile);
            const raw = readFileSync(sessionFile, "utf8");
            running.entries = raw.split("\n").filter((l) => l.trim()).length;
            running.bytes = stat.size;
          }
        } catch {}
      },
    });

    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    let summary: string;
    if (existsSync(sessionFile)) {
      const allEntries = getNewEntries(sessionFile, 0);
      summary =
        findLastAssistantMessage(allEntries) ??
        (exitCode !== 0
          ? `Sub-agent exited with code ${exitCode}`
          : "Sub-agent exited without output");
    } else {
      summary = exitCode !== 0
        ? `Sub-agent exited with code ${exitCode}`
        : "Sub-agent exited without output";
    }

    closeSurface(surface);
    runningSubagents.delete(running.id);
    if (forkCleanupFile) { try { unlinkSync(forkCleanupFile); } catch {} }

    if (exitCode === 0) lineage.markFinished(lineageId);
    else lineage.markAborted(lineageId);

    return { name, task, summary, sessionFile, exitCode, elapsed };
  } catch (err: any) {
    if (forkCleanupFile) { try { unlinkSync(forkCleanupFile); } catch {} }
    try { closeSurface(surface); } catch {}
    runningSubagents.delete(running.id);
    lineage.markAborted(lineageId);

    if (signal.aborted) {
      return {
        name,
        task,
        summary: "Subagent cancelled.",
        exitCode: 1,
        elapsed: Math.floor((Date.now() - startTime) / 1000),
        error: "cancelled",
      };
    }
    return {
      name,
      task,
      summary: `Subagent error: ${err?.message ?? String(err)}`,
      exitCode: 1,
      elapsed: Math.floor((Date.now() - startTime) / 1000),
      error: err?.message ?? String(err),
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Track prompt
// ────────────────────────────────────────────────────────────────────────────

interface TrackInput { name: string; prompt: string; depth?: number }

function buildTrackPrompt(track: TrackInput, index: number, all: TrackInput[]): string {
  if (all.length === 1) {
    return [
      `Your task: ${track.prompt}`,
      `When done, write a concise summary of what you accomplished and any changes you made.`,
    ].join(" ");
  }
  const others = all.filter((_, j) => j !== index).map((t) => t.name).join(", ");
  return [
    `You are fork "${track.name}" (${index + 1}/${all.length}).`,
    `Your task: ${track.prompt}`,
    `Other tracks running in parallel: ${others}.`,
    `Work independently on your track only. Do not attempt work belonging to the other tracks.`,
    `When done, write a concise summary of what you accomplished and any changes you made.`,
  ].join(" ");
}

// ────────────────────────────────────────────────────────────────────────────
// Extension entrypoint
// ────────────────────────────────────────────────────────────────────────────

export default function subagentsExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;

    // If we are the root session (no lineage id), seed a self row so that
    // future child queries can trace the tree. Remaining depth stays
    // `Infinity`-equivalent (we store HARD_DEPTH_CAP + 1 as a sentinel).
    if (!currentLineageId() && lineage.isAvailable()) {
      const rootId = randomUUID();
      try {
        lineage.insert({
          lineage_id: rootId,
          parent_lineage_id: null,
          root_lineage_id: rootId,
          session_file: ctx.sessionManager.getSessionFile() ?? "(unknown)",
          track_name: null,
          remaining_depth: HARD_DEPTH_CAP + 1,
          granted_depth: HARD_DEPTH_CAP + 1,
          created_at: Date.now(),
          finished_at: null,
          status: "running",
        });
        process.env.PI_SUBAGENT_ROOT_LINEAGE_ID = rootId;
      } catch {
        /* non-fatal — mapreduce will still work, just without a root row */
      }
    }
  });

  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    for (const [, agent] of runningSubagents) agent.abortController?.abort();
    runningSubagents.clear();
  });

  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  );

  const remainingDepth = resolveRemainingDepth();
  const canMapreduce =
    !deniedTools.has("mapreduce") &&
    remainingDepth > 0 &&
    lineage.isAvailable();

  if (!canMapreduce) {
    if (!lineage.isAvailable()) {
      // Surface this once so the user knows why mapreduce vanished.
      const err = lineage.getInitError();
      process.stderr.write(
        `[subagents] mapreduce disabled: lineage DB unavailable (${err?.message ?? "unknown"})\n`,
      );
    }
    return;
  }

  pi.registerTool({
    name: "mapreduce",
    label: "MapReduce",
    description:
      "Fork the current session into 1..8 parallel tracks. " +
      "Each track gets a full copy of the conversation context and runs independently in its own terminal pane. " +
      "BLOCKS until all tracks complete, then returns their combined results. " +
      "Per-track `depth` controls whether that track itself may call `mapreduce` (default 0 = terminal).",
    promptSnippet:
      "Fork the current session into parallel tracks that carry forward full conversation context. " +
      "BLOCKS until all tracks complete; returns combined results. " +
      "A single track is a context-preserving iterate. " +
      "Per-track `depth` (default 0) grants re-branching budget to that track; capped at parent_remaining - 1. " +
      "IMPORTANT: mapreduce does NOT create a git branch or worktree — all tracks share the same git branch and working directory. " +
      "Commit all pending changes before calling mapreduce, and commit + push each track's work on completion to the same branch." +
      (muxCliPromptSnippet() ? "\n\n" + muxCliPromptSnippet() : ""),
    parameters: MapReduceParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const liveRemaining = resolveRemainingDepth();
      if (!(liveRemaining > 0)) {
        return {
          content: [{ type: "text", text: "mapreduce unavailable: depth budget exhausted for this session." }],
          details: { error: "depth exhausted" },
        };
      }

      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use mapreduce." }],
          details: { error: "no session file" },
        };
      }

      const trackCount = params.tracks.length;
      const started: RunningSubagent[] = [];

      for (let i = 0; i < trackCount; i++) {
        const track = params.tracks[i];
        const effectiveDepth = clampDepth(track.depth, liveRemaining);

        const forkPrompt = buildTrackPrompt(track, i, params.tracks);
        const running = await launchSubagent(
          {
            name: `Fork: ${track.name}`,
            task: forkPrompt,
            effectiveDepth,
            model: params.model,
            modelHint: params.modelHint,
          },
          ctx,
        );
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;
        if (signal) signal.addEventListener("abort", () => watcherAbort.abort(), { once: true });
        started.push(running);
      }

      startWidgetRefresh();

      const resultsByIndex: Array<SubagentResult | undefined> = new Array(trackCount);
      let done = 0;

      const watchTasks = started.map((running, index) =>
        watchSubagent(running, running.abortController!.signal).then((result) => {
          resultsByIndex[index] = result;
          done += 1;
          updateWidget();
          const remaining = trackCount - done;
          onUpdate?.({
            content: [{
              type: "text",
              text: `mapreduce: ${done}/${trackCount} tracks done${remaining > 0 ? `, ${remaining} running…` : ", all complete."}`,
            }],
            details: {
              done,
              total: trackCount,
              results: resultsByIndex.filter((r): r is SubagentResult => !!r),
            },
          });
          return result;
        }),
      );

      const results = await Promise.all(watchTasks);

      const successCount = results.filter((r) => r.exitCode === 0).length;
      const maxElapsed = results.reduce((max, r) => Math.max(max, r.elapsed), 0);
      const sections = results.map((r, i) => {
        const track = params.tracks[i];
        const status = r.exitCode === 0 ? "completed" : `FAILED (exit ${r.exitCode})`;
        const sessionRef = r.sessionFile
          ? `\nSession: ${r.sessionFile}\nResume: pi --session ${r.sessionFile}`
          : "";
        const depthTag = (track.depth ?? 0) > 0 ? ` depth=${track.depth}` : "";
        return `## Fork: ${track.name} [${status}]${depthTag} (${formatElapsed(r.elapsed)})\n\n${r.summary || "(no output)"}${sessionRef}`;
      });

      const header = `mapreduce completed: ${successCount}/${trackCount} succeeded. Wall time: ${formatElapsed(maxElapsed)}.${compatModeNote()}`;
      const combined = `${header}\n\n${sections.join("\n\n---\n\n")}`;

      return {
        content: [{ type: "text", text: combined }],
        details: {
          mode: "mapreduce",
          total: trackCount,
          completed: successCount,
          failed: trackCount - successCount,
          elapsed: maxElapsed,
          results: results.map((r, i) => ({
            name: params.tracks[i].name,
            task: params.tracks[i].prompt,
            depth: params.tracks[i].depth ?? 0,
            exitCode: r.exitCode,
            elapsed: r.elapsed,
            sessionFile: r.sessionFile,
            summary: r.summary,
          })),
        },
      };
    },

    renderCall(args, theme) {
      const tracks = Array.isArray(args.tracks) ? args.tracks : [];
      let text =
        "▸ " +
        theme.fg("toolTitle", theme.bold("mapreduce ")) +
        theme.fg("accent", `${tracks.length} track${tracks.length === 1 ? "" : "s"}`);
      for (const t of tracks.slice(0, 5)) {
        const preview = (t.prompt ?? "").length > 60 ? (t.prompt ?? "").slice(0, 60) + "…" : (t.prompt ?? "");
        const depthTag = (t.depth ?? 0) > 0 ? theme.fg("dim", ` d=${t.depth}`) : "";
        text += `\n  ${theme.fg("accent", t.name ?? "?")}${depthTag}${theme.fg("dim", ` ${preview}`)}`;
      }
      if (tracks.length > 5) text += `\n  ${theme.fg("muted", `... +${tracks.length - 5} more`)}`;
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (!details?.results) {
        const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      }

      const failed = details.failed ?? 0;
      const completed = details.completed ?? 0;
      const total = details.total ?? completed + failed;
      const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
      const icon = failed === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
      const status = failed === 0
        ? `${completed}/${total} succeeded`
        : `${completed}/${total} succeeded, ${failed} failed`;

      const header = `${icon} ${theme.fg("toolTitle", theme.bold("mapreduce"))} — ${status} ${theme.fg("dim", `(${elapsed})`)}`;

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(header, 0, 0));
        for (const r of details.results) {
          const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          container.addChild(new Spacer(1));
          const depthTag = (r.depth ?? 0) > 0 ? theme.fg("dim", ` d=${r.depth}`) : "";
          container.addChild(
            new Text(
              `${theme.fg("muted", "─── ")}${theme.fg("accent", r.name)}${depthTag} ${rIcon} ${theme.fg("dim", `(${formatElapsed(r.elapsed)})`)}`,
              0, 0,
            ),
          );
          if (r.summary) container.addChild(new Text(r.summary, 0, 0));
          if (r.sessionFile) container.addChild(new Text(theme.fg("dim", `Session: ${r.sessionFile}`), 0, 0));
        }
        return container;
      }

      let text = header;
      for (const r of details.results) {
        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const preview = (r.summary ?? "").split("\n")[0] ?? "";
        const truncated = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
        const depthTag = (r.depth ?? 0) > 0 ? theme.fg("dim", ` d=${r.depth}`) : "";
        text += `\n  ${rIcon} ${theme.fg("accent", r.name)}${depthTag} ${theme.fg("dim", truncated)}`;
      }
      text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });
}
