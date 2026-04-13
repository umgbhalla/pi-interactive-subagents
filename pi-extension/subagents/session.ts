import { readFileSync, appendFileSync, copyFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface SessionEntry {
  type: string;
  id: string;
  parentId?: string;
  [key: string]: unknown;
}

type MessageRole = "user" | "assistant" | "toolResult";

type MessageContentBlock = {
  type: string;
  text?: string;
  name?: string;
  [key: string]: unknown;
};

export interface MessageEntry extends SessionEntry {
  type: "message";
  message: {
    role: MessageRole;
    content: MessageContentBlock[];
    [key: string]: unknown;
  };
}

const OMIT_FORK_TOOL_RESULTS = new Set([
  "set_tab_title",
  "active_subagents",
  "message_subagent",
  "subagent",
  "agent_group",
  "subagents_list",
  "subagent_resume",
]);
const MAX_FORK_TOOL_RESULT_LINES = 16;
const MAX_FORK_TOOL_RESULT_CHARS = 1200;

function readEntries(sessionFile: string): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as SessionEntry);
}

function truncateText(text: string, maxLines = MAX_FORK_TOOL_RESULT_LINES, maxChars = MAX_FORK_TOOL_RESULT_CHARS): string {
  const lines = text.split("\n").slice(0, maxLines);
  const joined = lines.join("\n");
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined;
}

function extractTextBlocks(content: unknown): MessageContentBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block): block is MessageContentBlock => !!block && typeof block === "object" && block.type === "text" && typeof block.text === "string")
    .map((block) => ({ type: "text", text: block.text }));
}

function summarizeAssistantToolCalls(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const names = [...new Set(
    content
      .filter((block): block is MessageContentBlock => !!block && typeof block === "object" && block.type === "toolCall" && typeof block.name === "string")
      .map((block) => block.name as string)
  )];
  if (names.length === 0) return null;
  return names.length === 1
    ? `[Assistant called tool: ${names[0]}]`
    : `[Assistant called tools: ${names.join(", ")}]`;
}

function sanitizeMessageEntryForFork(entry: SessionEntry): SessionEntry {
  if (entry.type !== "message") return entry;

  const message = (entry as MessageEntry).message;
  const textBlocks = extractTextBlocks(message.content);

  if (message.role === "assistant") {
    // Keep text blocks + stripped toolCall blocks (id & name only, no arguments).
    // Providers require every tool_result to match a tool_use in the preceding
    // assistant message, so we must preserve toolCall stubs.
    const toolCallStubs = Array.isArray(message.content)
      ? message.content
          .filter((block): block is MessageContentBlock => !!block && typeof block === "object" && block.type === "toolCall" && typeof block.id === "string")
          .map((block) => ({ type: "toolCall", id: block.id, name: block.name ?? "tool", arguments: {} }))
      : [];
    const content = [...textBlocks, ...toolCallStubs];
    // If nothing left, add a placeholder so the message isn't empty
    if (content.length === 0) {
      const summary = summarizeAssistantToolCalls(message.content);
      if (summary) content.push({ type: "text", text: summary });
    }
    return {
      ...entry,
      message: {
        role: "assistant",
        content,
        // Preserve fields pi needs for session replay (usage tracking, model info)
        ...(message.usage != null ? { usage: message.usage } : {}),
        ...(message.model != null ? { model: message.model } : {}),
        ...(message.api != null ? { api: message.api } : {}),
        ...(message.provider != null ? { provider: message.provider } : {}),
        ...(message.stopReason != null ? { stopReason: message.stopReason } : {}),
        ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
      },
    };
  }

  if (message.role === "toolResult") {
    const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
    const summary = OMIT_FORK_TOOL_RESULTS.has(toolName)
      ? `[${toolName} output omitted]`
      : textBlocks.length > 0
        ? truncateText(textBlocks.map((block) => block.text).join("\n").trim())
        : `[${toolName} output omitted]`;

    return {
      ...entry,
      message: {
        role: "toolResult",
        toolName,
        isError: Boolean(message.isError),
        content: [{ type: "text", text: summary }],
        // Preserve toolCallId — required by providers (Anthropic: tool_use_id)
        ...(message.toolCallId != null ? { toolCallId: message.toolCallId } : {}),
        ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
      },
    };
  }

  return {
    ...entry,
    message: {
      role: "user",
      content: textBlocks.length > 0 ? textBlocks : [],
      ...(message.timestamp != null ? { timestamp: message.timestamp } : {}),
    },
  };
}

export function writeSanitizedForkSession(sessionFile: string, destFile: string): void {
  const entries = readEntries(sessionFile);
  let truncateAt = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && (entry as MessageEntry).message.role === "user") {
      truncateAt = i;
      break;
    }
  }

  const sanitized = entries.slice(0, truncateAt).map(sanitizeMessageEntryForFork);
  const content = sanitized.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(destFile, content ? `${content}\n` : "", "utf8");
}

/**
 * Return the id of the last entry in the session file (current branch point / leaf).
 */
export function getLeafId(sessionFile: string): string | null {
  const entries = readEntries(sessionFile);
  return entries.length > 0 ? entries[entries.length - 1].id : null;
}

/**
 * Return the number of non-empty lines (entries) in the session file.
 */
export function getEntryCount(sessionFile: string): number {
  const raw = readFileSync(sessionFile, "utf8");
  return raw.split("\n").filter((line) => line.trim()).length;
}

/**
 * Return entries added after `afterLine` (1-indexed count of existing entries).
 */
export function getNewEntries(sessionFile: string, afterLine: number): SessionEntry[] {
  const raw = readFileSync(sessionFile, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());
  return lines.slice(afterLine).map((line) => JSON.parse(line) as SessionEntry);
}

/**
 * Find the last assistant message text in a list of entries.
 */
export function findLastAssistantMessage(entries: SessionEntry[]): string | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const msg = entry as MessageEntry;
    if (msg.message.role !== "assistant") continue;

    const texts = msg.message.content
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string);

    if (texts.length > 0) return texts.join("\n");
  }
  return null;
}

/**
 * Append a branch_summary entry to the session file.
 * Returns the new entry's id.
 */
export function appendBranchSummary(
  sessionFile: string,
  branchPointId: string,
  fromId: string | null,
  summary: string
): string {
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "branch_summary",
    id,
    parentId: branchPointId,
    timestamp: new Date().toISOString(),
    fromId: fromId ?? branchPointId,
    summary,
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Append a plain user text message to an existing session file.
 * Returns the new entry's id.
 */
export function appendUserTextMessage(sessionFile: string, text: string): string {
  const parentId = getLeafId(sessionFile);
  const id = randomBytes(4).toString("hex");
  const entry = {
    type: "message",
    id,
    parentId,
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
  };
  appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
  return id;
}

/**
 * Copy the session file to destDir for parallel worker isolation.
 * Returns the path of the copy.
 */
export function copySessionFile(sessionFile: string, destDir: string): string {
  const id = randomBytes(4).toString("hex");
  const dest = join(destDir, `subagent-${id}.jsonl`);
  copyFileSync(sessionFile, dest);
  return dest;
}

/**
 * Read new entries from sourceFile (after afterLine), append them to targetFile.
 * Returns the appended entries.
 */
export function mergeNewEntries(
  sourceFile: string,
  targetFile: string,
  afterLine: number
): SessionEntry[] {
  const entries = getNewEntries(sourceFile, afterLine);
  for (const entry of entries) {
    appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
  }
  return entries;
}
