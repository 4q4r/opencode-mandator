# RULES.md — Enforcement Spec

The exact behavior of the `dispatch-policy` plugin, extracted from `src/dispatch-policy.ts`
(the single source of truth; this document describes it, never replaces it).
Verified against OpenCode v2.0.27. English only, tables aligned `| :-- |`.

> **Opt-in enforcement (owner decision 2026-11-07).** The built-in defaults are EMPTY:
> with no plugin options the plugin is completely INERT — no gates, no denies, no primer
> injection, no description hint, no config problems. Everything below describes the
> behavior of a CONFIGURED plugin; the canonical owner setup lives in
> `tests/fixtures/mandator-setup.json` (the values shown in the tables below).

## 1. Gated set

A tool call whose name is in the gated set is **DENIED** until the calling session
meets the prerequisites below. The gated set exists only where configured
(`gates.tools` + non-empty `gates.exaSubstring` + `gates.mcpRequirements` prefixes —
§6.2); an unconfigured plugin gates nothing. The names below are the canonical owner
setup's gated set, verified against the live v2.0.27 session DB (stored dispatches,
read-only sqlite).

| :-- | Tool name(s) | Status on this install |
| :-- | :-- | :-- |
| File edits | `edit`, `write` | live |
| Shell | `shell` (live bash-class), `bash`, `apply_patch` (legacy, defensive) | `shell` 52k+ calls; legacy kept on purpose |
| Dispatch | `subagent` | live (legacy `task` retired 2026-09-16, deliberately unguarded) |
| Web | `webfetch`, `websearch` | live |
| Code Mode | `execute` | live; gates the `tools.exa.*` composition bypass surface |
| MCP exa | any tool name containing the substring `exa` (e.g. `exa_web_search_exa`) | live |
| MCP skill-requirement (ext 7.1) | any tool name starting with `context7` or `adb_mcp` (flat `<server>_<tool>` MCP convention) | live names: `context7_resolve_library_id`, `context7_query_docs`; `adb_mcp_*` (server `adb-mcp`) |

Whitelisted **by construction** (never gated, they are the compliance paths):
`skill`, `read`, `grep`, `glob`, `todo*`, `question`, `read_mcp_resource`,
non-exa MCP tools **without a skill requirement** (§2 row 11 — since ext 7.1 the
`context7*` / `adb_mcp*` prefixes are the one gated MCP exception).

## 2. Prerequisites per action

Applies to a CONFIGURED plugin (see the §1 note: empty defaults enforce nothing). Each
row below is active only while its option makes the guard meaningful (§6.1 table).

| :-- | Action | Prerequisites (all required, per session) |
| :-- | :-- | :-- |
| 1 | Any gated tool call | `skill` invoked for **brainstorming**, **grilling**, **build-with-exa**, **context7-mcp** + a completed `read` of `~/.config/opencode/MEMORY.md` |
| 2 | `subagent` dispatch (additionally) | `skill` for **subagent-driven-development** + **dispatching-parallel-agents** + **prompt-engineering-patterns** + completed reads of `~/.config/opencode/memory/topics/workflow.md` **and** `workflow-git-pr.md` |
| 3 | `subagent` with `agent: "general"` | Never allowed, any state |
| 4 | `subagent` without `background: true` | Never allowed, any state (strict: `false` **and** omitted both deny) |
| 5 | Fresh `subagent` dispatch / long Stitch prompt | The free-text `prompt` must contain the structural blocks — see "Prompt-structure gate" below |
| 6 | Fresh `subagent` dispatch (additionally) | The brief must **mandate reading global memory** — keyword presence: `MEMORY.md`, `memory/topics`, `memory/projects`, "global memory", or the RU «глобальная память» forms — see "ext 6 wave" below |
| 7 | `write` to an existing global memory file | Never allowed, any state — append/supersede via `edit`; creating a NEW memory file passes |
| 8 | `subagent` with `agent` missing/empty | Never allowed, any state (actionable deny; `agent: "general"` still gets the row-3 ban message) |
| 9 | `subagent` fresh dispatch identical to an earlier one in the same session (same agent + prompt), count reaching 4 | Never allowed from the 4th identical fresh dispatch — 3 identical executions pass; per-session counter (djb2), continuations exempt — see "ext 6 wave" below |
| 10 | `subagent` continuation of the same child session within one parent session, count passing 6 | Never allowed from the 7th continuation of the same child — 6 pass (increment-then-check on continuations that reach the check; denials by earlier gates never increment — cap denials and overrides do); a continuation prompt carrying `[chain-cap-override] <reason>` may pass beyond the cap — see "ext 6 wave" below |
| 11 | Gated MCP tool starting with a skill-requirement prefix — `context7*` / `adb_mcp*` (ext 7.1, prefix match on the flat `<server>_<tool>` name) | `skill` for the mapped skill: `context7*` → **context7-mcp**, `adb_mcp*` → **adb-mcp**. Honest inertness note: the `context7` entry cannot fire while context7-mcp is mandatory (row 1 gates every gated call on it first) — kept in the table for message specificity + future-proofing if the mandatory set ever changes; the live enforcement of this row is the `adb_mcp` entry. Deliberately no mappings for zai-mcp-server / cloakbrowser / stitch / ssh-any / circumvention-corpus — no related skills exist (docs/BACKLOG.md) |

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

