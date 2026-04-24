const BUILTIN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

/**
 * When a child session is launched with an explicit --tools list, pi core treats
 * that as the full active tool set and does not auto-add extension tools.
 * Preserve the required lifecycle tools so autonomous subagents can always
 * write artifacts and terminate cleanly.
 */
const REQUIRED_SUBAGENT_TOOLS = ["write_artifact", "read_artifact", "subagent_done"] as const;

export function buildSubagentToolArg(effectiveTools?: string): string | undefined {
  if (!effectiveTools) return undefined;

  const selected: string[] = [];
  const seen = new Set<string>();

  for (const tool of effectiveTools.split(",").map((t) => t.trim()).filter(Boolean)) {
    if (!BUILTIN_TOOLS.has(tool) || seen.has(tool)) continue;
    selected.push(tool);
    seen.add(tool);
  }

  for (const tool of REQUIRED_SUBAGENT_TOOLS) {
    if (seen.has(tool)) continue;
    selected.push(tool);
    seen.add(tool);
  }

  return selected.length > 0 ? selected.join(",") : undefined;
}
