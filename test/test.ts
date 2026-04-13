import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getLeafId,
  getEntryCount,
  getNewEntries,
  findLastAssistantMessage,
  appendBranchSummary,
  appendUserTextMessage,
  copySessionFile,
  mergeNewEntries,
  writeSanitizedForkSession,
} from "../pi-extension/subagents/session.ts";

import { shellEscape, isCmuxAvailable } from "../pi-extension/subagents/cmux.ts";
import {
  modelMatchesHintFamily,
  normalizeModelHint,
  resolveHintedModel,
} from "../pi-extension/subagents/model-hints.ts";
import {
  buildSubagentTaskArtifactPath,
  writeSubagentTaskArtifact,
} from "../pi-extension/subagents/task-artifact.ts";

// --- Helpers ---

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "subagents-test-"));
}

function createSessionFile(dir: string, entries: object[]): string {
  const file = join(dir, "test-session.jsonl");
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  writeFileSync(file, content);
  return file;
}

const SESSION_HEADER = { type: "session", id: "sess-001", version: 3 };
const MODEL_CHANGE = { type: "model_change", id: "mc-001", parentId: null };
const USER_MSG = {
  type: "message",
  id: "user-001",
  parentId: "mc-001",
  message: {
    role: "user",
    content: [{ type: "text", text: "Hello, plan something" }],
  },
};
const ASSISTANT_MSG = {
  type: "message",
  id: "asst-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "Here is my plan..." }],
  },
};
const ASSISTANT_MSG_2 = {
  type: "message",
  id: "asst-002",
  parentId: "asst-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think..." },
      { type: "text", text: "Updated plan with details." },
    ],
  },
};
const TOOL_RESULT = {
  type: "message",
  id: "tool-001",
  parentId: "asst-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-001",
    toolName: "bash",
    content: [{ type: "text", text: "output here" }],
  },
};
const ASSISTANT_TOOL_ONLY = {
  type: "message",
  id: "asst-tool-001",
  parentId: "user-001",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "Let me think...", thinkingSignature: "abc123" },
      { type: "toolCall", id: "toolu_1", name: "active_subagents", arguments: { screenLines: 50 } },
    ],
  },
};
const NOISY_TOOL_RESULT = {
  type: "message",
  id: "tool-noisy-001",
  parentId: "asst-tool-001",
  message: {
    role: "toolResult",
    toolCallId: "tc-002",
    toolName: "active_subagents",
    content: [{ type: "text", text: "very noisy active subagent payload" }],
    details: { agents: [{ screen: "raw terminal dump" }] },
  },
};
const FINAL_META_USER = {
  type: "message",
  id: "user-meta-001",
  parentId: "asst-002",
  message: {
    role: "user",
    content: [{ type: "text", text: "Spawn a subagent for this task" }],
  },
};

// --- Tests ---