Ordering: bans (incl. rows 3, 4, 8) → skill/memory gate → MCP→skill gate (row 11) →
structure check → memory-mandate check → per-path counter — identical-dispatch breaker on
the fresh path (row 9), continuation-chain cap on continuations (row 10). Compliance first —
load the skill, then the brief is validated, then its memory mandate is verified, and only
then does the per-path counter run, so compliance-teaching denies keep precedence: a gate/
structure deny never consumes a counter, and a continuation increments the cap only after
passing every earlier check.

Recording rules (what counts as compliance):

- A `skill` invocation counts **only** on `status: "completed"` — a failed load never counts.
- A `read` counts when its `path` resolves (after `~`-expansion) to a tracked target
  (suffix match); absolute and `~/` forms both accepted (both occur in real traffic).
- State is **per-session** (`Map<sessionID, …>`): a second session stays fully gated.
- State clears on server restart **and** on every plugin hot-reload (fail-closed by design).

### ext 6 wave (owner decisions 2026-10-25; spec source: the ext-6 analyst report, 2026-10-25)

Wave 1 shipped three deterministic layers (6.1, 6.6, 6.7); wave 2 shipped the
identical-dispatch circuit breaker (6.4) and wave 3 the continuation-chain cap (6.3,
Variant A), both on 2026-10-25. The remaining analyst proposals are tracked in
[`docs/BACKLOG.md`](BACKLOG.md) (6.2 audit log, 6.5 shell guards — the pkill/killall slice
moved to native `opencode.json` V2 permission rules, owner decision 2026-10-25).

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

**Identical-dispatch circuit breaker (6.4, wave 2 — owner approved 2026-10-25).** A fresh
dispatch (`sessionID` absent) identical to an earlier one **in the same session** — same
`agent` + `prompt`, keyed by an inline djb2 digest over `agent + "\u0000" + prompt` — is
denied when the per-session count reaches **4**: increment-then-check, so 3 identical
executions pass and the 4th is denied (a legitimate reviewer panel of 3 still fits; a 4th
identical resend is a runaway loop). The counter is a `Map<parentSessionID, Map<hash, count>>`
at module scope beside the gate Maps — same fail-closed restart/hot-reload semantics by
construction. Continuations are fully exempt (they are governed by the ext-6.3
depth cap, below). The check runs LAST on the fresh path, after the structure and memory-mandate
checks: compliance-teaching denies keep precedence, so a loop of malformed briefs keeps
receiving the structure deny — the correct lesson. Deltas vs the analyst sketch, deliberate
(owner decision): the deny message carries **no COMPLIANCE WARNING trailer and no "re-run
this exact call" instruction** — re-running is exactly what is being denied, and the
trailer's "must be re-dispatched" wording contradicts the guard. The deny is final for
identical resends: differentiate the briefs (per-perspective prompts) or escalate to the
owner.

