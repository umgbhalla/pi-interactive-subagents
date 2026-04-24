/**
 * Extension loaded into sub-agents (child pi processes spawned by mapreduce).
 *
 * Responsibilities:
 *  - Render a small widget above the editor showing agent identity + tool set
 *    (toggle with Ctrl+J).
 *  - Register `subagent_done` for the child to signal completion. Calling it
 *    *hard-exits* the child process so the agent loop cannot take another turn
 *    and cannot respond to the tool result.
 *  - If the child ends a turn without calling `subagent_done`, inject a
 *    follow-up user message reminding it to. Gives up after MAX_ENFORCEMENT.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import * as lineage from "./lineage.ts";

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const lineageId = process.env.PI_SUBAGENT_LINEAGE_ID || undefined;

  // ── Completion enforcement state ──
  let hasCalledWriteArtifact = false;
  let hasCalledSubagentDone = false;
  let isAutonomous = false;
  let enforcementCount = 0;
  const MAX_ENFORCEMENT = 3;

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label
          ? theme.bold(theme.fg("accent", `[${label}]`))
          : "";

        if (expanded) {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo = denied.length > 0
            ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`)
            : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const isSubagent = !!(process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_AGENT);
    const interactiveFlag = process.env.PI_SUBAGENT_INTERACTIVE;
    isAutonomous = isSubagent && interactiveFlag !== "1";

    hasCalledWriteArtifact = false;
    hasCalledSubagentDone = false;
    enforcementCount = 0;

    renderWidget(ctx, null);
  });

  pi.on("tool_execution_end", async (event, _ctx) => {
    if (event.toolName === "write_artifact") hasCalledWriteArtifact = true;
    if (event.toolName === "subagent_done") hasCalledSubagentDone = true;
  });

  // If the model stops its turn without calling subagent_done, nudge it.
  // Once subagent_done runs, the process exits before this ever fires.
  pi.on("agent_end", async (_event, _ctx) => {
    if (!isAutonomous) return;
    if (hasCalledSubagentDone) return;
    if (enforcementCount >= MAX_ENFORCEMENT) return;

    enforcementCount++;

    const missing: string[] = [];
    if (!hasCalledWriteArtifact) missing.push("`write_artifact` with your findings/results");
    if (!hasCalledSubagentDone) missing.push("`subagent_done` to close this session");
    if (missing.length === 0) return;

    const msg = [
      `[SYSTEM] You stopped without completing your shutdown sequence.`,
      `You MUST call: ${missing.join(" and ")}.`,
      ``,
      `Do it now. Do not explain, do not apologize — just make the calls.`,
      enforcementCount >= MAX_ENFORCEMENT - 1
        ? `This is your final warning. Next failure will force-terminate this session.`
        : ``,
    ].filter(Boolean).join("\n");

    pi.sendUserMessage(msg, { deliverAs: "followUp" });
  });

  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Call this tool when you have completed your task. " +
      "It closes this subagent session immediately — the agent loop will NOT take another turn after this call. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      hasCalledSubagentDone = true;

      // Mark lineage row finished so the parent's view of the tree stays honest.
      try { lineage.markFinished(lineageId); } catch { /* best-effort */ }

      // Flush session state, then hard-exit. `process.exit(0)` returns `never`
      // so the agent loop never sees a tool result and cannot continue.
      try { ctx.shutdown(); } catch { /* best-effort */ }
      process.exit(0);
    },
  });
}
