import { execSync, execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "supaterm" | "cmux" | "zellij" | "screen" | "compat";

// ── Screen (GNU Screen) backend ─────────────────────────────────────────
// Used when no visual multiplexer is available but `screen` is installed.
// Provides a real PTY so pi's TUI works correctly.

interface ScreenEntry {
  sessionName: string;
  started: boolean; // true after first sendCommand
}

const screenStore = new Map<string, ScreenEntry>();
let screenIdCounter = 0;

// ── Compat (child_process) backend ──────────────────────────────────────
// Last-resort fallback when neither a visual multiplexer nor screen is available.
// Subagents run as headless child processes with piped IO.
// WARNING: pi requires a TTY — compat mode will hang for pi processes.
// It works for simple non-interactive commands (tests, echo, etc).

interface CompatEntry {
  child: ChildProcess | null;
  outputBuffer: string;
}

const compatStore = new Map<string, CompatEntry>();
let compatIdCounter = 0;
export type SplitDirection = "left" | "right" | "up" | "down";

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execSync(`command -v ${command}`, { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

function muxPreference(): MuxBackend | null {
  const pref = (process.env.PI_SUBAGENT_MUX ?? "").trim().toLowerCase();
  if (pref === "supaterm" || pref === "sp") return "supaterm";
  if (pref === "cmux" || pref === "zellij") return pref;
  if (pref === "screen") return "screen";
  if (pref === "compat") return "compat";
  return null;
}

// ── Screen detection ─────────────────────────────────────────────────────

function isScreenRuntimeAvailable(): boolean {
  return hasCommand("screen");
}

export function isScreenAvailable(): boolean {
  return isScreenRuntimeAvailable();
}

// ── Supaterm detection ──────────────────────────────────────────────────

/**
 * Resolve the `sp` CLI binary path.
 * Prefers SUPATERM_CLI_PATH (the bundled binary injected into Supaterm panes),
 * falls back to `sp` on PATH.
 */
function spBin(): string {
  const envPath = process.env.SUPATERM_CLI_PATH?.trim();
  if (envPath && existsSync(envPath)) return envPath;
  return "sp";
}

function isSupatermRuntimeAvailable(): boolean {
  return !!process.env.SUPATERM_SOCKET_PATH && (!!process.env.SUPATERM_CLI_PATH || hasCommand("sp"));
}

export function isSupatermAvailable(): boolean {
  return isSupatermRuntimeAvailable();
}

// ── Supaterm sp CLI wrappers with retry ───────────────────────────────
//
// Every call to the Supaterm `sp` binary is a thin CLI over an IPC socket
// to the Supaterm app. Under concurrent load (dozens of subagents spawning
// / polling simultaneously) it can fail transiently with messages like:
//   Command failed: /Applications/supaterm.app/Contents/Resources/bin/sp \
//     tab new --json
//   Error: Failed to read a response from Supaterm.
// or the same message for `pane capture` / `pane send` / `pane close`.
//
// These failures are NOT signals that Supaterm is unhealthy — they're
// socket races that clear up on the next attempt. Without the retry below,
// a single transient hiccup at spawn time (tab new) would kill the
// subagent before it even started; at poll time (pane capture) it would
// prematurely declare a still-running subagent "failed". Both made
// agent_group runs collapse en masse.
//
// Strategy: every sp call goes through spExecSync / spExecAsync, which
// retry a small number of times with linear backoff on known transient
// error patterns. Non-transient errors fall through immediately so real
// bugs still surface.

const SUPATERM_TRANSIENT_PATTERNS = [
  /failed to read a response from supaterm/i,
  /failed to send message to supaterm/i,
  /connection refused/i,
  /broken pipe/i,
  /eagain/i,
  /etimedout/i,
  /socket hang up/i,
  /no such file or directory.*\.sock/i,
];

function isSupatermTransientError(err: unknown): boolean {
  if (!err) return false;
  const message =
    err instanceof Error
      ? `${err.message}\n${(err as { stderr?: string }).stderr ?? ""}`
      : String(err);
  return SUPATERM_TRANSIENT_PATTERNS.some((re) => re.test(message));
}

// Attempts and backoff are shared across all sp commands. Kept the old
// *_CAPTURE_* env names as aliases for backwards compat with anyone who
// was already overriding them.
const SUPATERM_ATTEMPTS = Number(
  process.env.PI_SUBAGENT_SUPATERM_ATTEMPTS ??
    process.env.PI_SUBAGENT_SUPATERM_CAPTURE_ATTEMPTS ??
    "4",
);
const SUPATERM_BACKOFF_MS = Number(
  process.env.PI_SUBAGENT_SUPATERM_BACKOFF_MS ??
    process.env.PI_SUBAGENT_SUPATERM_CAPTURE_BACKOFF_MS ??
    "100",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepSync(ms: number): void {
  // Synchronous sleep via Atomics so sync sp callers still get retry
  // behavior without pulling in a new dep. Node's main thread permits
  // Atomics.wait (unlike browser main threads).
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

interface SpExecOptions {
  input?: string;
}

function spExecSync(args: string[], opts: SpExecOptions = {}): string {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SUPATERM_ATTEMPTS; attempt++) {
    try {
      const out = execFileSync(spBin(), args, {
        encoding: "utf8",
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      });
      return typeof out === "string" ? out : String(out);
    } catch (err) {
      lastError = err;
      if (attempt >= SUPATERM_ATTEMPTS || !isSupatermTransientError(err)) {
        break;
      }
      sleepSync(SUPATERM_BACKOFF_MS * attempt);
    }
  }
  throw lastError;
}

async function spExecAsync(args: string[], opts: SpExecOptions = {}): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SUPATERM_ATTEMPTS; attempt++) {
    try {
      const { stdout } = await execFileAsync(spBin(), args, {
        encoding: "utf8",
        ...(opts.input !== undefined ? { input: opts.input } : {}),
      });
      return typeof stdout === "string" ? stdout : String(stdout);
    } catch (err) {
      lastError = err;
      if (attempt >= SUPATERM_ATTEMPTS || !isSupatermTransientError(err)) {
        break;
      }
      await sleep(SUPATERM_BACKOFF_MS * attempt);
    }
  }
  throw lastError;
}

function supatermCaptureSync(surface: string, lines: number): string {
  return spExecSync([
    "pane", "capture", surface,
    "--lines", String(lines),
    "--scope", "scrollback",
  ]);
}

async function supatermCaptureAsync(surface: string, lines: number): Promise<string> {
  return spExecAsync([
    "pane", "capture", surface,
    "--lines", String(lines),
    "--scope", "scrollback",
  ]);
}

// ── cmux detection ──────────────────────────────────────────────────────

function isCmuxRuntimeAvailable(): boolean {
  return !!process.env.CMUX_SOCKET_PATH && hasCommand("cmux");
}

export function isCmuxAvailable(): boolean {
  return isCmuxRuntimeAvailable();
}

// ── zellij detection ────────────────────────────────────────────────────

function isZellijRuntimeAvailable(): boolean {
  return !!(process.env.ZELLIJ || process.env.ZELLIJ_SESSION_NAME) && hasCommand("zellij");
}

export function isZellijAvailable(): boolean {
  return isZellijRuntimeAvailable();
}

// ── Backend resolution ──────────────────────────────────────────────────
// Precedence: supaterm > cmux > zellij
// Supaterm must come first because `sp run` injects TMUX env vars for compat,
// which would cause a false-positive tmux detection if tmux were still checked.

// Precedence: supaterm > cmux > zellij > screen > compat (always available)
export function getMuxBackend(): MuxBackend {
  const pref = muxPreference();
  if (pref === "compat") return "compat";
  if (pref === "screen") return isScreenRuntimeAvailable() ? "screen" : "compat";
  if (pref === "supaterm") return isSupatermRuntimeAvailable() ? "supaterm" : "compat";
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : "compat";
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : "compat";

  if (isSupatermRuntimeAvailable()) return "supaterm";
  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  if (isScreenRuntimeAvailable()) return "screen";
  return "compat";
}

/** Always true — screen or compat backend is always available. */
export function isMuxAvailable(): boolean {
  return true;
}

/** True when using raw child_process fallback (no PTY — interactive pi will hang). */
export function isCompatMode(): boolean {
  return getMuxBackend() === "compat";
}

/** True when no visual pane management is available (screen or raw compat). */
export function isNonVisualMode(): boolean {
  const b = getMuxBackend();
  return b === "screen" || b === "compat";
}

export function muxSetupHint(): string {
  const pref = muxPreference();
  if (pref === "supaterm") {
    return "Run pi inside Supaterm.";
  }
  if (pref === "cmux") {
    return "Start pi inside cmux (`cmux pi`).";
  }
  if (pref === "zellij") {
    return "Start pi inside zellij (`zellij --session pi`, then run `pi`).";
  }
  const backend = getMuxBackend();
  if (backend === "screen") {
    return "Running with GNU Screen backend (no visual panes). For the full experience, start pi inside Supaterm, cmux, or zellij.";
  }
  if (backend === "compat") {
    return "Running in raw compatibility mode (no PTY, no visual panes). Install GNU Screen, or start pi inside Supaterm, cmux, or zellij.";
  }
  return "Start pi inside Supaterm, cmux (`cmux pi`), or zellij (`zellij --session pi`, then run `pi`).";
}

function requireMuxBackend(): MuxBackend {
  return getMuxBackend();
}

// ── Shell helpers ───────────────────────────────────────────────────────

/**
 * Detect if the user's default shell is fish.
 * Fish uses $status instead of $? for exit codes.
 */
export function isFishShell(): boolean {
  const shell = process.env.SHELL ?? "";
  return basename(shell) === "fish";
}

/**
 * Return the shell-appropriate exit status variable ($? for bash/zsh, $status for fish).
 */
export function exitStatusVar(): string {
  return isFishShell() ? "$status" : "$?";
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function tailLines(text: string, lines: number): string {
  const split = text.split("\n");
  if (split.length <= lines) return text;
  return split.slice(-lines).join("\n");
}

// ── Zellij helpers ──────────────────────────────────────────────────────

function zellijPaneId(surface: string): string {
  return surface.startsWith("pane:") ? surface.slice("pane:".length) : surface;
}

function zellijEnv(surface?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (surface) {
    env.ZELLIJ_PANE_ID = zellijPaneId(surface);
  }
  return env;
}

function waitForFile(path: string, timeoutMs = 5000): string {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(path)) {
      return readFileSync(path, "utf8").trim();
    }
    Atomics.wait(sleeper, 0, 0, 20);
  }
  throw new Error(`Timed out waiting for zellij pane id file: ${path}`);
}

function zellijActionSync(args: string[], surface?: string): string {
  return execFileSync("zellij", ["action", ...args], {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
}

async function zellijActionAsync(args: string[], surface?: string): Promise<string> {
  const { stdout } = await execFileAsync("zellij", ["action", ...args], {
    encoding: "utf8",
    env: zellijEnv(surface),
  });
  return stdout;
}

// ── Supaterm helpers ────────────────────────────────────────────────────

/**
 * Result from `sp tab new --json` or `sp pane split --json`.
 * Contains both 1-based indices and stable UUIDs.
 * We use UUIDs as surface identifiers because positional indices shift when
 * tabs are closed — which breaks references to still-running subagent panes.
 */
interface SpCreateResult {
  windowIndex: number;
  spaceIndex: number;
  tabIndex: number;
  paneIndex: number;
  paneID: string;
  tabID: string;
  spaceID: string;
  [key: string]: unknown;
}

/**
 * Build a stable pane selector.
 * Prefers the UUID (survives tab close/reorder); falls back to
 * "space/tab/pane" indices for older Supaterm versions without UUIDs.
 */
function spPaneSelector(result: SpCreateResult): string {
  if (result.paneID) return result.paneID;
  return `${result.spaceIndex}/${result.tabIndex}/${result.paneIndex}`;
}

/**
 * Build a stable tab selector.
 * Prefers the UUID; falls back to "space/tab" indices.
 */
function spTabSelector(result: SpCreateResult): string {
  if (result.tabID) return result.tabID;
  return `${result.spaceIndex}/${result.tabIndex}`;
}

// ── Screen helpers ──────────────────────────────────────────────────────

/**
 * Capture the screen contents of a GNU Screen session.
 * Uses `hardcopy -h` (full scrollback) with `-p 0` (target window 0).
 */
function screenHardcopy(surface: string, lines: number): string {
  const entry = screenStore.get(surface);
  if (!entry) return "";
  const tmpFile = join(
    tmpdir(),
    `pi-screen-cap-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  try {
    execSync(
      `screen -S ${shellEscape(entry.sessionName)} -p 0 -X hardcopy -h ${shellEscape(tmpFile)}`,
      { encoding: "utf8" },
    );
    if (!existsSync(tmpFile)) return "";
    const content = readFileSync(tmpFile, "utf8");
    return tailLines(content.trimEnd(), lines);
  } catch {
    return ""; // Session may have already exited
  } finally {
    try { rmSync(tmpFile, { force: true }); } catch {}
  }
}

// ── CLI context for prompt injection ────────────────────────────────────

/**
 * Return a backend-specific CLI reference block for prompt injection.
 * This tells the agent which terminal management commands are available.
 */
export function muxCliPromptSnippet(): string | null {
  const backend = getMuxBackend();

  if (backend === "supaterm") {
    return [
      "You are running inside Supaterm. The `sp` CLI manages terminal tabs, panes, and spaces.",
      "Key sp commands:",
      "  sp tab new [--focus] [CMD...]          — create a new tab",
      "  sp pane split <dir> [--in TARGET]      — split pane (dir: down/right/left/up)",
      "  sp pane send TARGET TEXT               — send text to a pane (pipe via stdin with -)",
      "  sp pane capture TARGET [--lines N]     — read pane output (--scope scrollback|visible)",
      "  sp pane close TARGET                   — close a pane",
      "  sp tab rename TITLE [TARGET]           — rename a tab",
      "  sp space rename NAME                   — rename the current space/workspace",
      "  sp pane notify [--title T] [--body B]  — desktop notification",
      "  sp tree                                — show full terminal topology",
      "Target selectors are 1-based: space/tab/pane (e.g. 1/2/1).",
      "Output modes: --json | --plain | (default: human).",
    ].join("\n");
  }

  if (backend === "cmux") {
    return [
      "You are running inside cmux. The `cmux` CLI manages terminal surfaces.",
      "Key cmux commands:",
      "  cmux new-surface --type terminal       — create a new tab",
      "  cmux new-split <dir> [--surface ID]    — split pane (dir: down/right/left/up)",
      "  cmux send --surface ID TEXT            — send text to a surface",
      "  cmux read-screen --surface ID --lines N — read surface output",
      "  cmux close-surface --surface ID        — close a surface",
      "  cmux rename-tab --surface ID NAME      — rename a tab",
      "  cmux focus-panel --panel ID            — focus a surface",
      "Surface identifiers: surface:N (e.g. surface:42).",
    ].join("\n");
  }

  return null;
}

// ── Surface operations ──────────────────────────────────────────────────

/**
 * Create a new terminal surface for a subagent.
 * Uses a background tab in supaterm/cmux, and a split pane in zellij.
 * Returns an identifier (e.g. "1/2/1" in supaterm, "surface:42" in cmux, "pane:7" in zellij).
 */
export function createSurface(name: string, options?: { focus?: boolean }): string {
  const shouldFocus = options?.focus === true;
  const backend = requireMuxBackend();

  if (backend === "screen") {
    const sessionName = `pi-sa-${++screenIdCounter}-${Date.now()}`;
    const id = `screen:${sessionName}`;
    screenStore.set(id, { sessionName, started: false });
    return id;
  }

  if (backend === "compat") {
    const id = `compat:${++compatIdCounter}`;
    compatStore.set(id, { child: null, outputBuffer: "" });
    return id;
  }

  if (backend === "supaterm") {
    const args = ["tab", "new", "--json"];
    if (shouldFocus) args.push("--focus");
    const result: SpCreateResult = JSON.parse(spExecSync(args).trim());
    const surface = spPaneSelector(result);
    try {
      spExecSync(["tab", "rename", name, spTabSelector(result)]);
    } catch { /* optional */ }
    return surface;
  }

  if (backend === "cmux") {
    const out = execSync("cmux new-surface --type terminal", {
      encoding: "utf8",
    }).trim();
    const match = out.match(/surface:\d+/);
    if (!match) {
      throw new Error(`Unexpected cmux new-surface output: ${out}`);
    }
    const surface = match[0];
    execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, {
      encoding: "utf8",
    });
    if (shouldFocus) {
      execSync(`cmux focus-panel --panel ${shellEscape(surface)}`, {
        encoding: "utf8",
      });
    }
    return surface;
  }

  return createSurfaceSplit(name, "down", undefined, options);
}

/**
 * Create a new split in the given direction from an optional source pane.
 * Returns an identifier (e.g. "1/2/1" in supaterm, "surface:42" in cmux, "pane:7" in zellij).
 * In compat mode, splits are not supported — creates a new compat process instead.
 */
export function createSurfaceSplit(
  name: string,
  direction: SplitDirection,
  fromSurface?: string,
  options?: { focus?: boolean },
): string {
  const shouldFocus = options?.focus === true;
  const backend = requireMuxBackend();

  if (backend === "screen" || backend === "compat") {
    return createSurface(name, options);
  }

  if (backend === "supaterm") {
    const args = ["pane", "split", direction];
    if (!shouldFocus) args.push("--no-focus");
    if (fromSurface) args.push("--in", fromSurface);
    args.push("--json");
    const result: SpCreateResult = JSON.parse(spExecSync(args).trim());
    const surface = spPaneSelector(result);
    try {
      spExecSync(["tab", "rename", name, spTabSelector(result)]);
    } catch { /* optional */ }
    return surface;
  }

  if (backend === "cmux") {
    const surfaceArg = fromSurface ? ` --surface ${shellEscape(fromSurface)}` : "";
    const out = execSync(`cmux new-split ${direction}${surfaceArg}`, {
      encoding: "utf8",
    }).trim();
    const match = out.match(/surface:\d+/);
    if (!match) {
      throw new Error(`Unexpected cmux new-split output: ${out}`);
    }
    const surface = match[0];
    execSync(`cmux rename-tab --surface ${shellEscape(surface)} ${shellEscape(name)}`, {
      encoding: "utf8",
    });
    if (shouldFocus) {
      execSync(`cmux focus-panel --panel ${shellEscape(surface)}`, {
        encoding: "utf8",
      });
    }
    return surface;
  }

  // zellij
  const directionArg = direction === "left" || direction === "right" ? "right" : "down";
  const tokenPath = join(
    tmpdir(),
    `pi-subagent-zellij-pane-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  const args = ["new-pane", "--direction", directionArg, "--name", name, "--cwd", process.cwd()];

  try {
    zellijActionSync(args, fromSurface);
  } catch {
    if (!fromSurface) throw new Error("Failed to create zellij pane");
    zellijActionSync(args);
  }

  // IMPORTANT: do not pass a long-running command to `new-pane`.
  // zellij keeps the `action new-pane -- <cmd>` process attached until <cmd>
  // exits. If <cmd> is an interactive shell, the parent call hangs forever.
  // Instead, create a normal shell pane first, then ask the focused pane
  // to print its own $ZELLIJ_PANE_ID into a temp file.
  const captureIdCmd = `echo "$ZELLIJ_PANE_ID" > ${shellEscape(tokenPath)}`;
  zellijActionSync(["write-chars", captureIdCmd]);
  zellijActionSync(["write", "13"]);

  const paneId = waitForFile(tokenPath);
  try {
    rmSync(tokenPath, { force: true });
  } catch {}

  if (!paneId || !/^\d+$/.test(paneId)) {
    throw new Error(`Unexpected zellij pane id: ${paneId || "(empty)"}`);
  }

  const surface = `pane:${paneId}`;

  if (direction === "left" || direction === "up") {
    try {
      zellijActionSync(["move-pane", direction], surface);
    } catch {
      // Optional layout polish.
    }
  }

  try {
    zellijActionSync(["rename-pane", name], surface);
  } catch {
    // Optional.
  }

  return surface;
}

/**
 * Rename the current tab/window.
 */
export function renameCurrentTab(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "screen" || backend === "compat") {
    // Best-effort: terminal escape sequence (works in most emulators)
    try { process.stdout.write(`\x1b]0;${title}\x07`); } catch {}
    return;
  }

  if (backend === "supaterm") {
    // Uses ambient SUPATERM_SURFACE_ID context to find the current tab.
    spExecSync(["tab", "rename", title]);
    return;
  }

  if (backend === "cmux") {
    const surfaceId = process.env.CMUX_SURFACE_ID;
    if (!surfaceId) throw new Error("CMUX_SURFACE_ID not set");
    execSync(`cmux rename-tab --surface ${shellEscape(surfaceId)} ${shellEscape(title)}`, { encoding: "utf8" });
    return;
  }

  zellijActionSync(["rename-tab", title]);
}

/**
 * Rename the current workspace/session where supported.
 */
export function renameWorkspace(title: string): void {
  const backend = requireMuxBackend();

  if (backend === "screen" || backend === "compat") {
    // Best-effort: same escape sequence as renameCurrentTab
    try { process.stdout.write(`\x1b]0;${title}\x07`); } catch {}
    return;
  }

  if (backend === "supaterm") {
    try {
      spExecSync(["space", "rename", title]);
    } catch {
      // Optional — may fail with a single space.
    }
    return;
  }

  if (backend === "cmux") {
    execSync(`cmux workspace-action --action rename --title ${shellEscape(title)}`, { encoding: "utf8" });
    return;
  }

  zellijActionSync(["rename-session", title]);
}

/**
 * Send a command string to a pane and execute it.
 */
export function sendCommand(surface: string, command: string): void {
  const backend = requireMuxBackend();

  if (backend === "screen") {
    const entry = screenStore.get(surface);
    if (!entry) throw new Error(`Unknown screen surface: ${surface}`);

    if (!entry.started) {
      // First command — create a detached screen session running the command.
      // This gives the child process a real PTY so pi's TUI works.
      // After the command finishes, `exec cat` keeps the session alive so
      // pollForExit can read the sentinel via hardcopy. closeSurface sends
      // `screen -X quit` to tear it down.
      const wrappedCommand = `${command}; exec cat`;
      execSync(
        `screen -dmS ${shellEscape(entry.sessionName)} bash -c ${shellEscape(wrappedCommand)}`,
        { encoding: "utf8", env: { ...process.env } },
      );
      entry.started = true;
    } else {
      // Subsequent command (message_subagent) — use readbuf+paste for
      // arbitrary-length text (screen's `stuff` has a ~256 char limit).
      const tmpFile = join(
        tmpdir(),
        `pi-screen-msg-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
      );
      try {
        writeFileSync(tmpFile, command, "utf8");
        execSync(`screen -S ${shellEscape(entry.sessionName)} -p 0 -X readbuf ${shellEscape(tmpFile)}`, { encoding: "utf8" });
        execSync(`screen -S ${shellEscape(entry.sessionName)} -p 0 -X paste .`, { encoding: "utf8" });
        // Send Enter to execute
        execSync(`screen -S ${shellEscape(entry.sessionName)} -p 0 -X stuff "\\015"`, { encoding: "utf8" });
      } finally {
        try { rmSync(tmpFile, { force: true }); } catch {}
      }
    }
    return;
  }

  if (backend === "compat") {
    const entry = compatStore.get(surface);
    if (!entry) throw new Error(`Unknown compat surface: ${surface}`);

    if (!entry.child) {
      // First command — spawn a shell process
      const child = spawn("bash", ["-c", command], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
        cwd: process.cwd(),
      });
      entry.child = child;

      child.stdout?.on("data", (data: Buffer) => {
        entry.outputBuffer += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        entry.outputBuffer += data.toString();
      });
      child.on("error", () => {
        // Process spawn error — sentinel won't appear, pollForExit will hang
        // until aborted. Inject a failure sentinel so it gets picked up.
        entry.outputBuffer += "\n__SUBAGENT_DONE_1__\n";
      });
    } else {
      // Subsequent command — write to stdin (e.g. message_subagent)
      try {
        entry.child.stdin?.write(command + "\n");
      } catch {
        // stdin may be closed if the process already exited
      }
    }
    return;
  }

  if (backend === "supaterm") {
    // Pipe command text via stdin (`-`) and use `--newline` to append Enter.
    spExecSync(["pane", "send", "--newline", surface, "-"], { input: command });
    return;
  }

  if (backend === "cmux") {
    execSync(`cmux send --surface ${shellEscape(surface)} ${shellEscape(command + "\n")}`, {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["write-chars", command], surface);
  zellijActionSync(["write", "13"], surface);
}

/**
 * Read the screen contents of a pane (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  const backend = requireMuxBackend();

  if (backend === "screen") {
    return screenHardcopy(surface, lines);
  }

  if (backend === "compat") {
    const entry = compatStore.get(surface);
    if (!entry) return "";
    return tailLines(entry.outputBuffer, lines);
  }

  if (backend === "supaterm") {
    return supatermCaptureSync(surface, lines);
  }

  if (backend === "cmux") {
    return execSync(
      `cmux read-screen --surface ${shellEscape(surface)} --lines ${lines}`,
      { encoding: "utf8" }
    );
  }

  const tmpPath = join(
    tmpdir(),
    `pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  try {
    zellijActionSync(["dump-screen", tmpPath], surface);
    const raw = readFileSync(tmpPath, "utf8");
    return tailLines(raw, lines);
  } finally {
    try { rmSync(tmpPath, { force: true }); } catch {}
  }
}

/**
 * Read the screen contents of a pane (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  const backend = requireMuxBackend();

  if (backend === "screen") {
    return screenHardcopy(surface, lines);
  }

  if (backend === "compat") {
    const entry = compatStore.get(surface);
    if (!entry) return "";
    return tailLines(entry.outputBuffer, lines);
  }

  if (backend === "supaterm") {
    return supatermCaptureAsync(surface, lines);
  }

  if (backend === "cmux") {
    const { stdout } = await execFileAsync(
      "cmux",
      ["read-screen", "--surface", surface, "--lines", String(lines)],
      { encoding: "utf8" }
    );
    return stdout;
  }

  const tmpPath = join(
    tmpdir(),
    `pi-subagent-zellij-screen-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`
  );
  try {
    await zellijActionAsync(["dump-screen", tmpPath], surface);
    const raw = readFileSync(tmpPath, "utf8");
    return tailLines(raw, lines);
  } finally {
    try { rmSync(tmpPath, { force: true }); } catch {}
  }
}

/**
 * Close a pane.
 */
export function closeSurface(surface: string): void {
  const backend = requireMuxBackend();

  if (backend === "screen") {
    const entry = screenStore.get(surface);
    if (entry) {
      try {
        execSync(`screen -S ${shellEscape(entry.sessionName)} -p 0 -X quit`, { encoding: "utf8" });
      } catch {} // Session may already be dead
      screenStore.delete(surface);
    }
    return;
  }

  if (backend === "compat") {
    const entry = compatStore.get(surface);
    if (entry?.child) {
      try { entry.child.kill("SIGTERM"); } catch {}
    }
    compatStore.delete(surface);
    return;
  }

  if (backend === "supaterm") {
    spExecSync(["pane", "close", surface]);
    return;
  }

  if (backend === "cmux") {
    execSync(`cmux close-surface --surface ${shellEscape(surface)}`, {
      encoding: "utf8",
    });
    return;
  }

  zellijActionSync(["close-pane"], surface);
}

/**
 * Poll a pane until the __SUBAGENT_DONE_N__ sentinel appears.
 * Returns the process exit code embedded in the sentinel.
 * Throws if the signal is aborted before the sentinel is found.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: { interval: number; onTick?: (elapsed: number) => void }
): Promise<number> {
  const start = Date.now();
  // Budget for consecutive screen-read failures before we give up. At the
  // default 1s poll interval this is ~30s of complete screen-read failure
  // before we surface an error. Short enough to catch a truly dead pane,
  // long enough to ride out Supaterm socket contention.
  const maxConsecutiveReadErrors = Number(
    process.env.PI_SUBAGENT_POLL_MAX_READ_ERRORS ?? "30",
  );
  let consecutiveReadErrors = 0;
  let lastReadError: unknown;

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    let screen: string;
    try {
      screen = await readScreenAsync(surface, 5);
      consecutiveReadErrors = 0;
    } catch (err) {
      consecutiveReadErrors += 1;
      lastReadError = err;
      if (consecutiveReadErrors >= maxConsecutiveReadErrors) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Lost screen access to pane ${surface} (${consecutiveReadErrors} consecutive read errors): ${msg}`,
        );
      }
      // Skip this tick; the pane may still be running.
      screen = "";
    }

    const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
    if (match) {
      return parseInt(match[1], 10);
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);
    void lastReadError;

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, options.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