**Continuation-chain cap (6.3, wave 3 — Variant A, owner approved 2026-10-25).** A
continuation (`sessionID` present) of a child session is counted per (parent session, child
session) pair — `Map<parentSessionID, Map<childSessionID, count>>` at module scope beside
the other Maps, same fail-closed restart/hot-reload semantics. Increment-then-check on every
continuation that reaches the check: 6 continuations of one child pass, the 7th is denied
with the live count. **Variant A escape:** the denial is lifted for that one dispatch iff
the prompt carries `[chain-cap-override]` followed by a non-empty reason — regex
`/\[chain-cap-override\]\s*\S/i`; a bare marker does not unlock. The marker is a deliberate,
visible, per-dispatch escape with no config involvement (owner requirement: adjustable
without config edits and without performance overhead — the env-knob and adaptive-cap
candidates from the analyst sketch are superseded). The counter keeps counting under
overrides — denied calls and overrides both increment (the counter tracks reality), so an
override neither resets nor lifts the cap. Fresh dispatches never touch this counter (they
have the 6.4 breaker). The check sits after the fresh-dispatch inner block, behind the
skill/memory gate: compliance-teaching denies keep precedence and a gate deny never consumes
the cap. The deny carries the live count, the fresh-agent recovery (start a FRESH agent and
hand off state via a git branch + a structured brief — the persistent-worker anti-pattern,
owner bans 2026-09-20 / PR97 / PR111), the marker instruction, and the shared trailer — here
the re-run advice IS valid: re-run with the marker added.

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
| 8 | Identical fresh dispatch, count reaching 4 in one session (§2 row 9) | `DENIED by dispatch-policy plugin: identical dispatch sent <N> times in this session — runaway-loop guard on identical (agent, prompt) pairs. This deny is final for identical resends: differentiate the briefs (per-perspective prompts) or escalate to the owner.` — **no trailer, the deliberate exception to the "+ trailer" convention**: the trailer's "must be re-dispatched" wording contradicts the guard, and the message intentionally carries no "re-run this exact call" instruction (re-running is exactly what is denied). `<N>` is the live per-session count; the first deny fires at N = 4 |
| 9 | Continuation chain of one child passing 6 in one session, no valid override marker (§2 row 10) | `DENIED by dispatch-policy plugin: this child-session continuation chain reached <N> continuations in one session (cap 6) — persistent-worker pumping of one child session is the anti-pattern the owner bans (2026-09-20; PR97/PR111). Start a FRESH agent instead and hand off state via a git branch + a structured brief. To continue once beyond the cap deliberately, add [chain-cap-override] <reason> to the continuation prompt, then re-run this exact call.` + trailer — here the re-run advice IS valid: the re-run carries the added marker, and this one dispatch then passes (the counter still increments). `<N>` is the live per-(parent, child) count; the first deny fires at N = 7 |
| 10 | Gated MCP tool matching a skill-requirement prefix with the mapped skill not loaded, at a base-complete session (§2 row 11) | `DENIED by dispatch-policy plugin: MCP tool "<tool>" requires its skill first. Invoke `skill` with id "<skill>" — it defines the correct usage of this server's tools (<hint>) — then re-run this exact call.` + trailer — `<hint>` is per skill: context7-mcp → `for context7: resolve-library-id before query-docs`; adb-mcp → `for adb-mcp: read the accessibility tree before tapping`; unknown skill → `load it before driving this server`. At zero state this message never fires: the row-3 base deny keeps precedence (it already lists `skill "context7-mcp"`) |

Shared trailer (verbatim, appended to every deny message **except row 8** — the
identical-dispatch breaker deny is final for identical resends and deliberately omits both
the trailer and any re-run instruction, owner decision 2026-10-25):

```
 COMPLIANCE WARNING: all output is audited against the requirements of the skills applied in this session — work that violates them is REJECTED and must be redone. This explicitly covers dispatches: a subagent sent with a poorly written brief (violating prompt-engineering requirements — vague task, missing context/constraints, no report contract) will be REJECTED and must be re-dispatched.
```

The trailer is a **declarative deterrent**: no hook in the plugin audits model output
against skill requirements — nothing tracks compliance beyond skill-load/read recording
above. It exists by owner decision to bias models toward actually following the loaded
skills' requirements; the plugin's deterministic checks are exactly the ones in this spec.

Missing-item format: `skill "<id>"` and `read of <path>` — e.g. at zero state a
`shell` call lists the 4 skills + the MEMORY.md read and **not** the orchestrator
items; at base-complete a `subagent` call lists only the 3 orchestrator skills + 2
workflow reads.

Wording configurability (Flexibility Phase 3, as amended by the opt-in flip): every deny
template above is the value of a `messages.*` option (§6.2; the canonical setup carries
today's texts verbatim) and can be reworded via config with `{var}` substitution
(`{agent}`, `{missing}`, `{target}`, `{blocks}`, `{n}`, `{cap}`, `{tool}`, `{skill}`,
`{hint}` — exactly the dynamic values in this table). An EMPTY template is valid: a
firing guard without a template still DENIES, and the deny text falls back to the
hardcoded generic line `DENIED by dispatch-policy plugin: this action violates the
configured dispatch policy; the deny template for this guard is not configured. Fix the
plugin options in opencode.json, run \`opencode service restart\`, then re-run this
exact call.` (CONFIG-ERROR-style, never configurable). What is NOT configurable: the
trailer's **presence** on every deny except row 8 (a code rule — a configured row-8
template stays trailer-less whatever it says), the `DENIED by dispatch-policy plugin:` /
`Owner mandate:` prefixes (they live inside the default templates, so an override
carries its own attribution), and the row-4 empty-prompt prefix. An unknown `{var}` in
a configured template falls back to the empty default (generic line) + a recorded
problem (§6.3).

