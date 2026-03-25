/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 * - Enforces that autonomous subagents call write_artifact and subagent_done
 *   before their session can end. On agent_end, if these haven't been called,
 *   a follow-up turn is injected automatically — no idle polling, no nudges.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";

  // ── Completion enforcement state ──
  let hasCalledWriteArtifact = false;
  let hasCalledSubagentDone = false;
  let isAutonomous = false;
  let enforcementCount = 0;
  const MAX_ENFORCEMENT = 3;

  function renderWidget(ctx: { ui: { setWidget: Function } }, theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label
          ? theme.bold(theme.fg("accent", `[${label}]`))
          : "";

        if (expanded) {
          // Expanded: full tool list + denied
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
          // Collapsed: one-line summary
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

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = (process.env.PI_DENY_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Detect autonomous subagent: has PI_SUBAGENT_AGENT set (spawned by parent)
    // and NOT interactive (no PI_SUBAGENT_INTERACTIVE or explicitly "0")
    const isSubagent = !!(process.env.PI_SUBAGENT_NAME || process.env.PI_SUBAGENT_AGENT);
    const interactiveFlag = process.env.PI_SUBAGENT_INTERACTIVE;
    isAutonomous = isSubagent && interactiveFlag !== "1";

    hasCalledWriteArtifact = false;
    hasCalledSubagentDone = false;
    enforcementCount = 0;

    renderWidget(ctx, null);
  });

  // Track tool calls
  pi.on("tool_execution_end", async (event, _ctx) => {
    if (event.toolName === "write_artifact") {
      hasCalledWriteArtifact = true;
    }
    if (event.toolName === "subagent_done") {
      hasCalledSubagentDone = true;
    }
  });

  // ── Completion enforcement ──
  // When the agent finishes a turn (agent_end = model stopped generating),
  // check if it called write_artifact + subagent_done. If not, inject a
  // follow-up turn that forces it to complete properly.
  pi.on("agent_end", async (_event, _ctx) => {
    if (!isAutonomous) return;
    if (hasCalledSubagentDone) return; // already done
    if (enforcementCount >= MAX_ENFORCEMENT) return; // give up after N tries

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

  // Toggle expand/collapse with Ctrl+J
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
      "It will close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      hasCalledSubagentDone = true;
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
