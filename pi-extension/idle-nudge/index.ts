/**
 * Idle Nudge — Detects when an autonomous subagent goes idle without
 * writing an artifact, and nudges it to wrap up after 10 seconds.
 *
 * The problem: autonomous subagents run in visible cmux panes, so they still
 * have a UI. Detecting autonomy via `ctx.hasUI` is wrong. Instead, the parent
 * subagent spawner passes PI_SUBAGENT_INTERACTIVE=0|1 and this extension only
 * activates for subagent sessions explicitly marked interactive=0.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const IDLE_NUDGE_DELAY_MS = 10_000;

export default function (pi: ExtensionAPI) {
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let hasWrittenArtifact = false;
  let isAutonomousSubagent = false;
  let sessionCtx: any = null;
  let nudgeCount = 0;
  const MAX_NUDGES = 2;

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function startIdleTimer() {
    clearIdleTimer();

    if (!isAutonomousSubagent || hasWrittenArtifact || nudgeCount >= MAX_NUDGES) return;
    if (!sessionCtx) return;

    idleTimer = setTimeout(() => {
      idleTimer = null;

      if (!sessionCtx || !sessionCtx.isIdle() || hasWrittenArtifact) return;

      nudgeCount++;
      pi.sendUserMessage(
        "[Idle Nudge] You appear to be done but haven't written your artifact yet. " +
          "Please call `write_artifact` with your findings/results now, then finish up. " +
          "If you've already written it, call `subagent_done` to exit cleanly.",
        { deliverAs: "followUp" }
      );
    }, IDLE_NUDGE_DELAY_MS);
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionCtx = ctx;
    const isSubagent = !!(process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_AGENT);
    isAutonomousSubagent = isSubagent && process.env.PI_SUBAGENT_INTERACTIVE === "0";
    hasWrittenArtifact = false;
    nudgeCount = 0;
    clearIdleTimer();
  });

  pi.on("session_shutdown", async () => {
    clearIdleTimer();
    sessionCtx = null;
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (event.toolName === "write_artifact" || event.toolName === "subagent_done") {
      hasWrittenArtifact = true;
      clearIdleTimer();
    }
  });

  pi.on("tool_execution_start", async () => {
    clearIdleTimer();
  });

  pi.on("agent_start", async () => {
    clearIdleTimer();
  });

  pi.on("turn_end", async () => {
    clearIdleTimer();
  });

  pi.on("message_end", async () => {
    clearIdleTimer();
  });

  pi.on("agent_end", async (_event, ctx) => {
    sessionCtx = ctx;
    startIdleTimer();
  });
}