## 4. Passive layers

| :-- | Layer | Behavior |
| :-- | :-- | :-- |
| 1 | Primer injection | `session.context` hook pushes the configured PRIMER as a system text part before **every** model request; survives compaction (system parts reassembled per request). NOTHING is injected when the resolved primer text is empty (the no-options default). The text is `primer.mode`/`primer.text`-configurable (§6.2): `default` → the configured `primer.text` when present, else nothing; `replace` → configured text verbatim; `append` → built-in default + `"\n\n"` + configured text. The canonical setup carries the 13-bullet PRIMER v2 (cloakbrowser owner-lock: humanize=True + human_preset=careful; five-block dispatch-brief quality rules — normative spec: docs/BRIEFS.md). |
| 2 | Tool description hint | One policy line appended to the first dispatch tool's description at selection time — only when both the dispatch surface is configured and the hint template is non-empty (missing tool IDs are ignored by the editor — a rename degrades to the interception layers only). |

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

## 6. Configuration (opt-in enforcement — Flexibility Phases 1-3 + the flip)

The plugin reads `options` from the **object form** of the `plugins` array entry in
`opencode.json` (string entries and file-discovered plugins carry no options).
`ctx.options` is an untyped flat JSON record — this plugin owns 100% of validation,
defaults, and error handling (`src/config.ts` → `resolveOptions`).

**Empty-by-default semantics (owner decision "Empty defaults, setup in JSON",
2026-11-07 — supersedes the Phase 0-3 zero-change premise):** empty/absent options are
VALID and make the plugin completely INERT — no gates, no denies, no primer injection,
no description hint, no config problems. Enforcement exists ONLY via explicit
configuration. The canonical owner setup (the pre-flip defaults verbatim: all 36 option
values including the message templates, the COMPLIANCE_WARNING trailer, and the PRIMER
text) lives in [`tests/fixtures/mandator-setup.json`](../tests/fixtures/mandator-setup.json)
— the controller lands it into the global `opencode.json` after merge.

### 6.0 When each guard is on (guard gating on configured presence)

Every guard runs ONLY when its configuration makes it meaningful:

| :-- | Guard | On condition (off otherwise) |
| :-- | :-- | :-- |
| 1 | `general` agent ban | `dispatch.forbiddenAgents` non-empty (deny when `agent` matches any entry) |
| 2 | Background ban | `dispatch.requireBackground: true` |
| 3 | Agent-missing deny | `dispatch.requireAgent: true` |
| 4 | Base skill/memory gate | the gated set is non-empty: `gates.tools` + `gates.exaSubstring` (non-empty string) + `gates.mcpRequirements` prefixes |
| 5 | Orchestrator preflight | `skills.orchestrator` non-empty (+ the non-memory read targets demanded on the dispatch path) |
| 6 | Fresh-dispatch structure check | `structure.subagentProfile` non-empty (blocks cross-validated) |
| 7 | Memory-mandate keyword check | `gates.memoryMandatePattern` non-empty (compilable) |
| 8 | Identical-dispatch breaker | `caps.identicalMax` non-null |
| 9 | Continuation-chain cap | `caps.chainMax` non-null (an empty `caps.chainOverrideMarker` accepts NO escape marker) |
| 10 | Memory-overwrite guard | `paths.memoryIndex` AND `paths.memoryTree` both non-empty |
| 11 | Stitch structure check | `structure.stitchPromptTools` non-empty AND `structure.stitchMinPrompt` non-null AND `structure.stitchProfile` non-empty |
| 12 | MCP→skill gate | per `gates.mcpRequirements` entries |
| 13 | Primer injection | resolved `primer.text` non-empty |
| 14 | Description hint | `dispatch.tools` non-empty AND `messages.descriptionHint` non-empty |

CONFIG-ERROR denies remain hardcoded (they report the config itself — never
configurable). A firing guard whose deny template is `""` still DENIES: the text falls
back to the hardcoded generic line (§3).

### 6.1 Loading modes, precedence, restart rule

