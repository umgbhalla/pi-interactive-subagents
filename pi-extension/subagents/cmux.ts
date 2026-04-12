import { execSync, execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const execFileAsync = promisify(execFile);

export type MuxBackend = "supaterm" | "cmux" | "zellij";
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
  return null;
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

export function getMuxBackend(): MuxBackend | null {
  const pref = muxPreference();
  if (pref === "supaterm") return isSupatermRuntimeAvailable() ? "supaterm" : null;
  if (pref === "cmux") return isCmuxRuntimeAvailable() ? "cmux" : null;
  if (pref === "zellij") return isZellijRuntimeAvailable() ? "zellij" : null;

  if (isSupatermRuntimeAvailable()) return "supaterm";
  if (isCmuxRuntimeAvailable()) return "cmux";
  if (isZellijRuntimeAvailable()) return "zellij";
  return null;
}

export function isMuxAvailable(): boolean {
  return getMuxBackend() !== null;
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
  return "Start pi inside Supaterm, cmux (`cmux pi`), or zellij (`zellij --session pi`, then run `pi`).";
}

function requireMuxBackend(): MuxBackend {
  const backend = getMuxBackend();
  if (!backend) {
    throw new Error(`No supported terminal multiplexer found. ${muxSetupHint()}`);
  }
  return backend;
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

  if (backend === "supaterm") {
    const args = ["tab", "new", "--json"];
    if (shouldFocus) args.push("--focus");
    const result: SpCreateResult = JSON.parse(
      execFileSync(spBin(), args, { encoding: "utf8" }).trim()
    );
    const surface = spPaneSelector(result);
    try {
      execFileSync(spBin(), ["tab", "rename", name, spTabSelector(result)], { encoding: "utf8" });
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
 */
export function createSurfaceSplit(
  name: string,
  direction: SplitDirection,
  fromSurface?: string,
  options?: { focus?: boolean },
): string {
  const shouldFocus = options?.focus === true;
  const backend = requireMuxBackend();

  if (backend === "supaterm") {
    const args = ["pane", "split", direction];
    if (!shouldFocus) args.push("--no-focus");
    if (fromSurface) args.push("--in", fromSurface);
    args.push("--json");
    const result: SpCreateResult = JSON.parse(
      execFileSync(spBin(), args, { encoding: "utf8" }).trim()
    );
    const surface = spPaneSelector(result);
    try {
      execFileSync(spBin(), ["tab", "rename", name, spTabSelector(result)], { encoding: "utf8" });
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

  if (backend === "supaterm") {
    // Uses ambient SUPATERM_SURFACE_ID context to find the current tab.
    execFileSync(spBin(), ["tab", "rename", title], { encoding: "utf8" });
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

  if (backend === "supaterm") {
    try {
      execFileSync(spBin(), ["space", "rename", title], { encoding: "utf8" });
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

  if (backend === "supaterm") {
    // Pipe command text via stdin (`-`) and use `--newline` to append Enter.
    execFileSync(spBin(), ["pane", "send", "--newline", surface, "-"], {
      encoding: "utf8",
      input: command,
    });
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

  if (backend === "supaterm") {
    return execFileSync(spBin(), [
      "pane", "capture", surface,
      "--lines", String(lines),
      "--scope", "scrollback",
    ], { encoding: "utf8" });
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

  if (backend === "supaterm") {
    const { stdout } = await execFileAsync(spBin(), [
      "pane", "capture", surface,
      "--lines", String(lines),
      "--scope", "scrollback",
    ], { encoding: "utf8" });
    return stdout;
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

  if (backend === "supaterm") {
    execFileSync(spBin(), ["pane", "close", surface], { encoding: "utf8" });
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

  while (true) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    const screen = await readScreenAsync(surface, 5);
    const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
    if (match) {
      return parseInt(match[1], 10);
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    options.onTick?.(elapsed);

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