describe("session.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("getLeafId", () => {
    it("returns last entry id", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      assert.equal(getLeafId(file), "asst-001");
    });

    it("returns null for empty file", () => {
      const file = join(dir, "empty.jsonl");
      writeFileSync(file, "");
      assert.equal(getLeafId(file), null);
    });
  });

  describe("getEntryCount", () => {
    it("counts non-empty lines", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG]);
      assert.equal(getEntryCount(file), 3);
    });

    it("returns 0 for empty file", () => {
      const file = join(dir, "empty2.jsonl");
      writeFileSync(file, "\n\n");
      assert.equal(getEntryCount(file), 0);
    });
  });

  describe("getNewEntries", () => {
    it("returns entries after a given line", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 2);
      assert.equal(entries[0].id, "user-001");
      assert.equal(entries[1].id, "asst-001");
    });

    it("returns empty array when no new entries", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE]);
      const entries = getNewEntries(file, 2);
      assert.equal(entries.length, 0);
    });
  });

  describe("findLastAssistantMessage", () => {
    it("finds last assistant text", () => {
      const entries = [USER_MSG, ASSISTANT_MSG, ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips thinking blocks, gets text only", () => {
      const entries = [ASSISTANT_MSG_2] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Updated plan with details.");
    });

    it("skips tool results", () => {
      const entries = [ASSISTANT_MSG, TOOL_RESULT] as any[];
      const text = findLastAssistantMessage(entries);
      assert.equal(text, "Here is my plan...");
    });

    it("returns null when no assistant messages", () => {
      const entries = [USER_MSG] as any[];
      assert.equal(findLastAssistantMessage(entries), null);
    });

    it("returns null for empty array", () => {
      assert.equal(findLastAssistantMessage([]), null);
    });
  });

  describe("appendBranchSummary", () => {
    it("appends valid branch_summary entry", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG]);
      const id = appendBranchSummary(file, "user-001", "asst-001", "The plan was created.");

      assert.ok(id, "should return an id");
      assert.equal(typeof id, "string");

      // Read back and verify
      const lines = readFileSync(file, "utf8").trim().split("\n");
      assert.equal(lines.length, 4); // 3 original + 1 summary

      const summary = JSON.parse(lines[3]);
      assert.equal(summary.type, "branch_summary");
      assert.equal(summary.id, id);
      assert.equal(summary.parentId, "user-001");
      assert.equal(summary.fromId, "asst-001");
      assert.equal(summary.summary, "The plan was created.");
      assert.ok(summary.timestamp);
    });

    it("uses branchPointId as fromId fallback", () => {
      const file = createSessionFile(dir, [SESSION_HEADER]);
      appendBranchSummary(file, "branch-pt", null, "summary");

      const lines = readFileSync(file, "utf8").trim().split("\n");
      const summary = JSON.parse(lines[1]);
      assert.equal(summary.fromId, "branch-pt");
    });
  });

  describe("appendUserTextMessage", () => {
    it("appends a plain user text turn to the current leaf", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, MODEL_CHANGE, USER_MSG, ASSISTANT_MSG]);
      const id = appendUserTextMessage(file, "fork task here");
      const entries = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const appended = entries.at(-1);
      assert.equal(appended.id, id);
      assert.equal(appended.parentId, "asst-001");
      assert.equal(appended.message.role, "user");
      assert.deepEqual(appended.message.content, [{ type: "text", text: "fork task here" }]);
    });
  });

  describe("copySessionFile", () => {
    it("creates a copy with different path", () => {
      const file = createSessionFile(dir, [SESSION_HEADER, USER_MSG]);
      const copyDir = join(dir, "copies");
      mkdirSync(copyDir, { recursive: true });
      const copy = copySessionFile(file, copyDir);

      assert.notEqual(copy, file);
      assert.ok(copy.endsWith(".jsonl"));
      assert.equal(readFileSync(copy, "utf8"), readFileSync(file, "utf8"));
    });
  });

  describe("mergeNewEntries", () => {
    it("appends new entries from source to target", () => {
      // Source starts with same base (2 entries), then has 1 new entry
      const sourceFile = join(dir, "merge-source.jsonl");
      const targetFile = join(dir, "merge-target.jsonl");
      writeFileSync(sourceFile, [SESSION_HEADER, USER_MSG, ASSISTANT_MSG].map(e => JSON.stringify(e)).join("\n") + "\n");
      writeFileSync(targetFile, [SESSION_HEADER, USER_MSG].map(e => JSON.stringify(e)).join("\n") + "\n");

      // Merge entries after line 2 (the shared base)
      const merged = mergeNewEntries(sourceFile, targetFile, 2);
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, "asst-001");

      // Target should now have 3 entries
      const targetLines = readFileSync(targetFile, "utf8").trim().split("\n");
      assert.equal(targetLines.length, 3);
    });
  });

  describe("writeSanitizedForkSession", () => {
    it("drops the triggering user message and strips noisy assistant/tool payloads", () => {
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        USER_MSG,
        ASSISTANT_TOOL_ONLY,
        NOISY_TOOL_RESULT,
        ASSISTANT_MSG_2,
        FINAL_META_USER,
      ]);
      const out = join(dir, "fork-sanitized.jsonl");

      writeSanitizedForkSession(file, out);

      const entries = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(entries.length, 5);
      assert.equal(entries.at(-1)?.id, "asst-002");

      const assistantTool = entries[2];
      assert.deepEqual(assistantTool.message.content, [{
        type: "toolCall",
        id: "toolu_1",
        name: "active_subagents",
        arguments: {},
      }]);

      const noisyTool = entries[3];
      assert.equal(noisyTool.message.toolName, "active_subagents");
      assert.equal(noisyTool.message.content[0].text, "[active_subagents output omitted]");
      assert.equal(noisyTool.message.details, undefined);

      const assistantText = entries[4];
      assert.deepEqual(assistantText.message.content, [{ type: "text", text: "Updated plan with details." }]);
    });

    it("keeps regular tool output but truncates and removes extra metadata", () => {
      const longOutput = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
      const file = createSessionFile(dir, [
        SESSION_HEADER,
        USER_MSG,
        {
          type: "message",
          id: "tool-long-001",
          parentId: "user-001",
          message: {
            role: "toolResult",
            toolCallId: "tc-long",
            toolName: "bash",
            content: [{ type: "text", text: longOutput }],
            details: { raw: true },
            timestamp: 123,
          },
        },
        FINAL_META_USER,
      ]);
      const out = join(dir, "fork-sanitized-long.jsonl");

      writeSanitizedForkSession(file, out);

      const entries = readFileSync(out, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const tool = entries[2];
      assert.equal(tool.message.toolName, "bash");
      assert.equal(tool.message.details, undefined);
      assert.equal(tool.message.toolCallId, "tc-long");
      assert.equal(tool.message.timestamp, 123);
      assert.match(tool.message.content[0].text, /^line 0/);
      assert.ok(!tool.message.content[0].text.includes("line 39"));
    });
  });
});