| :-- | Mode | Options | Notes |
| :-- | :-- | :-- | :-- |
| File-discovery (default install) | `~/.config/opencode/plugin/dispatch-policy.ts` symlink → repo file (`install.sh` default) | never (`ctx.options` absent ⇒ the all-off defaults) | **inert** — enforcement requires the package mode below |
| Package mode (the configurable path) | object form: `{ "package": "<repo>/plugin-package", "options": { … } }` | yes | `plugin-package/` is a directory with `package.json` (`name: "dispatch-policy"`) re-exporting the plugin; configured local package paths must be directories — a single file path is skipped by the loader |

- **One mode at a time**: the symlink file AND a `plugins`-array entry for the same
  plugin are BOTH loaded when they coexist (observed live 2026-11-07 via
  `opencode plugin list`: two registration rows for the same id) — PRIMER injected
  twice, hooks duplicated. Switching = remove one AND add the other in the same step,
  then restart and verify primer-once.
- **Precedence (v1)**: configure the plugin exactly once, in the **global**
  `~/.config/opencode/opencode.json(c)`. Per-project options are out of scope for v1
  (undocumented global/project merge semantics; owner ruling 6).
- **Restart rule**: applying any option change = plugin reload = per-session
  compliance state cleared (all sessions re-gate; fail-closed by design). Live apply =
  `opencode service restart` (reload does not replace the ES module — verified
  2026-10-25). Operator rule: edit config → restart.
- **Recovery ladder**: bad config ⇒ fix `opencode.json` + restart; hard brick ⇒
  `OPENCODE_ENFORCE_OFF=1` + restart; last resort ⇒ remove the plugin entry/file +
  restart.
- `install.sh --package` verifies the package entry imports (bun, live install
  untouched), prints the ready-to-paste global-config snippet with the double-load
  warning, and points at `scripts/probe-options.sh` for the end-to-end options probe.

### 6.2 Option table (36 options; "Canonical value" = the owner setup in `tests/fixtures/mandator-setup.json`)

The **built-in default is empty/off for every option** (§6.0). The "Canonical value"
column shows the owner setup carried by the fixture — the values this documentation's
behavior tables describe. Any of them can be overridden per install.

