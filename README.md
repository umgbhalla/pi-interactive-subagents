# pi-interactive-subagents

Map-reduced session forking for [pi](https://github.com/badlogic/pi-mono). A main pi session can fork itself into 1..8 parallel tracks, wait for all tracks to finish, and receive one combined result.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## Table of Contents

- [Overview](#overview)
- [How mapreduce works](#how-mapreduce-works)
- [Architecture](#architecture)
- [Install](#install)
- [Tool reference](#tool-reference)
- [Depth and recursive fan-out](#depth-and-recursive-fan-out)
- [Session forking and context propagation](#session-forking-and-context-propagation)
- [Completion and result aggregation](#completion-and-result-aggregation)
- [Model hints](#model-hints)
- [Session artifacts](#session-artifacts)
- [Status widgets and mux integration](#status-widgets-and-mux-integration)
- [Legacy agent definitions](#legacy-agent-definitions)
- [Testing](#testing)
- [Requirements](#requirements)
- [License](#license)

---

## Overview

`pi-interactive-subagents` is now centered on a single orchestration primitive: `mapreduce`.

The old model was "spawn subagents and let results steer back later." The current model is stricter and easier to reason about: fork the current session into named tracks, run them concurrently, block the caller until every track exits, then return the combined summaries in track order.

```
   OLD ASYNC MODEL                  CURRENT MAPREDUCE MODEL
   ───────────────                  ───────────────────────
   start agents ─▶ return           call mapreduce ─▶ fork tracks
   agent works  ─▶ steer later      tracks run      ─▶ wait together
   main keeps chatting              reduce results  ─▶ one response
   state arrives out-of-band        caller resumes  ─▶ integrated context
```

The important shift: `mapreduce` is a structured fork/join operation, not a background notification system.

Primary behavior:

- **Context-preserving forks** — every track starts from a sanitized copy of the current session.
- **Parallel tracks** — 1..8 child pi processes run in separate mux panes.
- **Blocking reduce** — the tool call does not finish until every track has completed or failed.
- **Ordered aggregation** — the result contains one section per input track, in input order.
- **Controlled recursion** — per-track `depth` controls whether child tracks may call `mapreduce` again.
- **Shared workspace warning** — tracks do not get isolated git branches or worktrees; they share the same repository checkout.

---

## How mapreduce works

At call time, `mapreduce` takes named tracks. Each track receives the full prior conversation plus its own prompt.

```typescript
mapreduce({
  tracks: [
    {
      name: "auth scout",
      prompt: "Map the auth flow and identify risky files. Do not edit.",
    },
    {
      name: "test scout",
      prompt: "Find the fastest relevant tests for this change. Do not edit.",
    },
    {
      name: "reviewer",
      prompt: "Review the current diff for correctness issues. Do not edit.",
    },
  ],
  modelHint: "reasoning",
})
```

The operation is a fork/join pipeline:

```
   parent session ──▶ sanitize fork ──▶ launch panes ──▶ watch exits ──▶ reduce summaries
                            │                │               │                 │
                            ▼                ▼               ▼                 ▼
                     child JSONL       pi child procs    sentinels       combined result
```

One tool call owns the whole fan-out and fan-in.

Inside the terminal, running tracks appear in a live widget:

```
╭─ mapreduce ───────────────────────────── 3 running ─╮
│ 00:23  Fork: auth scout                      8 msgs │
│ 00:45  Fork: test scout                    12 msgs  │
│ 00:12  Fork: reviewer                     starting… │
╰─────────────────────────────────────────────────────╯
```

Progress updates are streamed while the tool is running, then a final combined result is returned.

---

## Architecture

The package registers three pi extensions:

| Extension | File | Purpose |
|-----------|------|---------|
| Subagents | `pi-extension/subagents/index.ts` | Registers `mapreduce`, launches child sessions, watches exits, aggregates results, enforces depth. |
| Session artifacts | `pi-extension/session-artifacts/index.ts` | Provides `write_artifact` and `read_artifact` for session-scoped notes and reports. |
| cmux status | `pi-extension/cmux-status/index.ts` | Pushes pi status into cmux when cmux is active. |

The core system is layered like this:

```
   ┌ parent pi session ─────────────────────────────────────────┐
   │ mapreduce tool                                             │
   │ runMapReduce() launch/watch/reduce orchestrator            │
   │ lineage ledger (~/.pi/subagents/lineage.db)                │
   │ mux abstraction (Supaterm / cmux / zellij / screen)        │
   │ child pi sessions + subagent_done lifecycle extension      │
   └────────────────────────────────────────────────────────────┘
```

User-facing control stays at the top; process management and depth enforcement sit below it.

A single mapreduce call fans out through the mux layer and returns through the reducer:

```
                         ┌──▶ track A pane ──▶ subagent_done ──┐
   parent ──▶ mapreduce ─┼──▶ track B pane ──▶ subagent_done ──┼──▶ combined result
                         └──▶ track C pane ──▶ subagent_done ──┘
```

Every branch is independent while running; the parent only continues after the join.

---

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Start pi inside a supported multiplexer:

```bash
sp tab new pi          # Supaterm
cmux pi               # cmux
zellij --session pi   # then run: pi
```

Supported backends, in detection order:

1. **Supaterm** — via the `sp` CLI (`SUPATERM_SOCKET_PATH`)
2. **cmux** — via the `cmux` CLI (`CMUX_SOCKET_PATH`)
3. **zellij** — via the `zellij` CLI (`ZELLIJ` or `ZELLIJ_SESSION_NAME`)
4. **screen** — fallback PTY backend
5. **compat** — last-resort child-process backend; useful for simple commands, not recommended for real pi child sessions

Override backend detection with:

```bash
export PI_SUBAGENT_MUX=supaterm   # or cmux, zellij, screen, compat
```

---

## Tool reference

### `mapreduce`

Fork the current session into parallel tracks and return one combined result.

```typescript
mapreduce({
  tracks: [
    { name: "track label", prompt: "Track-specific task", depth: 0 },
  ],
  model: "anthropic/claude-sonnet-4-7",
  modelHint: "frontend",
})
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `tracks` | array | required | 1..8 parallel forks to run. |
| `tracks[].name` | string | required | Short label used in panes, widgets, and result headers. |
| `tracks[].prompt` | string | required | Track-specific instruction. The track also inherits the parent conversation context. |
| `tracks[].depth` | integer | `0` | How many more mapreduce levels this child may use. Clamped by the parent budget and hard-capped at 10. |
| `model` | string | parent/default | Model override for all tracks. |
| `modelHint` | `"frontend"` \| `"non-frontend"` \| `"fast"` \| `"reasoning"` | — | Model-family hint for all tracks. Ignored for selection when `model` is set, but still normalized in details. |

Useful patterns:

```typescript
// Reconnaissance fan-out: read-only tracks, no recursive spawning.
mapreduce({
  tracks: [
    { name: "frontend", prompt: "Inspect the UI surface and report relevant files. Do not edit." },
    { name: "backend", prompt: "Inspect API/data flow and report relevant files. Do not edit." },
    { name: "tests", prompt: "Find relevant tests and verification commands. Do not edit." },
  ],
  modelHint: "fast",
})

// Implementation split: safe only when tracks touch partitioned files.
mapreduce({
  tracks: [
    { name: "api", prompt: "Implement only the API changes in src/api/." },
    { name: "ui", prompt: "Implement only the UI changes in src/app/." },
  ],
  modelHint: "frontend",
})

// Recursive research: each top-level track may fan out one more level.
mapreduce({
  tracks: [
    { name: "security", prompt: "Audit auth/security. Split further only if useful.", depth: 1 },
    { name: "performance", prompt: "Audit performance hotspots. Split further only if useful.", depth: 1 },
  ],
  modelHint: "reasoning",
})
```

### `write_artifact` and `read_artifact`

Child sessions can write structured deliverables without dirtying the repository:

```typescript
write_artifact({
  name: "context/auth.md",
  content: "# Auth context\n...",
})

read_artifact({ name: "context/auth.md" })
```

Artifacts are stored under:

```text
~/.pi/history/<project>/artifacts/<session-id>/
```

---

## Depth and recursive fan-out

`depth` is the guardrail that prevents uncontrolled agent trees.

```
   parent call
      │
      ├──▶ track A  depth=0  ──▶ no mapreduce tool visible
      │
      └──▶ track B  depth=2  ──▶ may call mapreduce
                │
                └──▶ child track depth≤1 ──▶ may call mapreduce at most once more
```

Depth is a capability budget, not a suggestion.

Enforcement happens in two places:

- **Registration time** — if a child has no remaining depth, the `mapreduce` tool is not registered for that child.
- **Execution time** — the live depth is re-read before spawning, so stale sessions cannot exceed their budget.

The lineage ledger stores one row per root/child session in SQLite:

```text
~/.pi/subagents/lineage.db
```

Depth rules:

| Session | Rule |
|---------|------|
| Root session | Treated as unlimited for top-level calls. |
| Child session | Uses the lower of `PI_SUBAGENT_DEPTH_REMAINING` and its lineage DB row. |
| Grandchild | Receives `min(requested_depth, parent_remaining - 1, 10)`. |
| Exhausted child | Does not see `mapreduce`. |

---

## Session forking and context propagation

Every track starts from a sanitized copy of the parent session file.

```
   parent JSONL ──▶ sanitizer ──▶ child JSONL ──▶ track prompt appended ──▶ pi child
        │              │              │                    │
        │              │              │                    └─ track-specific task
        │              │              └─ replayable conversation context
        │              └─ trims noisy or unsafe context
        └─ current session state
```

The sanitizer keeps enough history for the child to understand the conversation while dropping noise.

| Input | Fork behavior |
|-------|---------------|
| Last triggering user message | Dropped, so the child does not see the meta-request that spawned it. |
| Assistant text | Preserved. |
| Assistant tool calls | Preserved as stubs with IDs and names, but empty arguments. |
| Tool results from `mapreduce` and legacy spawning tools | Replaced with `[tool output omitted]`. |
| Other tool results | Truncated to 16 lines / 1200 chars. |
| Thinking/signature blocks | Removed. |
| Session replay metadata | Preserved where needed. |

The forked child then receives a normal user turn containing:

1. continuation instruction,
2. completion requirements,
3. the track prompt,
4. summary instructions.

---

## Completion and result aggregation

Each child session loads `pi-extension/subagents/subagent-done.ts`. That extension registers `subagent_done`, tracks whether the child wrote artifacts, and hard-exits the child process when done.

```
   child works ──▶ final assistant summary ──▶ subagent_done ──▶ process exits ──▶ sentinel
```

The final assistant message before `subagent_done` becomes the summary returned to the parent.

Exit detection is intentionally simple. The launched shell command ends with a sentinel:

```bash
echo '__SUBAGENT_DONE_'$?'__'
```

The parent polls each pane for that sentinel, then reads the child session file and extracts the last assistant message.

Failure handling is per track:

```
   launch/watch outcome ──┬──▶ exit 0      : successful section
                          ├──▶ exit nonzero: failed section
                          ├──▶ launch error: synthetic failed section
                          └──▶ watcher err : synthetic failed section
```

One failed track does not erase sibling results; the reducer still returns all sections.

---

## Model hints

Model hints steer all tracks toward a model family without hardcoding a concrete model ID.

```typescript
// Frontend or visual work → Claude/Sonnet family.
mapreduce({ tracks, modelHint: "frontend" })

// Backend/general coding → GPT-5.5 family.
mapreduce({ tracks, modelHint: "non-frontend" })

// Cheap/quick work → GPT-5.4 Mini family.
mapreduce({ tracks, modelHint: "fast" })

// Hard reasoning → GPT-5.5 or strongest reasoning family.
mapreduce({ tracks, modelHint: "reasoning" })
```

Resolution order:

1. **Explicit `model`** wins.
2. **Agent/frontmatter defaults** may supply hint-specific overrides when a child is launched with an agent profile.
3. **Agent default model** is reused if it already matches the hinted family.
4. **Package defaults** are used otherwise:
   - `frontend` → `anthropic/claude-sonnet-4-7`
   - `non-frontend` → `openai-codex/gpt-5.5`
   - `fast` → `openai-codex/gpt-5.4-mini`
   - `reasoning` → `openai-codex/gpt-5.5`

Accepted aliases include:

| Canonical hint | Example aliases |
|----------------|-----------------|
| `frontend` | `ui`, `ux`, `design`, `visual`, `web`, `mobile` |
| `non-frontend` | `backend`, `general`, `code`, `api`, `server`, `infra`, `cli` |
| `fast` | `quick`, `cheap`, `mini`, `small`, `haiku` |
| `reasoning` | `deep`, `hard`, `complex`, `smart`, `strong`, `opus` |

---

## Session artifacts

Artifacts are the preferred way for tracks to leave structured outputs larger than their final summary.

```
   track final summary ──▶ short result in mapreduce response
   write_artifact      ──▶ durable notes under ~/.pi/history/...
```

Example artifact layout:

```text
~/.pi/history/<project>/artifacts/<session-id>/
├── context/
│   ├── auth.md
│   └── tests.md
├── plans/
│   └── implementation.md
└── reviews/
    └── diff-review.md
```

Use artifacts for plans, reconnaissance, audit notes, and review reports. Use the final assistant summary for the concise result the parent should read immediately.

---

## Status widgets and mux integration

### Parent mapreduce widget

The parent session shows active mapreduce tracks above the editor:

```
╭─ mapreduce ───────────────────────────── 2 running ─╮
│ 01:23  Fork: API d=1                  15 msgs (12KB) │
│ 00:45  Fork: UI                         8 msgs (6KB) │
╰──────────────────────────────────────────────────────╯
```

The widget disappears when all tracks finish.

### Child tools widget

Each child session shows its tool set. Toggle with `Ctrl+J`:

```
[Fork: API] — 18 tools · 1 denied  (Ctrl+J to expand)
```

Expanded view shows available tools and denied tools.

### cmux sidebar status

When running inside cmux, the status extension pushes pi state to the cmux sidebar:

```text
pi_state     Idle / Working
pi_model     active model
pi_thinking  thinking level
pi_tokens    token count
pi_cost      session cost
pi_tool      active tool name
```

These updates are best-effort and never block pi.

---

## Legacy agent definitions

The repository still includes bundled prompt profiles in `agents/`:

| Agent | Default model | Role |
|-------|---------------|------|
| `scout` | `anthropic/claude-haiku-4-5` | Fast read-only codebase reconnaissance. |
| `worker` | `anthropic/claude-sonnet-4-7` | Focused implementation. |
| `planner` | `anthropic/claude-opus-4-7` | Planning and todo creation. |
| `reviewer` | `anthropic/claude-opus-4-7` | Code review. |
| `visual-tester` | `anthropic/claude-sonnet-4-7` | Visual QA with Chrome CDP. |

These files are retained as reusable role definitions and for compatibility with older session history. The current public orchestration API is `mapreduce`, not the older `agent_group`, `subagent`, `branch`, `/plan`, or `/iterate` interface.

If you need role specialization today, encode it in each track prompt or use `model`/`modelHint` for all tracks in the call.

---

## Testing

Run the test suite:

```bash
node --test test/test.ts
```

Covered areas:

- `session.ts` — session entry reading, truncation, fork sanitization, assistant-summary extraction, branch helpers.
- `model-hints.ts` — hint normalization, family matching, model resolution.
- `tool-selection.ts` — child tool-list construction and lifecycle-tool preservation.
- `orchestrate.ts` — ordered results, per-track launch failures, watcher failures, abort propagation.
- `cmux.ts` — shell escaping and mux backend helpers where testable.

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono)
- Node.js with `node:sqlite` support for lineage tracking
- One practical mux backend:
  - [Supaterm](https://supaterm.com) preferred
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [zellij](https://zellij.dev)
  - GNU screen fallback

Recommended startup:

```bash
sp tab new pi
```

Backend override:

```bash
export PI_SUBAGENT_MUX=supaterm
```

---

## License

MIT
