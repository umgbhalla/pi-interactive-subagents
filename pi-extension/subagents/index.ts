import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { basename, dirname, join } from "node:path";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  isCompatMode,
  isNonVisualMode,
  muxSetupHint,
  muxCliPromptSnippet,
  createSurface,
  sendCommand,
  pollForExit,
  closeSurface,
  shellEscape,
  exitStatusVar,
  renameCurrentTab,
  renameWorkspace,
  readScreen,
} from "./cmux.ts";
import {
  getNewEntries,
  findLastAssistantMessage,
  writeSanitizedForkSession,
} from "./session.ts";
import { resolveHintedModel, type ModelHint } from "./model-hints.ts";
import { writeSubagentTaskArtifact } from "./task-artifact.ts";

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  agent: Type.Optional(
    Type.String({ description: "Agent name to load defaults from (e.g. 'worker', 'scout', 'reviewer'). Reads ~/.pi/agent/agents/<name>.md for model, tools, skills." })
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" })
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  modelHint: Type.Optional(Type.Union([
    Type.Literal("frontend"),
    Type.Literal("non-frontend"),
  ], { description: "Hint for model-family selection. Use 'frontend' for UI/design work (prefers Claude/Sonnet/Opus family), 'non-frontend' for backend/general coding work (prefers Codex/GPT family). Ignored when model is set explicitly." })),
  skills: Type.Optional(Type.String({ description: "Comma-separated skills (overrides agent default)" })),
  tools: Type.Optional(Type.String({ description: "Comma-separated tools (overrides agent default)" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders." })),
  fork: Type.Optional(Type.Boolean({ description: "Fork the current session — sub-agent gets full conversation context. Use for iterate/bugfix patterns." })),
});

const AgentGroupParams = Type.Object({
  agents: Type.Array(SubagentParams, {
    minItems: 1,
    description: "Subagents to launch concurrently. Each entry accepts the same fields as the subagent tool.",
  }),
  name: Type.Optional(Type.String({ description: "Optional label for the group result. Default: 'Agent group'." })),
  // wait param removed — agent_group is always async
});

const BranchTrack = Type.Object({
  name: Type.String({ description: "Short label for this track (e.g. 'optimize queries', 'refactor auth')" }),
  prompt: Type.String({ description: "What to work on in this track. The fork gets full conversation context plus this prompt." }),
});

const BranchParams = Type.Object({
  tracks: Type.Array(BranchTrack, {
    minItems: 1,
    maxItems: 8,
    description: "Tracks to fork into. Each track gets a full copy of the current conversation and runs independently. A single track creates a blocking context-preserving fork.",
  }),
  model: Type.Optional(Type.String({ description: "Model override for all forks. Default: same as current session." })),
  modelHint: Type.Optional(Type.Union([
    Type.Literal("frontend"),
    Type.Literal("non-frontend"),
  ], { description: "Hint the model family for all forks. Ignored when model is set." })),
});

const ActiveSubagentsParams = Type.Object({
  screenLines: Type.Optional(Type.Number({ description: "Include the last N lines of terminal output for each running subagent. Default: 0.", minimum: 0, maximum: 200 })),
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

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set(["subagent", "agent_group", "branch", "subagents_list", "active_subagents"]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
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
    // Extract body (everything after frontmatter)
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

/**
 * Resolve a skill name or path to a full filesystem path.
 * Checks: as-is (absolute/relative), project .pi/skills/<name>/SKILL.md,
 * then user ~/.pi/agent/skills/<name>/SKILL.md.
 */
function resolveSkillPath(nameOrPath: string): string {
  // Already an absolute path or file path
  if (nameOrPath.includes("/") || nameOrPath.includes("\\") || nameOrPath.endsWith(".md")) {
    return nameOrPath;
  }
  // Check project-local
  const projectPath = join(process.cwd(), ".pi", "skills", nameOrPath, "SKILL.md");
  if (existsSync(projectPath)) return projectPath;
  // Check user-global
  const userPath = join(homedir(), ".pi", "agent", "skills", nameOrPath, "SKILL.md");
  if (existsSync(userPath)) return userPath;
  // Fallback: return as-is (pi will error if not found)
  return nameOrPath;
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/** Note appended to tool results when running without visual panes (screen or raw compat). */
function compatModeNote(): string {
  return isNonVisualMode()
    ? "\n\n⚠️ " + muxSetupHint()
    : "";
}

/**
 * Build the artifact directory path for the current session.
 * Same convention as the write_artifact tool:
 *   ~/.pi/history/<project>/artifacts/<session-id>/
 */
function getArtifactDir(cwd: string, sessionId: string): string {
  const project = basename(cwd);
  return join(homedir(), ".pi", "history", project, "artifacts", sessionId);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)}KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)}MB`;
}

/**
 * Try to find and measure a specific session file, or discover
 * the right one from new files in the session directory.
 *
 * When `trackedFile` is provided, measures that file directly.
 * Otherwise scans for new files not in `existingFiles` or `excludeFiles`.
 *
 * Returns { file, entries, bytes } — `file` is the path that was measured,
 * so callers can lock onto it for subsequent calls.
 */
/**
 * Result from running a single subagent.
 */
interface SubagentResult {
  name: string;
  task: string;
  summary: string;
  sessionFile?: string;
  exitCode: number;
  elapsed: number;
  error?: string;
}

interface ParallelSubagentResult extends SubagentResult {
  agent?: string;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagent {
  id: string;
  name: string;
  task: string;
  agent?: string;
  model?: string;
  modelHint?: ModelHint;
  surface: string;
  startTime: number;
  sessionFile: string;
  entries?: number;
  bytes?: number;
  forkCleanupFile?: string;
  abortController?: AbortController;
}

/** All currently running subagents, keyed by id. */
const runningSubagents = new Map<string, RunningSubagent>();



// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);
  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
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
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          const count = runningSubagents.size;
          const title = "Subagents";
          const info = `${count} running`;

          const lines: string[] = [borderTop(title, info, width)];

          for (const [_id, agent] of runningSubagents) {
            const elapsed = formatElapsedMMSS(agent.startTime);
            const agentTag = agent.agent ? ` (${agent.agent})` : "";
            const left = ` ${elapsed}  ${agent.name}${agentTag} `;
            const right =
              agent.entries != null && agent.bytes != null
                ? ` ${agent.entries} msgs (${formatBytes(agent.bytes)}) `
                : " starting… ";

            lines.push(borderLine(left, right, width));
          }

          lines.push(borderBottom(width));
          return lines;
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string }; cwd: string },
  options?: { surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
  const { model: effectiveModel, modelHint: effectiveModelHint } = resolveHintedModel({
    explicitModel: params.model,
    modelHint: params.modelHint,
    agentDefaults: agentDefs,
  });
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = agentDefs?.thinking;

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");

  const sessionDir = dirname(sessionFile);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [id, Math.random().toString(16).slice(2, 10), Math.random().toString(16).slice(2, 10), Math.random().toString(16).slice(2, 6)].join("-");
  const subagentSessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
  }

  // Build the task message.
  // Forked runs still need explicit completion/tab-title instructions,
  // but should receive them as a normal user turn in the forked context.
  const modeHint = "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
  const summaryInstruction =
    "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const roleBlock = identity ? `\n\n${identity}` : "";

  const typedForkTask = [
    identity
      ? "Continue from the current conversation context. For this fork only, adopt the following role and constraints:"
      : "Continue from the current conversation context.",
    identity,
    modeHint,
    params.task,
    summaryInstruction,
  ].filter(Boolean).join("\n\n");

  const fullTask = params.fork
    ? typedForkTask
    : `${roleBlock}\n\n${modeHint}\n\n${params.task}\n\n${summaryInstruction}`;

  // Build pi command
  const parts: string[] = ["pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  // For fork mode, create a cleaned copy of the current session directly at the
  // deterministic subagent session path. Core pi rejects `--fork` combined with
  // `--session`, so we materialize the forked history ourselves and then open it
  // with `--session` only. This preserves deterministic tracking for the parent
  // orchestrator while still giving the child the full prior conversation context
  // minus the triggering meta-message/tool call.
  let forkCleanupFile: string | undefined;
  if (params.fork) {
    writeSanitizedForkSession(sessionFile, subagentSessionFile);
  }

  const subagentDonePath = join(dirname(new URL(import.meta.url).pathname), "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (effectiveModel) {
    const model = effectiveThinking
      ? `${effectiveModel}:${effectiveThinking}`
      : effectiveModel;
    parts.push("--model", shellEscape(model));
  }

  if (effectiveTools) {
    const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    const builtins = effectiveTools.split(",").map((t) => t.trim()).filter((t) => BUILTIN_TOOLS.has(t));
    if (builtins.length > 0) {
      parts.push("--tools", shellEscape(builtins.join(",")));
    }
  }

  if (effectiveSkills) {
    for (const skill of effectiveSkills.split(",").map((s) => s.trim()).filter(Boolean)) {
      parts.push(shellEscape(`/skill:${skill}`));
    }
  }

  // Build env prefix: denied tools + subagent identity
  const envParts: string[] = [];
  if (denySet.size > 0) {
    envParts.push(`PI_DENY_TOOLS=${shellEscape([...denySet].join(","))}`);
  }
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  if (params.agent) {
    envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent)}`);
  }
  const envPrefix = envParts.join(" ") + " ";

  // Pass task to the sub-agent.
  // Fork mode: pass as a direct CLI message so InteractiveMode invokes
  // session.prompt(...) on startup (instead of only showing a pre-appended user turn).
  // Non-fork mode keeps @file to avoid shell-quoting/argv-length issues.
  if (params.fork) {
    parts.push(shellEscape(fullTask));
  } else {
    const sessionId = ctx.sessionManager.getSessionId();
    const artifactDir = getArtifactDir(ctx.cwd, sessionId);
    const artifactPath = writeSubagentTaskArtifact(artifactDir, params.name, fullTask);
    parts.push(`@${shellEscape(artifactPath)}`);
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const effectiveCwd = rawCwd
    ? (rawCwd.startsWith("/") ? rawCwd : join(process.cwd(), rawCwd))
    : null;
  const cdPrefix = effectiveCwd ? `cd ${shellEscape(effectiveCwd)} && ` : "";

  const piCommand = cdPrefix + envPrefix + parts.join(" ");
  const command = `${piCommand}; echo '__SUBAGENT_DONE_'${exitStatusVar()}'__'`;
  sendCommand(surface, command);

  const running: RunningSubagent = {
    id,
    name: params.name,
    task: params.task,
    agent: params.agent,
    model: effectiveModel,
    modelHint: effectiveModelHint,
    surface,
    startTime,
    sessionFile: subagentSessionFile,
    forkCleanupFile,
  };

  runningSubagents.set(id, running);
  return running;
}

/**
 * Watch a launched subagent until it exits. Polls for completion, extracts
 * the summary from the session file, cleans up the surface and fork file,
 * and removes the entry from runningSubagents.
 */
async function watchSubagent(
  running: RunningSubagent,
  signal: AbortSignal,
): Promise<SubagentResult> {
  const { name, task, surface, startTime, sessionFile, forkCleanupFile } = running;

  try {
    const exitCode = await pollForExit(surface, signal, {
      interval: 1000,
      onTick() {
        // Update entries/bytes for widget display
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

    // Extract summary from the known session file
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

    // Clean up temp fork file
    if (forkCleanupFile) {
      try { unlinkSync(forkCleanupFile); } catch {}
    }

    return { name, task, summary, sessionFile, exitCode, elapsed };
  } catch (err: any) {
    if (forkCleanupFile) {
      try { unlinkSync(forkCleanupFile); } catch {}
    }
    try { closeSurface(surface); } catch {}
    runningSubagents.delete(running.id);

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

function formatSingleSubagentContent(running: RunningSubagent, result: SubagentResult): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";
  return result.exitCode !== 0
    ? `Sub-agent "${running.name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${running.name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

function buildParallelGroupContent(groupName: string, results: ParallelSubagentResult[]): string {
  const completed = results.filter((r) => r.exitCode === 0).length;
  const failed = results.length - completed;
  const maxElapsed = results.reduce((max, r) => Math.max(max, r.elapsed), 0);
  const lines = [
    `${groupName} completed: ${completed}/${results.length} succeeded${failed ? `, ${failed} failed` : ""}.`,
    `Total wall time: ${formatElapsed(maxElapsed)}`,
    "",
  ];

  for (const result of results) {
    const status = result.exitCode === 0 ? "✓ success" : `✗ failed (exit ${result.exitCode})`;
    const agentTag = result.agent ? ` (${result.agent})` : "";
    lines.push(`## ${result.name}${agentTag} — ${status} — ${formatElapsed(result.elapsed)}`);
    if (result.summary) {
      lines.push(result.summary);
    }
    if (result.sessionFile) {
      lines.push("");
      lines.push(`Session: ${result.sessionFile}`);
      lines.push(`Resume: pi --session ${result.sessionFile}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

function sendSingleSubagentResult(pi: ExtensionAPI, running: RunningSubagent, result: SubagentResult) {
  pi.sendMessage({
    customType: "subagent_result",
    content: formatSingleSubagentContent(running, result),
    display: true,
    details: {
      name: running.name,
      task: running.task,
      agent: running.agent,
      exitCode: result.exitCode,
      elapsed: result.elapsed,
      sessionFile: result.sessionFile,
    },
  }, { triggerTurn: true, deliverAs: "steer" });
}

function sendAgentGroupResult(
  pi: ExtensionAPI,
  groupName: string,
  results: ParallelSubagentResult[],
  triggerTurn = true,
) {
  const completed = results.filter((r) => r.exitCode === 0).length;
  const failed = results.length - completed;
  const elapsed = results.reduce((max, r) => Math.max(max, r.elapsed), 0);

  pi.sendMessage({
    customType: "agent_group_result",
    content: buildParallelGroupContent(groupName, results),
    display: true,
    details: {
      name: groupName,
      total: results.length,
      completed,
      failed,
      elapsed,
      results,
    },
  }, { triggerTurn, deliverAs: "steer" });
}

function getRunningSubagentsSnapshot() {
  return [...runningSubagents.values()].map((running) => ({
    id: running.id,
    name: running.name,
    task: running.task,
    agent: running.agent,
    model: running.model,
    modelHint: running.modelHint,
    surface: running.surface,
    sessionFile: running.sessionFile,
    elapsed: Math.floor((Date.now() - running.startTime) / 1000),
    entries: running.entries,
    bytes: running.bytes,
  }));
}
export default function subagentsExtension(pi: ExtensionAPI) {
  // Capture the UI context for widget updates
  pi.on("session_start", (_event, ctx) => {
    latestCtx = ctx;
  });

  // Clean up on session shutdown
  pi.on("session_shutdown", (_event, _ctx) => {
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
    }
    for (const [_id, agent] of runningSubagents) {
      agent.abortController?.abort();
    }
    runningSubagents.clear();
  });

  // Tools denied via PI_DENY_TOOLS env var (set by parent agent based on frontmatter)
  const deniedTools = new Set(
    (process.env.PI_DENY_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
  );

  // Depth gating: subagent is available everywhere, agent_group only in the main session.
  // Raw forks set PI_SUBAGENT_NAME, typed forks also set PI_SUBAGENT_AGENT.
  const isInsideSubagent = !!(process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_AGENT);
  const shouldRegister = (name: string) => {
    if (deniedTools.has(name)) return false;
    if (name === "agent_group" && isInsideSubagent) return false;
    return true;
  };

  // ── subagent tool ──
  shouldRegister("subagent") && pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description:
      "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
      "Returns immediately — the agent runs in the background and steers results back when done. " +
      "After launch, inform the user and wait; do not poll unless explicitly asked. " +
      "Supports Supaterm (sp), cmux, and zellij.",
    promptSnippet:
      "Spawn a sub-agent in a dedicated terminal multiplexer pane. " +
      "Returns immediately — the agent runs in the background and steers results back when done. " +
      "After launch, inform the user and wait; do not poll unless explicitly asked. " +
      "Supports Supaterm (sp), cmux, and zellij." +
      (muxCliPromptSnippet() ? "\n\n" + muxCliPromptSnippet() : ""),
    parameters: SubagentParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Prevent self-spawning (e.g. planner spawning another planner)
      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      if (params.agent && currentAgent && params.agent === currentAgent) {
        return {
          content: [{ type: "text", text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.` }],
          details: { error: "self-spawn blocked" },
        };
      }

      if (!ctx.sessionManager.getSessionFile()) {
        return {
          content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." }],
          details: { error: "no session file" },
        };
      }

      // Launch the subagent (creates pane, sends command)
      const running = await launchSubagent(params, ctx);

      // Create a separate AbortController for the watcher
      // (the tool's signal completes when we return)
      const watcherAbort = new AbortController();
      running.abortController = watcherAbort;

      // Start widget refresh when first agent launches
      startWidgetRefresh();

      // Fire-and-forget: start watching in background
      watchSubagent(running, watcherAbort.signal).then((result) => {
        updateWidget(); // reflect removal from Map immediately
        sendSingleSubagentResult(pi, running, result);
      }).catch((err) => {
        updateWidget();
        pi.sendMessage({
          customType: "subagent_result",
          content: `Sub-agent "${running.name}" error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: running.name, task: running.task, error: err?.message },
        }, { triggerTurn: true, deliverAs: "steer" });
      });

      // Return immediately
      return {
        content: [{
          type: "text",
          text: `Sub-agent "${params.name}" launched and running in the background. Results will return automatically in this session. Inform the user and wait; only call status/nudge tools if the user explicitly asks.${compatModeNote()}`,
        }],
        details: {
          id: running.id,
          name: params.name,
          task: params.task,
          agent: params.agent,
          model: running.model,
          modelHint: running.modelHint,
          status: "started",
          autoReturn: true,
          nextAction: "Inform user launch succeeded and wait for automatic result.",
        },
      };
    },

    renderCall(args, theme) {
      const agent = args.agent ? theme.fg("dim", ` (${args.agent})`) : "";
      const hint = args.modelHint ? theme.fg("dim", ` [${args.modelHint}]`) : "";
      const cwdHint = args.cwd ? theme.fg("dim", ` in ${args.cwd}`) : "";
      let text =
        "▸ " +
        theme.fg("toolTitle", theme.bold(args.name ?? "(unnamed)")) +
        agent +
        hint +
        cwdHint;

      // Show a one-line task preview. renderCall is called repeatedly as the
      // LLM generates tool arguments, so args.task grows token by token.
      // We keep it compact here — Ctrl+O on renderResult expands the full content.
      const task = args.task ?? "";
      if (task) {
        const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
        const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
        if (preview) {
          text += "\n" + theme.fg("toolOutput", preview);
        }
        const totalLines = task.split("\n").length;
        if (totalLines > 1) {
          text += theme.fg("muted", ` (${totalLines} lines)`);
        }
      }

      return new Text(text, 0, 0);
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "(unnamed)";

      // "Started" result — tool returned immediately
      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") + " " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — launched (auto-return)"),
          0, 0
        );
      }

      // Fallback (shouldn't happen)
      const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });

  // ── agent_group tool (only available at the main session level) ──
  shouldRegister("agent_group") && pi.registerTool({
    name: "agent_group",
    label: "Agent Group",
    description:
      "Spawn a group of sub-agents concurrently and collect their results together. " +
      "Returns immediately and sends one grouped update when all subagents finish. " +
      "After launch, inform the user and wait; do not poll unless explicitly asked.",
    promptSnippet:
      "Spawn a group of sub-agents concurrently and collect their results together. " +
      "Returns immediately and sends one grouped update when all subagents finish. " +
      "After launch, inform the user and wait; do not poll unless explicitly asked.",
    parameters: AgentGroupParams,

    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      if (!ctx.sessionManager.getSessionFile()) {
        return {
          content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use subagents." }],
          details: { error: "no session file" },
        };
      }

      const groupName = params.name?.trim() || "Agent group";
      const currentAgent = process.env.PI_SUBAGENT_AGENT;
      const started: RunningSubagent[] = [];

      for (const agentParams of params.agents) {
        if (agentParams.agent && currentAgent && agentParams.agent === currentAgent) {
          return {
            content: [{ type: "text", text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. Complete the task directly.` }],
            details: { error: "self-spawn blocked" },
          };
        }
      }

      for (const agentParams of params.agents) {
        const running = await launchSubagent(agentParams, ctx);
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;
        started.push(running);
      }

      startWidgetRefresh();

      const waitForAll = async () => {
        const results: ParallelSubagentResult[] = [];
        for (let i = 0; i < started.length; i++) {
          const running = started[i];
          const result = await watchSubagent(running, running.abortController!.signal);
          updateWidget();
          results.push({ ...result, agent: running.agent });

          if (params.wait) {
            onUpdate?.({
              content: [{
                type: "text",
                text: `${groupName}: ${results.length}/${started.length} finished — ${running.name}`,
              }],
            });
          }
        }
        return results;
      };

      if (false) {
        const results = await waitForAll();
        const completed = results.filter((r) => r.exitCode === 0).length;
        const failed = results.length - completed;
        return {
          content: [{ type: "text", text: buildParallelGroupContent(groupName, results) }],
          details: {
            name: groupName,
            status: "completed",
            total: results.length,
            completed,
            failed,
            elapsed: results.reduce((max, r) => Math.max(max, r.elapsed), 0),
            results,
          },
        };
      }

      waitForAll().then((results) => {
        sendAgentGroupResult(pi, groupName, results, true);
      }).catch((err) => {
        updateWidget();
        pi.sendMessage({
          customType: "agent_group_result",
          content: `${groupName} error: ${err?.message ?? String(err)}`,
          display: true,
          details: { name: groupName, error: err?.message },
        }, { triggerTurn: true, deliverAs: "steer" });
      });

      return {
        content: [{
          type: "text",
          text: `${groupName} launched with ${started.length} subagents. The grouped result will return automatically when all are done. Inform the user and wait; only poll or nudge if the user explicitly asks.${compatModeNote()}`,
        }],
        details: {
          name: groupName,
          status: "started",
          total: started.length,
          autoReturn: true,
          nextAction: "Inform user launch succeeded and wait for automatic grouped result.",
          agents: started.map((running) => ({
            id: running.id,
            name: running.name,
            task: running.task,
            agent: running.agent,
            model: running.model,
            modelHint: running.modelHint,
          })),
        },
      };
    },

    renderCall(args, theme) {
      const name = args.name ?? "Agent group";
      const count = Array.isArray(args.agents) ? args.agents.length : 0;
      return new Text(
        "▸ " +
        theme.fg("toolTitle", theme.bold(name)) +
        theme.fg("dim", ` — ${count} subagents`),
        0, 0,
      );
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const name = details?.name ?? "Agent group";

      if (details?.status === "started") {
        return new Text(
          theme.fg("accent", "▸") + " " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", ` — launched (${details.total ?? 0} subagents, auto-return)`),
          0, 0,
        );
      }

      if (details?.status === "completed") {
        const failed = details?.failed ?? 0;
        const completed = details?.completed ?? 0;
        const status = failed === 0
          ? theme.fg("success", `✓ ${completed}/${details.total} succeeded`)
          : theme.fg("error", `✗ ${failed} failed`) + theme.fg("dim", ` (${completed}/${details.total} succeeded)`);
        return new Text(
          theme.fg("toolTitle", theme.bold(name)) + " — " + status,
          0, 0,
        );
      }

      const text = typeof result.content?.[0]?.text === "string" ? result.content[0].text : "";
      return new Text(theme.fg("dim", text), 0, 0);
    },
  });


  // ── active_subagents tool ──
  shouldRegister("active_subagents") && pi.registerTool({
    name: "active_subagents",
    label: "Active Subagents",
    description:
      "List all currently running subagents in this session. " +
      "Optionally include recent screen output so the outer agent can inspect progress before nudging them.",
    promptSnippet:
      "List all currently running subagents in this session. " +
      "Optionally include recent screen output so the outer agent can inspect progress before nudging them.",
    parameters: ActiveSubagentsParams,

    async execute(_toolCallId, params) {
      const screenLines = Math.max(0, Math.min(200, params.screenLines ?? 0));
      const agents = getRunningSubagentsSnapshot().map((agent) => {
        let screen: string | undefined;
        if (screenLines > 0) {
          try {
            screen = readScreen(agent.surface, screenLines).trim();
          } catch (err: any) {
            screen = `[screen unavailable: ${err?.message ?? String(err)}]`;
          }
        }
        return { ...agent, screen };
      });

      if (agents.length === 0) {
        return {
          content: [{ type: "text", text: "No running subagents." }],
          details: { agents: [] },
        };
      }

      const text = agents.map((agent) => {
        const lines = [
          `${agent.id} · ${agent.name}${agent.agent ? ` (${agent.agent})` : ""} · ${formatElapsed(agent.elapsed)}`,
          `  surface: ${agent.surface}`,
          `  session: ${agent.sessionFile}`,
          `  task: ${agent.task}`,
        ];
        if (agent.modelHint) {
          lines.push(`  model hint: ${agent.modelHint}`);
        }
        if (agent.model) {
          lines.push(`  model: ${agent.model}`);
        }
        if (agent.entries != null || agent.bytes != null) {
          lines.push(`  progress: ${agent.entries ?? 0} msgs, ${formatBytes(agent.bytes ?? 0)}`);
        }
        if (agent.screen) {
          lines.push("  screen:");
          lines.push(...agent.screen.split("\n").map((line) => `    ${line}`));
        }
        return lines.join("\n");
      }).join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: { agents },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const agents = details?.agents ?? [];
      if (agents.length === 0) {
        return new Text(theme.fg("dim", "No running subagents."), 0, 0);
      }

      const lines = agents.map((agent: any) => {
        const meta = [agent.agent ? `(${agent.agent})` : null, agent.elapsed != null ? formatElapsed(agent.elapsed) : null]
          .filter(Boolean)
          .join(" · ");
        return `  ${theme.fg("toolTitle", theme.bold(agent.name))} ${theme.fg("dim", `[${agent.id}]${meta ? ` ${meta}` : ""}`)}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── subagents_list tool ──
  shouldRegister("subagents_list") && pi.registerTool({
    name: "subagents_list",
    label: "List Subagents",
    description:
      "List all available subagent definitions. " +
      "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
      "Project-local agents override global ones with the same name.",
    promptSnippet:
      "List all available subagent definitions. " +
      "Scans project-local .pi/agents/ and global ~/.pi/agent/agents/. " +
      "Project-local agents override global ones with the same name.",
    parameters: Type.Object({}),

    async execute() {
      const agents = new Map<string, { name: string; description?: string; model?: string; source: string }>();

      const dirs = [
        { path: join(dirname(new URL(import.meta.url).pathname), "../../agents"), source: "package" },
        { path: join(homedir(), ".pi", "agent", "agents"), source: "global" },
        { path: join(process.cwd(), ".pi", "agents"), source: "project" },
      ];

      for (const { path: dir, source } of dirs) {
        if (!existsSync(dir)) continue;
        for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
          const content = readFileSync(join(dir, file), "utf8");
          const match = content.match(/^---\n([\s\S]*?)\n---/);
          if (!match) continue;
          const frontmatter = match[1];
          const get = (key: string) => {
            const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
            return m ? m[1].trim() : undefined;
          };
          const name = get("name") ?? file.replace(/\.md$/, "");
          agents.set(name, {
            name,
            description: get("description"),
            model: get("model"),
            source,
          });
        }
      }

      if (agents.size === 0) {
        return {
          content: [{ type: "text", text: "No subagent definitions found." }],
          details: { agents: [] },
        };
      }

      const list = [...agents.values()];
      const lines = list.map((a) => {
        const badge = a.source === "project" ? " (project)" : "";
        const desc = a.description ? ` — ${a.description}` : "";
        const model = a.model ? ` [${a.model}]` : "";
        return `• ${a.name}${badge}${model}${desc}`;
      });

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { agents: list },
      };
    },

    renderResult(result, _opts, theme) {
      const details = result.details as any;
      const agents = details?.agents ?? [];
      if (agents.length === 0) {
        return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
      }
      const lines = agents.map((a: any) => {
        const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
        const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
        const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
        return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });

  // ── branch tool (main session only — blocking context-preserving fork) ──
  shouldRegister("branch") && !isInsideSubagent && pi.registerTool({
    name: "branch",
    label: "Branch",
    description:
      "Branch the current session into one or more parallel tracks. " +
      "Each track gets a full copy of the conversation context and works independently in its own terminal pane. " +
      "BLOCKS until all tracks complete, then returns their combined results. " +
      "Prefer branch over agent_group when the task benefits from the accumulated conversation context — " +
      "agent_group starts fresh sessions, branch carries forward everything discussed so far.",
    promptSnippet:
      "Branch the current session into parallel tracks that carry forward the full conversation context. " +
      "BLOCKS until all tracks complete. Returns combined results. " +
      "Prefer branch when the task needs context from the current conversation (plans, decisions, code discussed). " +
      "Use agent_group when tasks are independent and don't need prior context. " +
      "IMPORTANT: commit all pending changes before branching — each track shares the same working directory, so a clean commit point prevents merge conflicts between parallel tracks.",
    parameters: BranchParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        return {
          content: [{ type: "text", text: "Error: no session file. Start pi with a persistent session to use branch." }],
          details: { error: "no session file" },
        };
      }

      const trackCount = params.tracks.length;
      const started: RunningSubagent[] = [];

      // Launch all forks
      for (let i = 0; i < trackCount; i++) {
        const track = params.tracks[i];

        let forkPrompt: string;
        if (trackCount === 1) {
          // Single-track fork: no parallel context needed
          forkPrompt = [
            `Your task: ${track.prompt}`,
            `When done, write a concise summary of what you accomplished and any changes you made.`,
          ].join(" ");
        } else {
          const otherTracks = params.tracks
            .filter((_, j) => j !== i)
            .map((t) => t.name)
            .join(", ");
          forkPrompt = [
            `You are fork "${track.name}" (${i + 1}/${trackCount}).`,
            `Your task: ${track.prompt}`,
            `Other tracks running in parallel: ${otherTracks}.`,
            `Work independently on your track only. Do not attempt work belonging to the other tracks.`,
            `When done, write a concise summary of what you accomplished and any changes you made.`,
          ].join(" ");
        }

        const running = await launchSubagent(
          {
            name: `Fork: ${track.name}`,
            task: forkPrompt,
            fork: true,
            model: params.model,
            modelHint: params.modelHint,
          },
          ctx,
        );
        const watcherAbort = new AbortController();
        running.abortController = watcherAbort;

        // Propagate parent abort to each watcher
        if (signal) {
          signal.addEventListener("abort", () => watcherAbort.abort(), { once: true });
        }

        started.push(running);
      }

      startWidgetRefresh();

      // Block: await ALL forks concurrently.
      // Keep final results in track order, but stream progress as each one finishes.
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
              text: `branch: ${done}/${trackCount} tracks done${remaining > 0 ? `, ${remaining} running...` : ", all complete."}`,
            }],
            details: {
              done,
              total: trackCount,
              results: resultsByIndex.filter((r): r is SubagentResult => !!r),
            },
          });

          return result;
        })
      );

      const results = await Promise.all(watchTasks);

      // Build combined output
      const successCount = results.filter((r) => r.exitCode === 0).length;
      const maxElapsed = results.reduce((max, r) => Math.max(max, r.elapsed), 0);
      const sections = results.map((r, i) => {
        const track = params.tracks[i];
        const status = r.exitCode === 0 ? "completed" : `FAILED (exit ${r.exitCode})`;
        const sessionRef = r.sessionFile
          ? `\nSession: ${r.sessionFile}\nResume: pi --session ${r.sessionFile}`
          : "";
        return `## Fork: ${track.name} [${status}] (${formatElapsed(r.elapsed)})\n\n${r.summary || "(no output)"}${sessionRef}`;
      });

      const header = `Branch completed: ${successCount}/${trackCount} succeeded. Wall time: ${formatElapsed(maxElapsed)}.`;
      const combined = `${header}\n\n${sections.join("\n\n---\n\n")}`;

      return {
        content: [{ type: "text", text: combined }],
        details: {
          mode: "branch",
          total: trackCount,
          completed: successCount,
          failed: trackCount - successCount,
          elapsed: maxElapsed,
          results: results.map((r, i) => ({
            name: params.tracks[i].name,
            task: params.tracks[i].prompt,
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
        theme.fg("toolTitle", theme.bold("branch ")) +
        theme.fg("accent", `${tracks.length} track${tracks.length === 1 ? "" : "s"}`);
      for (const t of tracks.slice(0, 5)) {
        const preview = (t.prompt ?? "").length > 60 ? (t.prompt ?? "").slice(0, 60) + "…" : (t.prompt ?? "");
        text += `\n  ${theme.fg("accent", t.name ?? "?")}${theme.fg("dim", ` ${preview}`)}`;
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

      const header = `${icon} ${theme.fg("toolTitle", theme.bold("branch"))} — ${status} ${theme.fg("dim", `(${elapsed})`)}`;

      if (expanded) {
        const container = new Container();
        container.addChild(new Text(header, 0, 0));

        for (const r of details.results) {
          const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
          container.addChild(new Spacer(1));
          container.addChild(
            new Text(
              `${theme.fg("muted", "─── ")}${theme.fg("accent", r.name)} ${rIcon} ${theme.fg("dim", `(${formatElapsed(r.elapsed)})`)}`,
              0, 0
            )
          );
          if (r.summary) {
            const lines = r.summary.split("\n");
            container.addChild(new Text(lines.join("\n"), 0, 0));
          }
          if (r.sessionFile) {
            container.addChild(new Text(theme.fg("dim", `Session: ${r.sessionFile}`), 0, 0));
          }
        }
        return container;
      }

      // Collapsed: header + per-track one-liner
      let text = header;
      for (const r of details.results) {
        const rIcon = r.exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const preview = (r.summary ?? "").split("\n")[0] ?? "";
        const truncated = preview.length > 80 ? preview.slice(0, 80) + "…" : preview;
        text += `\n  ${rIcon} ${theme.fg("accent", r.name)} ${theme.fg("dim", truncated)}`;
      }
      text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      return new Text(text, 0, 0);
    },
  });

  // Helper: launch a subagent directly from a command (bypasses model tool call)
  async function launchFromCommand(
    params: typeof SubagentParams.static,
    ctx: ExtensionContext,
    label: string,
  ) {
    if (!ctx.sessionManager.getSessionFile()) {
      ctx.ui.notify("No session file — start pi with a persistent session.", "error");
      return;
    }

    const running = await launchSubagent(params, ctx);
    const watcherAbort = new AbortController();
    running.abortController = watcherAbort;
    startWidgetRefresh();

    watchSubagent(running, watcherAbort.signal).then((result) => {
      updateWidget();
      sendSingleSubagentResult(pi, running, result);
    }).catch((err) => {
      updateWidget();
      pi.sendMessage({
        customType: "subagent_result",
        content: `Sub-agent "${label}" error: ${err?.message ?? String(err)}`,
        display: true,
        details: { name: label, task: params.task, error: err?.message },
      }, { triggerTurn: true, deliverAs: "steer" });
    });

    // Widget already shows the running agent — no notification needed
  }

  // /iterate command — fork the session into a subagent
  pi.registerCommand("iterate", {
    description: "Fork session into a subagent for focused work. Usage: /iterate [--agent <name>] <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      const agentMatch = trimmed.match(/^--agent\s+(\S+)\s*(.*)$/);
      const agent = agentMatch?.[1];
      const task = (agentMatch?.[2] ?? trimmed).trim() || "The user wants to do some hands-on work. Help them with whatever they need.";
      await launchFromCommand(
        { name: agent ?? "Iterate", agent, task, fork: true },
        ctx,
        agent ? `Iterate:${agent}` : "Iterate",
      );
    },
  });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> [--hint frontend|non-frontend] <task>",
    handler: async (args, ctx) => {
      const trimmed = (args ?? "").trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [--hint frontend|non-frontend] [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.indexOf(" ");
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      let rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      let modelHint: ModelHint | undefined;
      const hintMatch = rest.match(/(?:^|\s)--hint\s+(frontend|non-frontend|front-end|non-front-end|ui|ux|design|backend|general|code|coding)(?=\s|$)/i);
      if (hintMatch) {
        const hinted = resolveHintedModel({ modelHint: hintMatch[1] }).modelHint;
        if (!hinted) {
          ctx.ui.notify(`Unknown model hint: ${hintMatch[1]}`, "warning");
          return;
        }
        modelHint = hinted;
        rest = `${rest.slice(0, hintMatch.index)} ${rest.slice((hintMatch.index ?? 0) + hintMatch[0].length)}`.trim();
      }

      const defs = loadAgentDefaults(agentName);
      if (!defs) {
        ctx.ui.notify(`Agent "${agentName}" not found in ~/.pi/agent/agents/ or .pi/agents/`, "error");
        return;
      }

      const taskText = rest || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      await launchFromCommand({ name: displayName, agent: agentName, task: taskText, modelHint }, ctx, displayName);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = exitCode === 0
          ? (text: string) => theme.bg("toolSuccessBg", text)
          : (text: string) => theme.bg("toolErrorBg", text);
        const icon = exitCode === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const status = exitCode === 0 ? "completed" : `failed (exit ${exitCode})`;
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "");

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      }
    };
  });

  pi.registerMessageRenderer("agent_group_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "Agent group";
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const failed = details.failed ?? 0;
        const completed = details.completed ?? 0;
        const total = details.total ?? completed + failed;
        const bgFn = failed === 0
          ? (text: string) => theme.bg("toolSuccessBg", text)
          : (text: string) => theme.bg("toolErrorBg", text);
        const icon = failed === 0 ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const status = failed === 0
          ? `${completed}/${total} succeeded`
          : `${completed}/${total} succeeded, ${failed} failed`;

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";
        const contentLines = [header];

        if (options.expanded) {
          for (const line of rawContent.split("\n")) {
            contentLines.push(line.slice(0, width - 6));
          }
        } else {
          const previewLines = rawContent.split("\n").slice(0, 8);
          for (const line of previewLines) {
            contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
          }
          const totalLines = rawContent.split("\n").length;
          if (totalLines > 8) {
            contentLines.push(theme.fg("muted", `… ${totalLines - 8} more lines`));
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      }
    };
  });

  // /plan command — start the full planning workflow
  pi.registerCommand("plan", {
    description: "Start a planning session: /plan <what to build>",
    handler: async (args, ctx) => {
      const task = (args ?? "").trim();
      if (!task) {
        ctx.ui.notify("Usage: /plan <what to build>", "warning");
        return;
      }

      // Rename workspace and tab to show this is a planning session
      try {
        const label = task.length > 40 ? task.slice(0, 40) + "..." : task;
        renameWorkspace(`🎯 ${label}`);
        renameCurrentTab(`🎯 Plan: ${label}`);
      } catch {
        // non-critical -- do not block the plan
      }

      // Load the plan skill from the subagents extension directory
      const planSkillPath = join(dirname(new URL(import.meta.url).pathname), "plan-skill.md");
      let content = readFileSync(planSkillPath, "utf8");
      content = content.replace(/^---\n[\s\S]*?\n---\n*/, "");
      pi.sendUserMessage(`<skill name="plan" location="${planSkillPath}">\n${content.trim()}\n</skill>\n\n${task}`);
    },
  });
}