| :-- | Option | Type | Canonical value (fixture) | Effect when overridden |
| :-- | :-- | :-- | :-- | :-- |
| 1 | `dispatch.tools` | `string[]` | `["subagent"]` | Which tool names are dispatch-shaped (bans, structure gate, breakers, tool-description hint targets the first entry); `[]` = dispatch guards inert |
| 2 | `dispatch.forbiddenAgents` | `string[]` | `["general"]` | The agent ban list — a dispatch is denied when `agent` matches ANY entry; `[]` = no agent ban |
| 3 | `dispatch.requireBackground` | `boolean` | `true` | `false` stops denying `background !== true` |
| 4 | `dispatch.requireAgent` | `boolean` | `true` | `false` disables the agent-missing deny (the general ban is independent) |
| 5 | `skills.mandatory` | `string[]` | 4 skills (brainstorming, grilling, build-with-exa, context7-mcp) | The base gate's required skill list; `[]` = valid, base gate inert **for skills** (the read prerequisite is a `readTargets` concern, row 12) |
| 6 | `skills.orchestrator` | `string[]` | 3 skills (subagent-driven-development, dispatching-parallel-agents, prompt-engineering-patterns) | Extra skills required on the dispatch path only; `[]` = valid, orchestrator skills waived (the non-memory reads stay — same row-12 note) |
| 7 | `gates.tools` | `string[]` | 9 names (edit, write, shell, bash, apply_patch, subagent, webfetch, websearch, execute) | The exact-match gated set (authoritative); `[]` removes exact-match entries — the exa substring rule and MCP skill-requirement prefixes still gate (rows 8, 9) |
| 8 | `gates.exaSubstring` | `string \| null` | `"exa"` | Generalizes `tool.includes(<value>)`; `""` (the built-in default) or `null` removes the substring rule (explicit MCP prefixes only) |
| 9 | `gates.mcpRequirements` | `Array<{prefix, skill}>` | 2 entries (`context7`→context7-mcp, `adb_mcp`→adb-mcp) | The ext-7.1 MCP→skill prefix table; every prefix also extends the gated set; `[]` = valid, the MCP→skill gate is inert. Per-skill usage hints stay keyed by skillId (`messages.mcpSkillHints`) — an unknown skill gets the generic hint |
| 10 | `gates.readTargets` | `Array<{key, suffix}>` | 3 entries (memory → `.config/opencode/MEMORY.md`; workflow → `…/topics/workflow.md`; workflow-git-pr → `…/topics/workflow-git-pr.md`) | Which `read` calls count as compliance (suffix match after `~`-expansion, absolute and `~/` forms both kept) and what the gates demand: the **`memory` key** is the base-gate read, every **other key** is demanded on the dispatch path; `[]` = valid, the read prerequisite is inert |
| 11 | `gates.memoryMandatePattern` | `string` (regex source, flags `iu`) | `"(MEMORY\\.md\|memory/(topics\|projects)\|глобальн\\p{L}*\\s+пам(ять\|яти)\|global memory)"` | The ext-6.1 fresh-brief keyword check (compiled at setup, never per call); `""` (the built-in default) = the check is off; an ASCII-only install swaps in a Cyrillic-free pattern. An invalid/uncompilable source fails **only the memory-mandate check** closed (its own CONFIG-ERROR) |
| 12 | `structure.blocks` | `Record<key, {name, pattern}>` | The five `BLOCKS` entries verbatim (keys `role`/`task`/`context`/`constraints`/`output`, names `Role`…`Output format`, current regex sources incl. RU alternatives) | The block vocabulary + matchers (pattern = regex source, compiled with flag `i`); the record is **replaced wholesale**, not merged. An invalid regex source or entry shape fails the structure guard closed with a CONFIG-ERROR naming `structure.blocks.<key>[.pattern]` |
| 13 | `structure.subagentProfile` | `key[]` (order = deny-message order) | `["role","task","context","constraints","output"]` | The fresh-dispatch block profile; `[]` = valid, fresh dispatches un-checked. **Cross-validated**: a key not present in `structure.blocks` ⇒ structure guard fails closed, CONFIG-ERROR naming `structure.subagentProfile` |
| 14 | `structure.stitchProfile` | `key[]` | `["task","context","constraints","output"]` | The MCP (Stitch) profile — no Role. Same cross-validation rule against `structure.blocks` (names `structure.stitchProfile`) |
| 15 | `structure.stitchPromptTools` | `string[]` | 3 Stitch free-text prompt tools | Which MCP tools get the profile check; `[]` = valid, the surface is disabled |
| 16 | `structure.stitchMinPrompt` | `number ≥ 1 \| null` | `120` | Below this length the stitch check never fires (tactical follow-ups flow); a huge value ⇒ surface off; `null` (the built-in default) = floor off. Invalid ⇒ only the Stitch surface fails closed |
| 17 | `caps.identicalMax` | `number ≥ 1 \| null` | `4` | Identical-dispatch breaker threshold (increment-then-check, per-session, fresh-only); `null` = breaker off |
| 18 | `caps.chainMax` | `number ≥ 1 \| null` | `6` | Continuation-chain cap per (parent, child); counter semantics unchanged; `null` = cap off |
| 19 | `caps.chainOverrideMarker` | `string` | `"[chain-cap-override]"` | The Variant-A escape token (marker + non-empty reason); compiled to `escape(marker) + \s*\S/i` per setup; `""` (the built-in default) = NO escape marker accepted — over-cap continuations cannot unlock |
| 20 | `paths.memoryIndex` | `string` (path, `~` ok) | `"~/.config/opencode/MEMORY.md"` | The root index file protected by the ext-6.6 overwrite guard (resolve + exact-match rule preserved); `""` (the built-in default) = guard off |
| 21 | `paths.memoryTree` | `string` (dir, `~` ok) | `"~/.config/opencode/memory"` | The protected tree (home-anchored containment; dot-segment bypass still impossible — resolution before classification); `""` (the built-in default) = guard off |
| 22 | `messages.complianceWarning` | `string` (template, no `{var}`) | the shared trailer verbatim | Wording of the deny trailer — **presence is fixed in code** (§6.3, §3): appended to every deny except row 8, whatever this option says |
| 23 | `messages.generalBan` | `string` (template, `{agent}`) | §3 row 1 minus trailer | The agent-ban deny; `{agent}` = the banned value |
| 24 | `messages.backgroundBan` | `string` (template, no `{var}`) | §3 row 2 minus trailer | The background-requirement deny |
| 25 | `messages.agentMissing` | `string` (template, no `{var}`) | §3 row 7 minus trailer | The ext-6.7 agent-missing deny |
| 26 | `messages.gateMissing` | `string` (template, `{missing}`) | §3 row 3 minus trailer | The base-gate deny; `{missing}` = the "; "-joined missing list |
| 27 | `messages.structureFail` | `string` (template, `{target}` `{missing}` `{blocks}`) | §3 row 4 minus trailer | The structure deny; `{target}` = `subagent dispatch` / `MCP tool "<name>"`, `{blocks}` = the " / "-joined profile guide. The empty-prompt prefix stays hardcoded (code rule) |
| 28 | `messages.memoryMandateFail` | `string` (template, no `{var}`) | §3 row 5 minus trailer | The ext-6.1 memory-mandate deny |
| 29 | `messages.memoryOverwriteFail` | `string` (template, no `{var}`) | §3 row 6 minus trailer | The ext-6.6 memory-overwrite deny |
| 30 | `messages.identicalLoopFail` | `string` (template, `{n}`) | §3 row 8 verbatim | The identical-loop deny — **composed WITHOUT the trailer in code regardless of this template's content** (owner ruling 4; a template embedding trailer text is a content bug, caught by e2e tests) |
| 31 | `messages.chainCapFail` | `string` (template, `{n}` `{cap}`) | §3 row 9 minus trailer | The continuation-chain deny, with the trailer as today |
| 32 | `messages.mcpSkillFail` | `string` (template, `{tool}` `{skill}` `{hint}`) | §3 row 10 minus trailer | The MCP→skill deny; `{hint}` comes from `messages.mcpSkillHints` |
| 33 | `messages.mcpSkillHints` | `Record<skill, string>` | 2 entries (context7-mcp, adb-mcp) | Per-skill usage hints substituted into `{hint}`; ANY skill keys are valid (future skills); a missing key → the hardcoded generic `load it before driving this server` |
| 34 | `messages.descriptionHint` | `string` (template, no `{var}`) | the policy hint verbatim | The one-line hint appended to the first dispatch tool's description at selection time |
| 35 | `primer.mode` | `"default" \| "replace" \| "append"` | `"default"` | `default` → the configured `primer.text` when present, else nothing (the opt-in flip: there is no shipped primer to pin — a bare `primer.text` IS effective); `replace` → `primer.text` verbatim (explicit form, identical outcome); `append` → built-in default + `"\n\n"` + `primer.text` (the built-in default is `""`, so append resolves to just the text) |
| 36 | `primer.text` | `string` | the PRIMER v2 text (canonical setup) | The injected primer content; `""` (the built-in default) = nothing injected. Recommended vehicle for big text: OpenCode's native `{file:~/.config/opencode/primer.txt}` variable substitution — keeps JSON readable and the text diffable |

