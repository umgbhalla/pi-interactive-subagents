# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.




https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f




## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with elapsed time and progress. When a sub-agent finishes, its result is **steered back** into the main session as an async notification — triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)    8 msgs (5.1KB)   │
│ 00:45  Scout: DB (scout)     12 msgs (9.3KB)   │
╰─────────────────────────────────────────────────╯
```

For parallel execution, you can still call `subagent` multiple times — they all run concurrently — or use `agent_group` to get one grouped result when the whole batch finishes:

```typescript
agent_group({
  name: "Scouting",
  agents: [
    { name: "Scout: Auth", agent: "scout", task: "Analyze auth module" },
    { name: "Scout: DB", agent: "scout", task: "Map database schema" },
  ],
})
// Returns immediately, then steers back one grouped result when both finish
```

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Supported multiplexers:
- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)

Start pi inside one of them:

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
```

Optional environment variables:
- `PI_SUBAGENT_MUX=cmux|tmux|zellij` — force a specific backend

On cmux, subagents open in background tabs by default.

## What's Included

### Extensions

**Subagents** — tools + 3 commands:

| Tool | Level | Description |
|------|-------|-------------|
| `agent_group` | main | Spawn a batch of sub-agents and collect one grouped result |
| `subagent` | nested | Spawn a single sub-agent (only available inside a group for one-level nesting) |
| `active_subagents` | any | List currently running subagents, optionally with recent screen output |
| `message_subagent` | any | Send a nudge or follow-up message into a running subagent session |
| `subagents_list` | any | List available agent definitions |
| `set_tab_title` | any | Update tab/window title to show progress |
| `subagent_resume` | any | Resume a previous sub-agent session (async) |

| Command | Description |
|---------|-------------|
| `/plan` | Start a full planning workflow |
| `/iterate` | Fork into a subagent for quick fixes |
| `/subagent <agent> [--hint frontend\|non-frontend] <task>` | Spawn a named agent directly |

**Session Artifacts** — 2 tools for session-scoped file storage:

| Tool | Description |
|------|-------------|
| `write_artifact` | Write plans, context, notes to a session-scoped directory |
| `read_artifact` | Read artifacts from current or previous sessions |

### Bundled Agents

| Agent | Model | Role |
|-------|-------|------|
| **planner** | Opus (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout** | Haiku | Fast codebase reconnaissance — maps files, patterns, conventions |
| **worker** | Sonnet | Implements tasks from todos — writes code, runs tests, makes polished commits |
| **reviewer** | Opus (medium thinking) | Reviews code for bugs, security issues, correctness |
| **visual-tester** | Sonnet | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## Async Subagent Flow

```
1. Agent calls subagent()         → returns immediately ("started")
2. Sub-agent runs in mux pane     → widget shows live progress
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as interrupt
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently. If you call `subagent` repeatedly, each one steers its result back independently as it finishes. If you use `agent_group`, the batch waits and steers back one grouped result at the end. The live widget above the input tracks all running agents:

```
╭─ Subagents ──────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)      15 msgs (12KB) │
│ 00:45  Researcher (researcher)   8 msgs (6KB)  │
│ 00:12  Scout: DB (scout)             starting…  │
╰─────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." })

// Batch launch with one grouped completion update
agent_group({
  name: "Implementation batch",
  agents: [
    { name: "Worker: API", agent: "worker", task: "Implement the API changes" },
    { name: "Reviewer", agent: "reviewer", task: "Review the current diff" },
  ],
})

// Block until the whole batch finishes
agent_group({
  name: "Scouting",
  wait: true,
  agents: [
    { name: "Scout: Auth", agent: "scout", task: "Analyze auth" },
    { name: "Scout: DB", agent: "scout", task: "Analyze database" },
  ],
})

// Fork — sub-agent gets full conversation context
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." })

// Typed fork — keep full current context, but adopt the named agent role
subagent({ name: "Debugger", agent: "debugger", fork: true, task: "Reproduce and fix the flaky test" })

// Override agent defaults
subagent({ name: "Worker", agent: "worker", model: "anthropic/claude-opus-4-6", task: "Quick fix..." })

// Hint the model family without hardcoding an exact model
subagent({ name: "Worker", agent: "worker", modelHint: "frontend", task: "Polish the pricing page UI" })
subagent({ name: "Worker", agent: "worker", modelHint: "non-frontend", task: "Refactor the queue worker retry logic" })

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." })
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | string | required | Display name (shown in widget and pane title) |
| `task` | string | required | Task prompt for the sub-agent |
| `agent` | string | — | Load defaults from agent definition |
| `fork` | boolean | `false` | Copy current session for full context. When combined with `agent`, this becomes a typed fork: current context + named agent role |
| `model` | string | — | Override agent's default model |
| `modelHint` | `frontend` \| `non-frontend` | — | Hint the model family. `frontend` prefers Claude/Sonnet/Opus-style models; `non-frontend` prefers Codex/GPT-style models. Ignored when `model` is set. |
| `systemPrompt` | string | — | Append to system prompt |
| `skills` | string | — | Comma-separated skill names |
| `tools` | string | — | Comma-separated tool names |
| `cwd` | string | — | Working directory for the sub-agent (see [Role Folders](#role-folders)) |

### Orchestrator control tools

These are intended for the **outer/orchestrator session** so it can supervise active work:

```typescript
active_subagents({ screenLines: 40 })

message_subagent({
  target: "Scout: Auth",
  message: "You look close to done. Write your artifact, summarize findings, then call subagent_done.",
  screenLines: 30,
})
```

Subagents themselves are denied these control tools by default, so only the main session can inspect and nudge sibling agents.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm todos, adjust if needed
Phase 4: Execute          → Scout + sequential workers implement todos
Phase 5: Review           → Reviewer subagent checks all changes
```

Tab/window titles update to show current phase:

```
🔍 Investigating: dark mode → 💬 Planning: dark mode
→ 🔨 Executing: 1/3 → 🔎 Reviewing → ✅ Done
```

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
/iterate --agent debugger Reproduce and fix the off-by-one error in the pagination logic
```

This forks the current session into a subagent with full conversation context. With no agent, it's a raw self-fork. With `--agent`, it's a typed fork: the fork keeps the current conversation but adopts that agent's role, model, tools, and constraints. The main session gets a summary of what was done.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

```markdown
---
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

### Frontmatter Reference

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` output |
| `model` | string | Default model (e.g. `anthropic/claude-sonnet-4-6`) |
| `model-frontend` / `frontend-model` | string | Optional model override used when `modelHint: "frontend"` |
| `model-non-frontend` / `non-frontend-model` | string | Optional model override used when `modelHint: "non-frontend"` |
| `thinking` | string | Thinking level: `minimal`, `medium`, `high` |
| `tools` | string | Comma-separated **native pi tools only**: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `skills` | string | Comma-separated skill names to auto-load |
| `spawning` | boolean | Set `false` to deny all subagent-spawning tools |
| `deny-tools` | string | Comma-separated extension tool names to deny |
| `cwd` | string | Default working directory (absolute or relative to project root) |

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all spawning tools (`subagent`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent, set_tab_title
---
```

### Recommended Configuration

| Agent | `spawning` | Rationale |
|-------|-----------|-----------|
| planner | *(default)* | Legitimately spawns scouts for investigation |
| worker | `false` | Should implement tasks, not delegate |
| researcher | `false` | Should research, not spawn |
| reviewer | `false` | Should review, not spawn |
| scout | `false` | Should gather context, not spawn |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" })
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" })
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) — the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij
```

## License

MIT
