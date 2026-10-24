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
| 2 | `subagent` dispatch (additionally) | `skill` for **subagent-driven-development** + **dispatching-parallel-agents** + **prompt-engineering-patterns** + completed reads of `~/.config/opencode/memory/topics/workflow.md` **and** `workflow-git-pr.md` |
| 3 | `subagent` with `agent: "general"` | Never allowed, any state |
| 4 | `subagent` without `background: true` | Never allowed, any state (strict: `false` **and** omitted both deny) |
| 5 | Fresh `subagent` dispatch / long Stitch prompt | The free-text `prompt` must contain the structural blocks — see "Prompt-structure gate" below |
| 6 | Fresh `subagent` dispatch (additionally) | The brief must **mandate reading global memory** — keyword presence: `MEMORY.md`, `memory/topics`, `memory/projects`, "global memory", or the RU «глобальная память» forms — see "ext 6 wave" below |
| 7 | `write` to an existing global memory file | Never allowed, any state — append/supersede via `edit`; creating a NEW memory file passes |
| 8 | `subagent` with `agent` missing/empty | Never allowed, any state (actionable deny; `agent: "general"` still gets the row-3 ban message) |

Rationale (owner decision 2026-10-24): **prompt-engineering-patterns** is mandated on the
dispatch path because dispatch briefs (subagent prompts) and agent-MCP prompts are prompts —
the orchestrator must apply prompt-engineering patterns when writing them.

### Prompt-structure gate (ext 5, owner decision 2026-10-24)

Deterministic keyword-presence check on free-text `prompt` inputs — the checkable subset
of "no bad prompts". Source of truth: the **prompt-engineering-patterns** skill
(`references/system-prompts.md` — "Effective System Prompt Structure": Role + Expertise +
Behavioral Guidelines + Output Format + Constraints; every template in the library carries
Task / Context / Requirements / Constraints / Output). Matching is tolerant to header or
inline forms (`## Task`, `**Task:**`, `Task:`) and to Russian block names (`Контекст:`).