### 6.3 Validation and failure semantics (owner rulings 2026-11-07 — hybrid)

- **Enforcement groups fail closed per guard** (`dispatch`, `skills`, `gates`,
  `structure`, `caps`, `paths`): an invalid option in a group makes THAT guard deny
  affected calls with a `CONFIG-ERROR` deny naming the option path, e.g.
  `DENIED by dispatch-policy plugin: [config-error] caps.chainMax must be a positive integer or null (got "abc"); guard running with effective cap 1. Fix the plugin options in opencode.json, run \`opencode service restart\`, then re-run this exact call.` + the shared COMPLIANCE WARNING trailer. Other guards are unaffected.
- **Sub-guard granularity (Phase 2)**: `gates.memoryMandatePattern` errors live in
  their own pool — an invalid regex fails **only the ext-6.1 fresh-dispatch
  memory-mandate check** closed (CONFIG-ERROR at the check's own position, after the
  structure check); the base skill/memory gate stays healthy.
  `structure.stitchPromptTools` / `structure.stitchMinPrompt` errors fail **only the
  Stitch surface** closed; `structure.blocks` / profile errors fail the structure
  check on **both** surfaces (fresh dispatches + Stitch).
- **Cross-validation**: `structure.subagentProfile` / `structure.stitchProfile` keys
  must exist in `structure.blocks` — a reference to an unknown block key is a
  validation failure (CONFIG-ERROR naming the profile path).
- **Invalid cap ⇒ effective cap 1 + CONFIG-ERROR deny** — never "guard off". An invalid
  `caps.chainOverrideMarker` fails the chain guard closed for over-cap continuations
  (the one-shot escape cannot be evaluated); under-cap continuations pass normally.
- **Broken-group scoping (post-flip)**: the fail-closed fallback SCOPE of a broken
  group derives from DEFAULTS — which are now EMPTY. A broken group whose shaping
  option is itself broken (`dispatch.tools`, `gates.tools`/`mcpRequirements`/
  `readTargets`, `structure` group shape, `structure.stitchPromptTools`, `paths`)
  therefore covers nothing: that guard is inert and the problem surfaces loudly via
  the config-problems part. Sub-option breakage inside a CONFIGURED group still
  produces the CONFIG-ERROR deny at the guard's own position (the group's configured
  scope defines where the deny fires).