describe("model-hints.ts", () => {
  describe("normalizeModelHint", () => {
    it("normalizes frontend aliases", () => {
      assert.equal(normalizeModelHint("frontend"), "frontend");
      assert.equal(normalizeModelHint("UI"), "frontend");
      assert.equal(normalizeModelHint("design"), "frontend");
    });

    it("normalizes non-frontend aliases", () => {
      assert.equal(normalizeModelHint("non-frontend"), "non-frontend");
      assert.equal(normalizeModelHint("backend"), "non-frontend");
      assert.equal(normalizeModelHint("coding"), "non-frontend");
    });

    it("returns undefined for unknown hints", () => {
      assert.equal(normalizeModelHint("mobile"), undefined);
    });
  });

  describe("modelMatchesHintFamily", () => {
    it("matches anthropic models for frontend work", () => {
      assert.equal(modelMatchesHintFamily("anthropic/claude-sonnet-4-6", "frontend"), true);
      assert.equal(modelMatchesHintFamily("openai-codex/gpt-5.4", "frontend"), false);
    });

    it("matches codex/gpt models for non-frontend work", () => {
      assert.equal(modelMatchesHintFamily("openai-codex/gpt-5.4", "non-frontend"), true);
      assert.equal(modelMatchesHintFamily("anthropic/claude-opus-4-6", "non-frontend"), false);
    });
  });

  describe("resolveHintedModel", () => {
    it("keeps explicit model overrides", () => {
      const resolved = resolveHintedModel({
        explicitModel: "anthropic/claude-opus-4-6",
        modelHint: "non-frontend",
        agentDefaults: { model: "openai-codex/gpt-5.4" },
      });
      assert.deepEqual(resolved, {
        model: "anthropic/claude-opus-4-6",
        modelHint: "non-frontend",
      });
    });

    it("uses hint-specific agent overrides first", () => {
      const resolved = resolveHintedModel({
        modelHint: "frontend",
        agentDefaults: {
          model: "openai-codex/gpt-5.4",
          frontendModel: "anthropic/claude-opus-4-6",
        },
      });
      assert.deepEqual(resolved, {
        model: "anthropic/claude-opus-4-6",
        modelHint: "frontend",
      });
    });

    it("reuses agent default when it already matches the hinted family", () => {
      const resolved = resolveHintedModel({
        modelHint: "non-frontend",
        agentDefaults: { model: "openai-codex/gpt-5.3-codex" },
      });
      assert.deepEqual(resolved, {
        model: "openai-codex/gpt-5.3-codex",
        modelHint: "non-frontend",
      });
    });

    it("falls back to package defaults when the agent default is the wrong family", () => {
      const resolved = resolveHintedModel({
        modelHint: "non-frontend",
        agentDefaults: { model: "anthropic/claude-opus-4-6" },
      });
      assert.deepEqual(resolved, {
        model: "openai-codex/gpt-5.4",
        modelHint: "non-frontend",
      });
    });
  });
});

describe("task-artifact.ts", () => {
  let dir: string;

  before(() => {
    dir = createTestDir();
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds sanitized markdown artifact paths", () => {
    const path = buildSubagentTaskArtifactPath(dir, "Fork: provider-inventory", new Date("2026-04-13T07:34:28.680Z"));
    assert.equal(path, join(dir, "context/fork-provider-inventory-2026-04-13T07-34-28.md"));
  });

  it("writes task content to a file-backed prompt artifact", () => {
    const path = writeSubagentTaskArtifact(dir, "Fork: provider-inventory", "very long prompt", new Date("2026-04-13T07:34:28.680Z"));
    assert.equal(readFileSync(path, "utf8"), "very long prompt");
    assert.equal(path, join(dir, "context/fork-provider-inventory-2026-04-13T07-34-28.md"));
  });
});

describe("cmux.ts", () => {
  describe("shellEscape", () => {
    it("wraps in single quotes", () => {
      assert.equal(shellEscape("hello"), "'hello'");
    });

    it("escapes single quotes", () => {
      assert.equal(shellEscape("it's"), "'it'\\''s'");
    });

    it("handles empty string", () => {
      assert.equal(shellEscape(""), "''");
    });

    it("handles special characters", () => {
      const input = 'echo "hello $world" && rm -rf /';
      const escaped = shellEscape(input);
      assert.ok(escaped.startsWith("'"));
      assert.ok(escaped.endsWith("'"));
      // Inside single quotes, everything is literal
      assert.ok(escaped.includes("$world"));
    });
  });

  describe("isCmuxAvailable", () => {
    it("returns boolean based on CMUX_SOCKET_PATH", () => {
      // Can't easily mock env in node:test, just verify it returns a boolean
      const result = isCmuxAvailable();
      assert.equal(typeof result, "boolean");
    });
  });

});