| :-- | Surface | Required blocks |
| :-- | :-- | :-- |
| `subagent`, fresh dispatch (`sessionID` absent) | Role / Task / Context / Constraints / Output format |
| `stitch_generate_screen_from_text`, `stitch_edit_screens`, `stitch_generate_variants`, `prompt` ≥ 120 chars | Task / Context / Constraints / Output format (no Role — the tool's role is fixed) |

Exemptions (by design — don't block commands where free text cannot or should not be forced):

- Subagent **continuations** (`sessionID` present): the original dispatch already passed.
- Stitch prompts **shorter than 120 chars**: the tools themselves recommend re-calling with
  an accepted suggestion verbatim (e.g. "Yes, make them all") — tactical follow-ups flow.
- All other Stitch surfaces: ID/enum tools; `create_project.title` (a label, not a prompt);
  `designMd` / `styleGuidelines` (design-spec genre, not task prompts); `upload_design_md`
  (base64 file upload).
- Runtime names `stitch_*` follow the verified flat MCP convention (`exa_web_search_exa`
  lives in the session DB); no live Stitch calls existed at implementation time — a rename
  would silently disable the check (same degradation as the tool-description hint).

Ordering: bans (incl. rows 3, 4, 8) → skill/memory gate → structure check → memory-mandate
check (fresh dispatches; compliance first: load the skill, then the brief is validated,
then its memory mandate is verified).

Recording rules (what counts as compliance):

- A `skill` invocation counts **only** on `status: "completed"` — a failed load never counts.
- A `read` counts when its `path` resolves (after `~`-expansion) to a tracked target
  (suffix match); absolute and `~/` forms both accepted (both occur in real traffic).
- State is **per-session** (`Map<sessionID, …>`): a second session stays fully gated.
- State clears on server restart **and** on every plugin hot-reload (fail-closed by design).

### ext 6 wave (owner decisions 2026-10-25; spec source: the ext-6 analyst report, 2026-10-25)

Wave 1 shipped three deterministic layers; the rest of the analyst proposals are tracked in
[`docs/BACKLOG.md`](BACKLOG.md) (6.2 audit log, 6.3 continuation-chain cap, 6.4
identical-dispatch breaker, 6.5 shell guards — the pkill/killall slice moved to native
`opencode.json` V2 permission rules, owner decision 2026-10-25).

**Memory-mandate keyword (6.1).** A fresh dispatch brief (`sessionID` absent) must contain a
memory-reading mandate — keyword presence, case-insensitive:
`/(MEMORY\.md|memory\/(topics|projects)|глобальн\p{L}*\s+пам(ять|яти)|global memory)/iu`.
Continuations are exempt (the original dispatch already passed). The check runs after the
structure check, so ordering is preserved. Mechanical enforcement of the owner hard dispatch
protocol of 2026-10-10; the analyst grounding measured 8.5% of post-plugin fresh briefs
violating it. Delta vs the analyst sketch, deliberate: the sketch's `\w` is ASCII-only in JS
and cannot match the Cyrillic tail of «глобальную» — `\p{L}` under the `u` flag is required
(pinned by a test).

**Memory whole-file overwrite guard (6.6).** A `write` whose target resolves (after
`~`-expansion, shared `expandTilde` helper) under the global memory tree
(`.config/opencode/memory/`, incl. the root `MEMORY.md`) **and** whose file already exists
(`fs.existsSync`) is denied: whole-file rewrites of memory race concurrent agents — the
mechanism behind the 2026-10-09/10 incidents. Creating a NEW memory file passes; `edit` is
untouched by design (append/supersede-in-place is the sanctioned path). The runtime `write`
input key is `path`; legacy stored calls used `filePath` — both are checked, `path` preferred.
Honest failure mode: a stat failure **allows** the call — this layer is a hygiene backstop,
not a security boundary (grounding: zero post-plugin memory writes).

**Agent-missing deny (6.7).** A dispatch with `agent` missing, empty, or whitespace-only gets
an actionable deny instead of the runtime's generic schema error (`Invalid arguments … agent:
Missing key`). The check sits before the `general` ban, but `agent: "general"` is a non-empty
string, so the ban message still wins for that value. Message-quality layer: the runtime
already blocks the missing-key subclass.

## 3. Deny messages

Deny messages list **exactly what is missing** (dynamic), then the comply-then-rerun
instruction, then the shared **COMPLIANCE WARNING** trailer (below). The ban messages
(rows 3–4 and 8 above) are checked **before** the skill gate — an absolute ban wins over
the procedural one.

| :-- | Trigger | Deny message (verbatim) |
| :-- | :-- | :-- |
| 1 | `agent: "general"` | `DENIED by dispatch-policy plugin: agent type "general" is FORBIDDEN by owner mandate. Re-dispatch with a specialized agent type — e.g. code-reviewer, backend-architect, frontend-developer, trend-researcher (full list: opencode debug agents).` + trailer |
| 2 | `background !== true` | `DENIED by dispatch-policy plugin: owner mandate requires background:true on every subagent dispatch. Re-dispatch the SAME call with background:true.` + trailer |
| 3 | Gated call, missing items | `Owner mandate: this action requires, in this session first: <missing items joined by "; ">. Load skills via the `skill` tool (one call per skill); read memory files with the `read` tool. Then re-run this exact call.` + trailer |
| 4 | Structure check failed (§2 ext 5) | `DENIED by dispatch-policy plugin: prompt-structure check (per the prompt-engineering-patterns skill) on the <target> prompt failed. Missing required block(s): <names joined by "; ">. Structure the prompt with explicit blocks: <profile blocks joined by " / ">. Then re-run this exact call.` + trailer. `<target>` is `subagent dispatch` or `MCP tool "<name>"`; an absent/empty dispatch prompt prepends `The dispatch prompt is missing or empty. ` |
| 5 | Fresh brief without a memory mandate (§2 row 6) | `DENIED by dispatch-policy plugin: the dispatch brief does not mandate reading global memory (owner hard dispatch protocol: every subagent brief must instruct the subagent to read ~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/* and list what it read in its report). Add the memory mandate to the brief, then re-run this exact call.` + trailer |
| 6 | `write` over an existing global memory file (§2 row 7) | `DENIED by dispatch-policy plugin: whole-file write over an EXISTING global memory file is forbidden — whole-file rewrites of memory race concurrent agents (2026-10-09/10 incidents). Append or supersede the entry via the `edit` tool instead (append-only by anchors; supersede-in-place, never full-file write). Creating a NEW memory file is allowed.` + trailer |
| 7 | `agent` missing/empty (§2 row 8) | `DENIED by dispatch-policy plugin: the dispatch is missing a specialized agent type (agent missing or empty). Pick a specialized agent type — e.g. backend-architect, code-reviewer, frontend-developer, trend-researcher (full list: opencode debug agents) — then re-run this exact call.` + trailer |

Shared trailer (verbatim, appended to every deny message):

```
 COMPLIANCE WARNING: all output is audited against the requirements of the skills applied in this session — work that violates them is REJECTED and must be redone. This explicitly covers dispatches: a subagent sent with a poorly written brief (violating prompt-engineering requirements — vague task, missing context/constraints, no report contract) will be REJECTED and must be re-dispatched.
```

The trailer is a **declarative deterrent**: no hook in the plugin audits model output
against skill requirements — nothing tracks compliance beyond skill-load/read recording
above. It exists by owner decision to bias models toward actually following the loaded
skills' requirements; the plugin's deterministic checks are exactly the ones in this spec.

Missing-item format: `skill "<id>"` and `read of <path>` — e.g. at zero state a
`shell` call lists the 3 skills + the MEMORY.md read and **not** the orchestrator
items; at base-complete a `subagent` call lists only the 3 orchestrator skills + 2
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