- **Precedence preserved**: bans → gate → MCP gate → structure → memory-mandate →
  counters, with the group's CONFIG-ERROR deny firing at that guard's own position
  (e.g. a zero-state fresh dispatch still receives the normal gate deny, not the
  structure CONFIG-ERROR; a malformed brief receives the structure deny before the
  memory-mandate CONFIG-ERROR).
- **Empty/absent = valid + INERT, no problems** (the opt-in flip — supersedes the
  pre-flip "empty = warned" rulings): every empty list, empty string, `null` cap/floor,
  `false` flag, empty blocks/hints record, and `primer.text: ""` is the intended
  all-off state and produces ZERO problems. Unknown keys anywhere = warn (problem
  recorded) + ignore.
- **A present-but-non-object `options` value** cannot name a group ⇒ every enforcement
  guard fails closed (one problem clause, effective caps 1).
- **Presentation groups fail SOFT** (`messages`, `primer` — Phase 3, owner hybrid §C(c)):
  an invalid entry (wrong type, empty string, unknown `{var}`, invalid `primer.mode`,
  missing/invalid `primer.text` in replace/append) falls back to the **built-in default**
  and records a problem naming the option path — wording problems must never brick
  enforcement. A non-object `messages`/`primer` group is warn + ignored **entirely**
  (all defaults). Unknown keys inside them are warn + ignore like everywhere else.
  Presentation problems surface only through the problems system part — they never
  produce CONFIG-ERROR denies and never mark a guard broken.
- **`{var}` substitution rule (Phase 3)**: each message template accepts exactly the
  placeholders its deny builder substitutes (row 22: none; 23: `{agent}`; 26:
  `{missing}`; 27: `{target}` `{missing}` `{blocks}`; 30: `{n}`; 31: `{n}` `{cap}`;
  32: `{tool}` `{skill}` `{hint}`; 24/25/28/29/33/34: none). A configured template
  referencing anything else is caught at resolve time: fallback to the default template
  + problem (the placeholder would otherwise leak into denies verbatim). Trailer
  presence and the identical-loop no-trailer exception are **code rules**, not template
  content (owner ruling 4).
- **Primer-mode rule (opt-in flip — supersedes the fix-round-1 PR #12 ruling)**: there
  is no shipped primer to pin anymore (the built-in default text is `""`), so the
  DEFAULT mode resolves to the CONFIGURED `primer.text` when present (zero problems),
  else to `""` — nothing injected. `replace` is the explicit form (identical outcome to
  default-with-text; kept for compatibility). `append` composes
  `DEFAULTS.primer.text + "\n\n" + text` — with the empty built-in default it resolves
  to just the text. An explicit `replace`/`append` without a usable text, or an invalid
  mode, falls back to `""` (nothing injected) + problem.
- **Problem surfacing**: every problem (error or warning, enforcement-group pools
  included) is pushed as an additional system text part
  `dispatch-policy config problems: <problems joined by "; ">` AFTER the primer
  position in `session.context`. With zero problems (and a non-empty primer text)
  nothing extra is pushed; with no options NOTHING is pushed at all.

### 6.4 Minimal config example

```jsonc
// ~/.config/opencode/opencode.jsonc (global config; apply = opencode service restart)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/alina/.local/share/opencode-mandator/plugin-package",
      "options": {
        "dispatch": {
          "tools": ["subagent"],
          "forbiddenAgents": ["general"], // universal hygiene — kept
          "requireBackground": true,
          "requireAgent": true
        },
        "skills": {
          "mandatory": [], // no superpowers skills in this install → base gate inert for skills
          "orchestrator": []
        },
        "gates": {
          "tools": ["edit", "write", "shell", "subagent", "webfetch"],
          "exaSubstring": null // no exa MCP here
        },
        "caps": { "identicalMax": 8, "chainMax": 12, "chainOverrideMarker": "[override]" }
      }
    }
  ]
}
```

Omitting `options` entirely (or every option empty) leaves the plugin INERT —
enforcement exists only via explicit configuration. Complete worked examples — the
canonical mandator setup, a minimal-override setup, and a primer-append setup — live in
[`docs/CONFIG-EXAMPLES.md`](CONFIG-EXAMPLES.md).
