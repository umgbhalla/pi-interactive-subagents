# pi-interactive-subagents

Interactive subagents for [pi](https://github.com/badlogic/pi-mono) - spawn, orchestrate, and manage sub-agent sessions in multiplexer panes.


https://github.com/user-attachments/assets/c2dafe55-e4a6-4bcc-afac-273e3f05bdca


This package gives pi the ability to delegate work to specialized sub-agents that run in their own terminal sessions. A main orchestrator session spawns scouts, planners, workers, and reviewers, each visible in a side-by-side split. The user can watch progress in real-time, interact with interactive agents, and get summaries when autonomous agents finish.

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

Optional: set `PI_SUBAGENT_MUX=cmux|tmux|zellij` to force a specific backend.

## What's Included

### Extensions

**Subagents** - 5 tools + 3 commands for spawning and managing sub-agents:

| Tool | Description |
|------|-------------|
| `subagent` | Spawn a sub-agent in a dedicated multiplexer pane |
| `parallel_subagents` | Run multiple autonomous sub-agents concurrently with tiled layout |
| `subagents_list` | List available agent definitions |
| `set_tab_title` | Update tab/window title to show progress |
| `subagent_resume` | Resume a previous sub-agent session |

| Command | Description |
|---------|-------------|
| `/plan` | Start a full planning workflow |
| `/iterate` | Fork into an interactive subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly |

**Session Artifacts** — 2 tools for session-scoped file storage:

| Tool | Description |
|------|-------------|
| `write_artifact` | Write plans, context, notes to a session-scoped directory |
| `read_artifact` | Read artifacts from current or previous sessions |

### Bundled Agents

Five agent definitions ship with the package. Each has a specific role, model, and system prompt:

| Agent | Model | Role |
|-------|-------|------|
| **planner** | Opus (medium thinking) | Interactive brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout** | Haiku | Fast codebase reconnaissance — maps files, patterns, conventions |
| **worker** | Sonnet | Implements tasks from todos — writes code, runs tests, makes polished commits |
| **reviewer** | Opus (medium thinking) | Reviews code for bugs, security issues, correctness |
| **visual-tester** | Sonnet | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing |

Agent discovery follows priority: **project-local** (`.pi/agents/`) > **global** (`~/.pi/agent/agents/`) > **package-bundled**. Override any bundled agent by placing your own version in the higher-priority location.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline. It's the primary way to build features with subagents.

```
/plan Add a dark mode toggle to the settings page
```

### How It Works

```
┌─────────────────────────────────────────────────────┐
│  Phase 1: Investigation (main session)              │
│  Quick codebase scan — file structure, patterns     │
├─────────────────────────────────────────────────────┤
│  Phase 2: Planning (interactive subagent)           │
│  User collaborates with the planner agent           │
│  → Clarify requirements                             │
│  → Explore approaches                               │
│  → Validate design                                  │
│  → Write plan artifact                              │
│  → Create scoped todos                              │
├─────────────────────────────────────────────────────┤
│  Phase 3: Review Plan (main session)                │
│  Confirm todos, adjust if needed                    │
├─────────────────────────────────────────────────────┤
│  Phase 4: Execute (sequential workers)              │
│  Scout gathers context → Workers implement todos    │
│  Each worker: claim → implement → test → commit     │
├─────────────────────────────────────────────────────┤
│  Phase 5: Review (reviewer subagent)                │
│  Code review with priority triage (P0–P3)           │
│  Fix critical issues, skip nits                     │
└─────────────────────────────────────────────────────┘
```

**Phase 1** — The main session does a quick investigation (30–60 seconds) to gather context. For larger codebases, it spawns a scout agent first.

**Phase 2** — An interactive planner opens in a side-by-side terminal split. The planner walks through requirements, proposes approaches, validates the design section by section, and produces a plan artifact + scoped todos. The user collaborates directly — answering questions, picking approaches, confirming design decisions. When done, Ctrl+D returns to the main session.

**Phase 3** — The main session reviews the plan and todos. The user can adjust before execution begins.

**Phase 4** — A scout gathers implementation context, then workers execute todos one at a time. Each worker claims a todo, implements it, runs tests, makes a polished commit, and closes the todo. Workers run sequentially to avoid git conflicts.

**Phase 5** — A reviewer examines all changes, producing a prioritized report. P0/P1 issues get fixed immediately by additional workers. P2/P3 items are noted or skipped.

Throughout the workflow, tab/window titles update to show current phase:

```
🔍 Investigating: dark mode    →    💬 Planning: dark mode
→    🔨 Executing: 1/3    →    🔨 Executing: 2/3
→    🔎 Reviewing: dark mode    →    ✅ Done: dark mode
```

---

## The `/iterate` Workflow

For quick, focused work — bugfixes, small changes, ad-hoc tasks — without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This forks the current session into an interactive subagent. The sub-agent has full conversation context (it knows everything discussed so far) and opens in a side-by-side terminal. Make the fix, verify it, and Ctrl+D to return. The main session gets a summary of what was done.

Use `/iterate` when:
- You spot a bug during a larger workflow
- You want to try something without cluttering the main session
- You need hands-on work with full context

---

## Direct Subagent Spawning

For fine-grained control, spawn agents directly:

```
/subagent scout Analyze the authentication module
/subagent worker Implement TODO-abc123
/subagent reviewer Review the last 3 commits
```

Or let the LLM use the `subagent` tool with full parameter control:

```typescript
subagent({
  name: "Scout",
  agent: "scout",
  interactive: false,
  task: "Map the database schema and query patterns"
})
```

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `name` | string | required | Display name (shown in pane title/tab) |
| `task` | string | required | Task prompt for the sub-agent |
| `agent` | string | — | Load defaults from agent definition |
| `interactive` | boolean | `true` | User collaborates vs. autonomous |
| `fork` | boolean | `false` | Copy current session for full context |
| `model` | string | — | Override agent's default model |
| `systemPrompt` | string | — | Append to system prompt |
| `skills` | string | — | Comma-separated skill names |
| `tools` | string | — | Comma-separated tool names |
| `cwd` | string | — | Working directory for the sub-agent (see [Role Folders](#role-folders)) |

---

## Parallel Subagents

The `parallel_subagents` tool runs multiple autonomous sub-agents concurrently with a single tool call. Each agent gets its own pane in a tiled layout, and progress updates stream in as each agent completes.

```typescript
parallel_subagents({
  agents: [
    { name: "Scout: Auth", agent: "scout", task: "Analyze the authentication module" },
    { name: "Scout: Database", agent: "scout", task: "Map the database schema and query patterns" },
    { name: "Scout: API", agent: "scout", task: "Document the REST API endpoints" },
  ]
})
```

### Terminal Layout

Parallel agents are arranged in a tiled layout next to the orchestrator:

```
┌──────────────────┬──────────────────┐
│                  │  Scout: Auth     │
│                  ├──────────────────┤
│   Orchestrator   │  Scout: Database │
│                  ├──────────────────┤
│                  │  Scout: API      │
└──────────────────┴──────────────────┘
```

The first agent splits right from the orchestrator (side-by-side). Each subsequent agent splits down from the previous one (stacked vertically). All terminals are visible simultaneously.

### Progress Rendering

Unlike separate `subagent` calls, `parallel_subagents` is a single tool call — so progress updates render immediately as each agent finishes:

```
1/3 done · 45s elapsed
  ✓ Scout: Auth — done
  ⟳ Scout: Database — 32s · 12 msgs (8.2KB)
  ⟳ Scout: API — 28s · 8 msgs (5.1KB)
```

### Good Candidates for Parallelism

- Multiple scouts gathering context from different parts of the codebase
- Independent workers on non-overlapping tasks (be careful with git conflicts)
- A scout + a researcher running simultaneously
- Parallel research on different topics

All agents run autonomously (`interactive: false` is enforced). Each parameter accepts the same options as `subagent` except `interactive` and `fork`.

---

## Custom Agents

Create your own agent definitions. Place a `.md` file in `.pi/agents/` (project) or `~/.pi/agent/agents/` (global):

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

The frontmatter configures the agent defaults. The body becomes the system prompt.

### Frontmatter Reference

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Agent name (used in `agent: "my-agent"`) |
| `description` | string | Shown in `subagents_list` output |
| `model` | string | Default model (e.g. `anthropic/claude-sonnet-4-6`) |
| `thinking` | string | Thinking level: `minimal`, `medium`, `high` |
| `tools` | string | Comma-separated builtin tools (e.g. `read, bash, edit, write`) |
| `skills` | string | Comma-separated skill names to auto-load |
| `spawning` | boolean | Set `false` to deny all subagent-spawning tools |
| `deny-tools` | string | Comma-separated extension tool names to deny |
| `cwd` | string | Default working directory (absolute or relative to project root) |

---

## Tool Access Control

By default, every sub-agent has access to all extension tools — including the ability to spawn further sub-agents. This can lead to unbounded recursion and wasted tokens (a researcher spawning another researcher, a worker spawning workers, etc.).

Two frontmatter fields control which tools are available in a sub-agent session:

### `spawning: false`

Shorthand that denies all four spawning tools at once:
- `subagent`
- `parallel_subagents`
- `subagents_list`
- `subagent_resume`

```yaml
---
name: worker
spawning: false
---
```

The agent can still do its work — it just can't spawn other agents.

### `deny-tools`

Fine-grained control over individual tools. Comma-separated list of extension tool names to deny:

```yaml
---
name: focused-agent
deny-tools: subagent, parallel_subagents, set_tab_title
---
```

### Combining Both

Both fields can be used together. The denied sets are merged:

```yaml
---
name: locked-down-agent
spawning: false
deny-tools: set_tab_title
---
# Denies: subagent, parallel_subagents, subagents_list, subagent_resume, set_tab_title
```

### How It Works

When a sub-agent is spawned, the extension resolves the denied tools from the agent's frontmatter and passes them as a `PI_DENY_TOOLS` environment variable to the child process. The extension checks this variable at startup and skips registering the denied tools — they never appear in the agent's tool list.

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

The `cwd` parameter lets sub-agents start in a specific directory. When pi launches in a folder, it auto-discovers that folder's local configuration:

- `.pi/agents/` — local agent definitions
- `CLAUDE.md`, `.cursorrules`, etc. — project conventions / system prompt
- `.pi/skills/` — local skills
- `.pi/extensions/` — local extensions

This makes it possible to create **role-specific folders** where each folder defines a completely different agent persona — with its own system prompt, tools, skills, and conventions.

### Example: Game Design Team

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/
│   │       └── skills/
│   │           └── runbooks/  ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

Spawn them:

```typescript
// Game designer — picks up agents/game-designer/CLAUDE.md
subagent({
  name: "Game Designer",
  interactive: true,
  cwd: "agents/game-designer",
  task: "Help me design the combat system"
})

// SRE — picks up agents/sre/CLAUDE.md + local skills
subagent({
  name: "SRE",
  interactive: false,
  cwd: "agents/sre",
  task: "Review our deployment pipeline for single points of failure"
})
```

### `cwd` in Agent Definitions

You can also set a default `cwd` in the agent frontmatter, so every time that agent is spawned it starts in the right folder:

```yaml
---
name: game-designer
description: Game design specialist
model: anthropic/claude-sonnet-4-6
tools: read, write
cwd: ./agents/game-designer
spawning: false
---

You are a game designer...
```

Then simply:

```typescript
subagent({ name: "Game Designer", agent: "game-designer", task: "..." })
// Automatically starts in ./agents/game-designer/
```

The `cwd` parameter on the tool call always overrides the agent default.

### How It Works

The `cwd` is resolved relative to the project root (or used as-is if absolute). Before launching the pi process, the extension prepends `cd <resolved-path> &&` to the command. Pi then starts in that directory and discovers its local configuration normally.

---

## Requirements

- [pi](https://github.com/badlogic/pi-mono) - the coding agent
- One supported multiplexer:
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

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij
```

## License

MIT
