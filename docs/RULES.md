# RULES.md — Enforcement Spec

The exact behavior of the `dispatch-policy` plugin, extracted from `src/dispatch-policy.ts`
(the single source of truth; this document describes it, never replaces it).
Verified against OpenCode v2.0.27. English only, tables aligned `| :-- |`.

## 1. Gated set

A tool call whose name is in the gated set is **DENIED** until the calling session
meets the prerequisites below. Gated names were verified against the live v2.0.27
session DB (stored dispatches, read-only sqlite).

| :-- | Tool name(s) | Status on this install |
| :-- | :-- | :-- |
| File edits | `edit`, `write` | live |
| Shell | `shell` (live bash-class), `bash`, `apply_patch` (legacy, defensive) | `shell` 52k+ calls; legacy kept on purpose |
| Dispatch | `subagent` | live (legacy `task` retired 2026-09-16, deliberately unguarded) |
| Web | `webfetch`, `websearch` | live |
| Code Mode | `execute` | live; gates the `tools.exa.*` composition bypass surface |
| MCP exa | any tool name containing the substring `exa` (e.g. `exa_web_search_exa`) | live |

Whitelisted **by construction** (never gated, they are the compliance paths):
`skill`, `read`, `grep`, `glob`, `todo*`, `question`, `read_mcp_resource`,
non-exa MCP tools.

## 2. Prerequisites per action

| :-- | Action | Prerequisites (all required, per session) |
| :-- | :-- | :-- |
| 1 | Any gated tool call | `skill` invoked for **brainstorming**, **grilling**, **build-with-exa** + a completed `read` of `~/.config/opencode/MEMORY.md` |
| 2 | `subagent` dispatch (additionally) | `skill` for **subagent-driven-development** + **dispatching-parallel-agents** + completed reads of `~/.config/opencode/memory/topics/workflow.md` **and** `workflow-git-pr.md` |
| 3 | `subagent` with `agent: "general"` | Never allowed, any state |
| 4 | `subagent` without `background: true` | Never allowed, any state (strict: `false` **and** omitted both deny) |

Recording rules (what counts as compliance):

- A `skill` invocation counts **only** on `status: "completed"` — a failed load never counts.
- A `read` counts when its `path` resolves (after `~`-expansion) to a tracked target
  (suffix match); absolute and `~/` forms both accepted (both occur in real traffic).
- State is **per-session** (`Map<sessionID, …>`): a second session stays fully gated.
- State clears on server restart **and** on every plugin hot-reload (fail-closed by design).

## 3. Deny messages

Deny messages list **exactly what is missing** (dynamic), then the comply-then-rerun
instruction. The ban messages (rows 3–4 above) are checked **before** the skill gate —
an absolute ban wins over the procedural one.

| :-- | Trigger | Deny message (verbatim) |
| :-- | :-- | :-- |
| 1 | `agent: "general"` | `DENIED by dispatch-policy plugin: agent type "general" is FORBIDDEN by owner mandate. Re-dispatch with a specialized agent type — e.g. code-reviewer, backend-architect, frontend-developer, trend-researcher (full list: opencode debug agents).` |
| 2 | `background !== true` | `DENIED by dispatch-policy plugin: owner mandate requires background:true on every subagent dispatch. Re-dispatch the SAME call with background:true.` |
| 3 | Gated call, missing items | `Owner mandate: this action requires, in this session first: <missing items joined by "; ">. Load skills via the `skill` tool (one call per skill); read memory files with the `read` tool. Then re-run this exact call.` |

Missing-item format: `skill "<id>"` and `read of <path>` — e.g. at zero state a
`shell` call lists the 3 skills + the MEMORY.md read and **not** the orchestrator
items; at base-complete a `subagent` call lists only the 2 orchestrator skills + 2
workflow reads.

## 4. Passive layers

| :-- | Layer | Behavior |
| :-- | :-- | :-- |
| 1 | Primer injection | `session.context` hook pushes the owner-approved PRIMER (12 bullets) as a system text part before **every** model request; survives compaction (system parts reassembled per request). |
| 2 | Tool description hint | One policy line appended to the `subagent` tool description at selection time (missing tool IDs are ignored by the editor — a rename degrades to the interception layers only). |

## 5. Safety valves and failure modes

- **Kill switch**: `OPENCODE_ENFORCE_OFF=1` disables all behavior — but it is read
  from the **server process env at hook-call time**, so setting it only affects
  future server starts. The immediate off-switch is deleting the plugin file
  (hot-reload unloads it).
- **Fail-closed**: a broken hook build denies every gated call (observed live;
  in-session recovery is impossible — all writers are gated). Recovery:
  `rm ~/.config/opencode/plugin/dispatch-policy.ts`, then reinstall from the repo.
- **Atomic install only**: never multi-edit the live file (interim states get
  hot-reloaded). `install.sh` enforces single `mv` installs by construction.
