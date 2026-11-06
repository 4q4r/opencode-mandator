import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// OpenCode V2 enforcement plugin — wave3-a2 + gate extensions 1-5 (owner decisions).
// Deterministic enforcement of owner dispatch policy; the model cannot forget these.
//
// Layers:
//   1. Deny subagent dispatches with agent:"general" (owner ban) — actionable deny message.
//   2. Require background:true on every subagent dispatch — DENY, never rewrite
//      (the agent must learn the rule; honest failure per owner decision).
//   3. Inject the owner-approved PRIMER as a system text part before every model request.
//   4. Append a one-line policy hint to the subagent tool description (selection-time
//      prevention, layered on top of the interception above).
//   5. Skill gate (ext 1-2): gated tool calls are DENIED until the session invoked
//      `skill` for brainstorming, grilling, build-with-exa. Gated set: edit, write,
//      shell(+bash, apply_patch legacy), subagent, webfetch, websearch, execute
//      (Code Mode — can compose tools.exa.* internally), MCP tools matching /exa/.
//   6. Memory-read prerequisite + orchestrator preflight (ext 3): every gated call
//      additionally requires a completed `read` of ~/.config/opencode/MEMORY.md in
//      this session; subagent dispatches additionally require skills
//      subagent-driven-development + dispatching-parallel-agents +
//      prompt-engineering-patterns (ext 4: dispatch briefs and agent-MCP prompts are
//      prompts) and reads of memory/topics/workflow.md + workflow-git-pr.md. Deny
//      lists exactly what is missing.
//   7. Compliance warning (ext 4): every deny message ends with a declarative
//      warning that output violating the applied skills' requirements is REJECTED,
//      including subagents dispatched with a poorly written brief. This is a
//      deterrent by owner decision — NOT mechanically verified anywhere in this
//      plugin (documented honestly in docs/RULES.md §3).
//   8. Prompt-structure gate (ext 5): the free-text `prompt` of a subagent dispatch
//      must contain the structural blocks mandated by the prompt-engineering-patterns
//      skill (Role / Task / Context / Constraints / Output format); the three Stitch
//      free-text prompt tools get a 4-block profile (no Role). Deterministic
//      keyword-presence check — the honest, checkable subset of "no bad prompts".
//   9. Memory-mandate keyword (ext 6.1): a fresh dispatch brief must mandate reading
//      global memory (owner hard dispatch protocol 2026-10-10) — keyword presence of
//      MEMORY.md / memory/topics / memory/projects / "global memory" / the RU
//      «глобальная память» forms. Continuations (sessionID) exempt. Runs AFTER the
//      structure check (ordering: bans → gate → structure → memory-mandate).
//  10. Memory whole-file overwrite guard (ext 6.6): `write` over an EXISTING file under
//      the home-anchored ~/.config/opencode/memory/ tree (incl. the root MEMORY.md) is
//      DENIED — memory is append-only by anchors, supersede via `edit`; creating NEW
//      memory files passes. Paths are resolved before classification (normalize +
//      containment — fix round 1); existence goes through the _testStat seam (tests stub
//      it; they never touch real files under ~/.config/opencode/). Hygiene backstop, NOT
//      a security boundary: a stat failure allows the call.
//  11. Agent-missing deny (ext 6.7): dispatches with `agent` missing/empty get an
//      actionable deny instead of the generic runtime schema error; the "general" ban
//      still wins for agent === "general".
//  12. Identical-dispatch circuit breaker (ext 6.4): a fresh dispatch identical to an
//      earlier one in the same session (djb2 digest as BUCKET INDEX over agent + NUL +
//      prompt, exact (agent, prompt) comparison inside each bucket — fix round 1,
//      32-bit collisions are real; per-session counters) is DENIED when the count
//      reaches 4 — 3 identical executions pass, the 4th is denied. Runs LAST on the
//      fresh path (after the structure and memory-mandate checks, so compliance-teaching
//      denies keep precedence). The deny deliberately carries NO compliance trailer and
//      NO re-run instruction: re-running is exactly what is being denied.
//  13. Continuation-chain cap (ext 6.3): a continuation of the same child session
//      within one parent session is DENIED when its per-(parent, child) count passes
//      6 — 6 continuations pass, the 7th denies (increment-then-check; denied calls
//      and overrides both increment — the counter tracks reality). Variant A escape
//      (owner approved 2026-10-25): the continuation prompt may carry the marker
//      [chain-cap-override] followed by a non-empty reason (regex
//      /\[chain-cap-override\]\s*\S/i) — a deliberate, visible, one-shot escape with
//      no config involvement. Fresh dispatches never touch this counter. Runs in the
//      DISPATCH_TOOLS branch after the fresh-dispatch inner block, behind the
//      skill/memory gate (compliance-teaching denies keep precedence; a gate deny
//      never consumes the cap). The deny carries the live count, the fresh-agent
//      recovery, the marker instruction, and the shared COMPLIANCE_WARNING trailer
//      (here the re-run advice IS valid — re-run with the marker).
//
// Safety valves:
//   - OPENCODE_ENFORCE_OFF=1 disables all plugin behavior (checked per hook call).
//   - Hooks are scoped strictly to the gated set; `skill` and `read` are never gated
//     (they are the compliance paths).
//   - Failure mode is fail-closed: a broken hook build denies gated calls (observed
//     live during ext 3 — recovery required deleting the file out-of-band; edit
//     live plugin files with ONE atomic write, never multi-edit sequences).
//
// Verified against the installed OpenCode v2.0.27:
//   - Local plugin dirs scanned: ["plugin", "plugins"] (core/src/plugin/source-directory.ts).
//   - Deny-by-throw: core/src/plugin/hooks.ts — "Only tool execute.before may fail:
//     a Tool.Error rejects the call before it runs"; ToolFailures["execute.before"] = Tool.Error.
//   - Dispatch tool is named "subagent" on v2.0.27 (legacy "task" retired 2026-09-16).
//   - Dispatch args {agent, background, prompt, sessionID?}; skill arg {id}; read arg
//     {path} (session DB).
//   - read inputs occur in both absolute and ~/ forms (11 stored ~/ calls).
//   - MCP tools appear under flat "<server>_<tool>" names in execute hooks
//     (verified live in the session DB: exa_web_search_exa, exa_web_fetch_exa), so
//     Stitch tools are stitch_<name>. No live Stitch calls exist yet on this install;
//     names are from the MCP catalog + this convention. If the runtime renames them,
//     the structure check silently never fires (same documented degradation as the
//     tool-description hint for renamed tools).

// PRIMER v2 — owner-approved 2026-11-06 (13 bullets; brief-quality rules, cloakbrowser owner-lock; designed by the prompt-engineering round, sources in /tmp/opencode/mandator-ext6/primer-v2/primer-v2-report.md).
const PRIMER = `[auto-injected operating rules — non-negotiable]
- Before task decisions consult global memory: ~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/* (list what you read). Keep memory live: supersede, never duplicate; subagents never write memory files — send facts to the controller.
- Skills are MANDATORY and fire BEFORE the work: brainstorming before any feature/creative work (produce a bounded spec first, not code); grilling before new features (interview until the spec has no holes; a found hole is a STOP-blocker — resolve with the owner, never guess); build-with-exa for every external fact (Exa primary source); plus ≥2 more skills you pick as relevant to THIS task. In every report list every skill invoked with one line on what it changed — a report without the skill list is incomplete.
- Subagent dispatches: background:true ALWAYS; specialized agent types only — \`general\` is FORBIDDEN; new task = fresh session (never pass sessionID); controller verifies results (git status / real output) — never trust reports blindly.
- Every dispatch brief has five labeled blocks — Role / Task / Context / Constraints / Output format — written for a cold reader with zero session context: objective, exact output shape, tool/source guidance, task boundaries. The brief must also carry the memory mandate (read ~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/*, list what was read), the skill mandate, and the report contract. The plugin denies briefs missing a block — write it right the first time.
- The orchestrator NEVER implements: no edits, builds, gates, or pushes by your own hand — no exceptions, not even mechanical fixes or scripted renames; ALL implementation goes to dispatched subagents. Parallel implementation only with disjoint file scopes or separate worktrees (never two agents on the same output paths).
- Every change: branch → PR → squash-merge; never push main directly; no stash without explicit yes; no deploy/publish without explicit owner word.
- Quality gates run as standalone blocking commands; a failed gate must make merge/push unreachable; never chain gate+release in one \`;\`/\`&&\` command.
- Scratch in /tmp or ~/.opencode/plan/; engagement memory goes to global memory, never ~/ root clutter; kill processes by exact PID only (no pkill/killall by name).
- Deliverable format (file type, layout standard, one vs many artifacts) is an explicit early question — never default it.
- Estimates (time/cost/points) only on explicit request. Chat with owner: Russian. Code/reports: English.
- External facts via Exa; every screenshot/visual → Z.AI Vision MCP; fail loudly — never fake success paths. cloakbrowser MCP is OWNER-LOCKED: every invocation MUST pass humanize=True and human_preset=careful — no exceptions; all other parameters at your discretion.
- [skill gate] This session's plugin ENFORCES the skill mandate: edit/write/bash/subagent-dispatch/web/execute calls are DENIED until \`skill\` has been invoked for brainstorming, grilling, and build-with-exa in this session. If denied: invoke the three skills, then re-run your call unchanged.
- [skill gate: memory + orchestrator] Every gated call additionally requires a \`read\` of ~/.config/opencode/MEMORY.md in this session; before dispatching ANY subagent, the session must ALSO have loaded skills \`subagent-driven-development\` + \`dispatching-parallel-agents\` + \`prompt-engineering-patterns\` and read ~/.config/opencode/memory/topics/workflow.md + workflow-git-pr.md. Deny messages list exactly what is missing — comply, then re-run your call unchanged.`

const DISPATCH_TOOLS = new Set(["subagent"])
const FORBIDDEN_AGENT = "general"

// --- Skill gate (wave3-a2 gate extensions 1-3; owner decisions Q1-Q4 + ext3) ---
// Any GATED tool call is DENIED until the session meets the prerequisites. Global
// (all projects/sessions/roles); only escape is OPENCODE_ENFORCE_OFF=1. Gated names
// verified against the live v2.0.27 session DB:
//   edit/write (live), shell (live bash-class; 52k calls, last 2026-10-14),
//   bash/apply_patch (legacy defensive inclusions; bash last 2026-09-16,
//   apply_patch last 2026-08-28; multiedit/patch never existed on this install),
//   subagent (dispatch), webfetch/websearch (built-in web), execute (Code Mode —
//   can compose tools.exa.* internally: bypass surface, owner decision; 4477 live
//   calls, last 2026-10-14), plus substring "exa"
//   for MCP exa tools (live: exa_web_search_exa, exa_web_fetch_exa).
const GATED_TOOLS = new Set([
  "edit",
  "write",
  "shell",
  "bash",
  "apply_patch",
  "subagent",
  "webfetch",
  "websearch",
  "execute",
])

const MANDATORY_SKILLS = ["brainstorming", "grilling", "build-with-exa"] as const

// --- Gate extension 3: memory-read verification + orchestrator dispatch preflight ---
// Base gate prerequisite: root MEMORY.md read in this session (owner-accepted proxy
// for "memory consulted"). Dispatch gate (subagent only) additionally requires the
// orchestrator skills and reads of both workflow memory files.
//
// prompt-engineering-patterns (ext 4, owner decision 2026-10-24): dispatch briefs
// (subagent prompts) and agent-MCP prompts are prompts — the orchestrator must apply
// prompt-engineering patterns when writing them.
const ORCHESTRATOR_SKILLS = [
  "subagent-driven-development",
  "dispatching-parallel-agents",
  "prompt-engineering-patterns",
] as const

// Read targets are matched by suffix after ~-expansion; both absolute and ~ forms
// occur in real read calls (11 stored ~/ calls verified in the session DB).
const MEMORY_READ_SUFFIX = ".config/opencode/MEMORY.md"
const READ_TARGETS: ReadonlyArray<[string, string]> = [
  ["memory", MEMORY_READ_SUFFIX],
  ["workflow", ".config/opencode/memory/topics/workflow.md"],
  ["workflow-git-pr", ".config/opencode/memory/topics/workflow-git-pr.md"],
]

// --- Gate extension 5: deterministic prompt-structure check (owner decision) ---
// Source of truth: the prompt-engineering-patterns skill — references/system-prompts.md
// ("Effective System Prompt Structure": [Role Definition] + [Expertise Areas] +
// [Behavioral Guidelines] + [Output Format] + [Constraints]) and the template library
// (every generation template carries Task / Context / Requirements / Constraints /
// Output). The check is keyword-presence per block, tolerant to header forms
// ("## Task", "**Task:**", "Task:") and to Russian block names; it is the honest,
// deterministic subset of "no bad prompts" — it cannot judge content quality, only
// structure (the COMPLIANCE WARNING covers the rest).
type BlockKey = "role" | "task" | "context" | "constraints" | "output"
const BLOCKS: Record<BlockKey, { name: string; re: RegExp }> = {
  role: { name: "Role", re: /(you are|your role|role\s*:|acting as|роль\s*:)/i },
  task: { name: "Task", re: /(tasks?\b|objectives?\b|goals?\b|mission\b|задач|цель)/i },
  context: { name: "Context", re: /(contexts?\b|background\b|контекст)/i },
  constraints: {
    name: "Constraints",
    re: /(constraints?\b|requirements?\b|guidelines?\b|rules?\b|\bmust\b|do not|don't|avoid|never|forbidden|требован|ограничен|правил|запрещ)/i,
  },
  output: {
    name: "Output format",
    re: /(output format|response format|expected output|deliverable|reports?\b|formats?\b|includes?\b|отч[её]т|формат)/i,
  },
}
// Subagent brief: all five blocks (a full prompt to an LLM agent).
const SUBAGENT_PROFILE: ReadonlyArray<BlockKey> = ["role", "task", "context", "constraints", "output"]
// Stitch generation prompts: four blocks — no Role (the tool's role is fixed by the
// design tool itself; forcing "You are..." into a screen prompt would be artificial).
const STITCH_PROFILE: ReadonlyArray<BlockKey> = ["task", "context", "constraints", "output"]
// Free-text `prompt: string` (Required) inputs, verified in the Stitch MCP catalog:
//   stitch_generate_screen_from_text — "The input text to generate the screen from"
//   stitch_edit_screens              — "The input text to generate the screen from"
//   stitch_generate_variants         — "The input text used to generate the variants"
// Other Stitch surfaces are deliberately exempt (owner decision — "don't block
// commands where arbitrary text cannot be entered"):
//   - IDs/enums/flags tools (get_project, list_*, download_file, apply_design_system, …);
//   - create_project.title (a short label, not a prompt);
//   - designMd / styleGuidelines on create/update_design_system (design-spec genre —
//     a token/style document, not a task prompt; the block profile does not fit);
//   - upload_design_md (base64 file upload).
const STITCH_PROMPT_TOOLS = new Set([
  "stitch_generate_screen_from_text",
  "stitch_edit_screens",
  "stitch_generate_variants",
])
// Short prompts pass the structure check: the Stitch tools themselves recommend
// re-calling with an accepted suggestion verbatim (e.g. "Yes, make them all") —
// tactical follow-ups must keep flowing. A structured generation brief is
// naturally longer than this floor.
const STITCH_MIN_PROMPT = 120

function missingBlocks(prompt: string, profile: ReadonlyArray<BlockKey>): string[] {
  return profile.filter((key) => !BLOCKS[key].re.test(prompt)).map((key) => BLOCKS[key].name)
}

// --- ext 6.1: memory-mandate keyword in fresh dispatch briefs (owner hard dispatch
// protocol 2026-10-10: every subagent brief must instruct the subagent to read global
// memory and list what it read). Keyword presence — the same honest subset philosophy
// as ext 5. Regex per the ext-6 analyst sketch with one deliberate correction: JS `\w`
// is ASCII-only and cannot carry the Cyrillic tail of «глобальную», so the RU forms
// would never match; `\p{L}` under the `u` flag is required (pinned by the RU test).
const MEMORY_MANDATE_RE =
  /(MEMORY\.md|memory\/(topics|projects)|глобальн\p{L}*\s+пам(ять|яти)|global memory)/iu

// `~` and `~/`-prefixed paths are expanded against the real home directory; both forms
// occur in real traffic (11 stored ~/ read calls verified in the session DB). Shared by
// classifyRead (ext 3 recording) and the ext 6.6 write guard.
function expandTilde(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

function classifyRead(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined
  const s = expandTilde(p)
  for (const [target, suffix] of READ_TARGETS) {
    if (s === suffix || s.endsWith("/" + suffix)) return target
  }
  return undefined
}

// ext 6.6 (fix round 1): global memory targets — the memory tree (topics/, projects/) and the
// root MEMORY.md index. Matching is normalize + home-anchored containment: the previous
// substring/ends-with match had (a) a BYPASS — absolute dot-segment paths like
// ~/.config/opencode/./MEMORY.md matched no pattern, so a whole-file write over the real
// MEMORY.md slipped past the guard — and (b) FALSE POSITIVES — /tmp/.config/opencode/memory/…
// counted as memory though the documented target is the GLOBAL tree. Canonical rule: the path
// resolves to exactly the home-anchored root MEMORY.md, or lands inside the home-anchored
// memory tree (path.relative semantics: relative === "" or not ".."-prefixed and not
// absolute). Case-sensitive by design (Linux install).
const MEMORY_INDEX_PATH = path.resolve(os.homedir(), ".config", "opencode", "MEMORY.md")
const MEMORY_TREE_PATH = path.resolve(os.homedir(), ".config", "opencode", "memory")

function isGlobalMemoryPath(p: string): boolean {
  const resolved = path.resolve(p)
  if (resolved === MEMORY_INDEX_PATH) return true
  const rel = path.relative(MEMORY_TREE_PATH, resolved)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

// ext 6.6 test seam (fix round 1): production default is existsSync wrapped in try/catch
// (fail-open). Tests must NEVER create or modify real files under ~/.config/opencode/ —
// they stub _testStat.fn per test (existing → true; missing → false; throwing → the
// guard's fail-open path) and restore it in afterEach.
export const _testStat = {
  fn: (p: string): boolean => {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  },
}

// Per-session compliance state; cleared on server restart (fail-closed: sessions
// re-gate after a restart) and on every plugin hot-reload (setup re-runs). Only
// completed `skill` and `read` executions are recorded (execute.after with status
// "completed"), so failed invocations never count.
const loadedSkills = new Map<string, Set<string>>()
const readTargets = new Map<string, Set<string>>()

// ext 6.4: per-session identical-dispatch state —
// Map<parentSessionID, Map<digest-bucket, BucketPair[]>>. Fix round 1 (PR #5 CodeRabbit
// finding): the 32-bit djb2 digest is a BUCKET INDEX only — collisions are real, so each
// bucket stores the exact (agent, prompt) pairs it has seen and they are compared for
// identity BEFORE incrementing; a different pair in the same bucket gets its own counter
// instead of merging into another pair's count. Sits beside the gate Maps at module scope
// with the same fail-closed restart/hot-reload semantics (cleared when the process
// restarts or the plugin reloads). Fresh dispatches only: continuations (input.sessionID
// present) are exempt — they are governed by the ext-6.3 continuation-chain cap
// (layer 13 below).
type BucketPair = { agent: string; prompt: string; count: number }
const dispatchHashCount = new Map<string, Map<string, BucketPair[]>>()

// ext 6.3: per-session continuation-chain state —
// Map<parentSessionID, Map<childSessionID, count>>. Sits beside the other Maps at
// module scope with the same fail-closed restart/hot-reload semantics (cleared when
// the process restarts or the plugin reloads). Continuations only (input.sessionID
// present): fresh dispatches never touch this counter. Accepted growth class: one
// inner Map per parent session that continued at least one child, one small-integer
// entry per distinct continued child — bounded by live sessions × continued children
// for the process lifetime; identical shape and lifetime to dispatchHashCount.
const continuationChainCount = new Map<string, Map<string, number>>()

// djb2 (32-bit), inline per the ext-6.4 spec — no new imports. Returns an unsigned
// decimal string so the digest can key the counter Map directly.
function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h >>> 0)
}

// ext 6.4 test seam (fix round 1): the breaker's djb2 digest, exposed in the same
// object-with-fn style as _testStat (one seam convention). Production default is the
// real hash; the collision-independence tests CALL it to brute-force a real 32-bit
// collision pair (never stubbed — no behavior is faked through this seam).
export const _djb2 = { fn: djb2 }

function isGatedTool(tool: string): boolean {
  if (GATED_TOOLS.has(tool)) return true
  if (tool.includes("exa")) return true // MCP exa tools appear as exa_<...>_exa
  return false
}

function markRead(sessionID: string, target: string): void {
  let set = readTargets.get(sessionID)
  if (!set) {
    set = new Set()
    readTargets.set(sessionID, set)
  }
  set.add(target)
}

// Returns exactly what a gated call is missing, human-readable, for the deny message.
function gateMissing(sessionID: string, dispatch: boolean): string[] {
  const missing: string[] = []
  const loaded = loadedSkills.get(sessionID)
  const reads = readTargets.get(sessionID)
  for (const skill of MANDATORY_SKILLS) if (!loaded?.has(skill)) missing.push(`skill "${skill}"`)
  if (!reads?.has("memory")) missing.push("read of ~/.config/opencode/MEMORY.md")
  if (dispatch) {
    for (const skill of ORCHESTRATOR_SKILLS) if (!loaded?.has(skill)) missing.push(`skill "${skill}"`)
    if (!reads?.has("workflow")) missing.push("read of ~/.config/opencode/memory/topics/workflow.md")
    if (!reads?.has("workflow-git-pr")) missing.push("read of ~/.config/opencode/memory/topics/workflow-git-pr.md")
  }
  return missing
}

// Declarative compliance warning (ext 4, owner decision — "пугалка"): appended to
// every deny message. It claims output is audited and skill violations — including
// badly written subagent briefs — are REJECTED. NO hook in this plugin performs that
// audit; the warning is a behavioral deterrent only (the owner accepts the mismatch;
// docs/RULES.md §3 documents it honestly). Owner rationale: models that believe
// non-compliance is caught comply with the loaded skills' requirements more readily.
const COMPLIANCE_WARNING =
  " COMPLIANCE WARNING: all output is audited against the requirements of the skills applied in this " +
  "session — work that violates them is REJECTED and must be redone. This explicitly covers dispatches: " +
  "a subagent sent with a poorly written brief (violating prompt-engineering requirements — vague task, " +
  "missing context/constraints, no report contract) will be REJECTED and must be re-dispatched."

const DENY_GENERAL =
  'DENIED by dispatch-policy plugin: agent type "general" is FORBIDDEN by owner mandate. ' +
  "Re-dispatch with a specialized agent type — e.g. code-reviewer, backend-architect, " +
  "frontend-developer, trend-researcher (full list: opencode debug agents)." +
  COMPLIANCE_WARNING

const DENY_BACKGROUND =
  "DENIED by dispatch-policy plugin: owner mandate requires background:true on every subagent " +
  "dispatch. Re-dispatch the SAME call with background:true." +
  COMPLIANCE_WARNING

// ext 6.7: actionable deny for missing/empty agent (runtime would only produce the
// generic schema error "Invalid arguments … agent: Missing key" — no policy guidance).
const DENY_AGENT_MISSING =
  "DENIED by dispatch-policy plugin: the dispatch is missing a specialized agent type " +
  "(agent missing or empty). Pick a specialized agent type — e.g. backend-architect, " +
  "code-reviewer, frontend-developer, trend-researcher (full list: opencode debug agents) — " +
  "then re-run this exact call." +
  COMPLIANCE_WARNING

// ext 6.1: fresh dispatch brief never instructs the subagent to read global memory.
const DENY_MEMORY_MANDATE =
  "DENIED by dispatch-policy plugin: the dispatch brief does not mandate reading global memory " +
  "(owner hard dispatch protocol: every subagent brief must instruct the subagent to read " +
  "~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/* and list what it read " +
  "in its report). Add the memory mandate to the brief, then re-run this exact call." +
  COMPLIANCE_WARNING

// ext 6.6: whole-file `write` over an existing global memory file (last-writer-wins
// rewrites destroyed memory entries in the 2026-10-09/10 incidents).
const DENY_MEMORY_OVERWRITE =
  "DENIED by dispatch-policy plugin: whole-file write over an EXISTING global memory file is " +
  "forbidden — whole-file rewrites of memory race concurrent agents (2026-10-09/10 incidents). " +
  "Append or supersede the entry via the `edit` tool instead (append-only by anchors; " +
  "supersede-in-place, never full-file write). Creating a NEW memory file is allowed." +
  COMPLIANCE_WARNING

// ext 6.4: identical-dispatch circuit breaker — increment-then-check per session; the
// deny fires when the count of identical fresh dispatches (same agent + prompt) reaches
// IDENTICAL_CAP (3 identical executions pass, the 4th is denied). Owner approved 2026-10-25.
const IDENTICAL_CAP = 4

// Deliberate deltas vs the analyst sketch, owner decision (ext-6.4 brief): this deny
// carries NO COMPLIANCE_WARNING trailer (its "must be re-dispatched" wording contradicts
// the guard) and NO "re-run this exact call" instruction (re-running is exactly what is
// being denied). The deny is FINAL for identical resends: differentiate the briefs or
// escalate. It is the plugin's only deny without the shared trailer (docs/RULES.md §3).
function denyIdenticalLoop(n: number): string {
  return (
    `DENIED by dispatch-policy plugin: identical dispatch sent ${n} times in this session — ` +
    "runaway-loop guard on identical (agent, prompt) pairs. This deny is final for identical " +
    "resends: differentiate the briefs (per-perspective prompts) or escalate to the owner."
  )
}

// ext 6.3: continuation-chain cap — increment-then-check per (parent session, child
// session) pair; the deny fires when a child's continuation count passes CHAIN_CAP
// (6 continuations pass, the 7th is denied). Denied calls still increment, and
// Variant A overrides still increment: the counter tracks reality. Owner approved
// 2026-10-25 (Variant A: constant cap + visible one-shot escape, no config knob).
const CHAIN_CAP = 6

// Variant A escape (owner requirement 2026-10-25: adjustable without config edits): a
// continuation that would exceed the cap is ALLOWED iff the prompt carries the marker
// followed by a NON-EMPTY reason — a bare marker does not unlock.
const CHAIN_OVERRIDE_RE = /\[chain-cap-override\]\s*\S/i

// Unlike denyIdenticalLoop, this deny carries the COMPLIANCE_WARNING trailer and the
// re-run instruction — here the re-run advice IS valid: re-running with the added
// marker is exactly the sanctioned one-shot escape, alongside the primary recovery
// (start a FRESH agent; the persistent-worker anti-pattern, owner bans 2026-09-20 /
// PR97 / PR111).
function denyContinuationChain(n: number): string {
  return (
    `DENIED by dispatch-policy plugin: this child-session continuation chain reached ${n} ` +
    `continuations in one session (cap ${CHAIN_CAP}) — persistent-worker pumping of one child ` +
    "session is the anti-pattern the owner bans (2026-09-20; PR97/PR111). Start a FRESH agent " +
    "instead and hand off state via a git branch + a structured brief. To continue once beyond " +
    "the cap deliberately, add [chain-cap-override] <reason> to the continuation prompt, then " +
    "re-run this exact call." +
    COMPLIANCE_WARNING
  )
}

function denyStructure(target: string, missing: string[], profile: ReadonlyArray<BlockKey>): string {
  const guide = profile.map((key) => BLOCKS[key].name).join(" / ")
  return (
    `DENIED by dispatch-policy plugin: prompt-structure check (per the prompt-engineering-patterns ` +
    `skill) on the ${target} prompt failed. Missing required block(s): ${missing.join("; ")}. ` +
    `Structure the prompt with explicit blocks: ${guide}. Then re-run this exact call.` +
    COMPLIANCE_WARNING
  )
}

const DESCRIPTION_HINT =
  "\n\nPOLICY (enforced by the dispatch-policy plugin): every dispatch MUST pass " +
  'background:true; agent type "general" is FORBIDDEN — pick a specialized agent type.'

function enforcementDisabled(): boolean {
  return process.env.OPENCODE_ENFORCE_OFF === "1"
}

export default Plugin.define({
  id: "dispatch-policy",
  async setup(ctx) {
    // Layers 1+2: intercept subagent dispatches before execution.
    await ctx.tool.hook("execute.before", (event) => {
      if (enforcementDisabled()) return
      const input = (event.input ?? {}) as Record<string, unknown>
      if (DISPATCH_TOOLS.has(event.tool)) {
        // ext 6.7: actionable deny for missing/empty agent, BEFORE the general ban —
        // the message teaches agent selection. "general" is a non-empty string, so the
        // ban below still wins for agent === "general".
        if (typeof input.agent !== "string" || input.agent.trim() === "") throw new Error(DENY_AGENT_MISSING)
        if (input.agent === FORBIDDEN_AGENT) throw new Error(DENY_GENERAL)
        if (input.background !== true) throw new Error(DENY_BACKGROUND)
      }
      // Skill + memory gate: gated actions wait until this session loaded the
      // mandatory skills and read root MEMORY.md; dispatches additionally need the
      // orchestrator preflight. Deny lists exactly what is missing.
      if (isGatedTool(event.tool)) {
        const missing = gateMissing(event.sessionID, DISPATCH_TOOLS.has(event.tool))
        if (missing.length > 0) {
          throw new Error(
            "Owner mandate: this action requires, in this session first: " +
              missing.join("; ") +
              ". Load skills via the `skill` tool (one call per skill); read memory files with the `read` tool. Then re-run this exact call." +
              COMPLIANCE_WARNING,
          )
        }
      }
      // Ext 5: prompt-structure gate — AFTER the skill gate (compliance first: the
      // orchestrator loads prompt-engineering-patterns, THEN the brief is checked).
      // Subagent: every fresh dispatch must carry a structured brief; continuations
      // (sessionID present) are exempt — the original dispatch already passed.
      if (DISPATCH_TOOLS.has(event.tool)) {
        if (input.sessionID === undefined) {
          const prompt = typeof input.prompt === "string" ? input.prompt : ""
          const missing = missingBlocks(prompt, SUBAGENT_PROFILE)
          if (missing.length > 0) {
            const prefix = prompt === "" ? "The dispatch prompt is missing or empty. " : ""
            throw new Error(prefix + denyStructure("subagent dispatch", missing, SUBAGENT_PROFILE))
          }
          // ext 6.1: fresh briefs must mandate reading global memory — AFTER the
          // structure check (ordering: bans → skill/memory gate → structure →
          // memory-mandate). Continuations (sessionID present) are exempt: the original
          // dispatch already passed.
          if (!MEMORY_MANDATE_RE.test(prompt)) throw new Error(DENY_MEMORY_MANDATE)
          // ext 6.4: identical-dispatch circuit breaker — LAST check on the fresh path,
          // after the structure and memory-mandate checks (compliance-teaching denies
          // keep precedence: a loop of malformed briefs keeps receiving the structure
          // deny, which is the correct lesson). Increment-then-check per session:
          // 3 identical executions pass, the 4th identical dispatch is denied. Different
          // (agent, prompt) pairs never share a counter; continuations never reach this
          // branch (sessionID present → exempt, governed by the ext-6.3 cap below).
          let perSessionCounts = dispatchHashCount.get(event.sessionID)
          if (!perSessionCounts) {
            perSessionCounts = new Map()
            dispatchHashCount.set(event.sessionID, perSessionCounts)
          }
          const dispatchAgent = String(input.agent)
          const identicalDigest = _djb2.fn(`${dispatchAgent}\u0000${prompt}`)
          // Fix round 1: digest = bucket index; identity = exact (agent, prompt) strings.
          // Linear scan of a bucket is fine — dispatch volume per session is small.
          let bucket = perSessionCounts.get(identicalDigest)
          if (!bucket) {
            bucket = []
            perSessionCounts.set(identicalDigest, bucket)
          }
          let pair = bucket.find((e) => e.agent === dispatchAgent && e.prompt === prompt)
          if (!pair) {
            pair = { agent: dispatchAgent, prompt, count: 0 }
            bucket.push(pair)
          }
          // Increment-then-check, unchanged: a denied dispatch still counts.
          pair.count += 1
          if (pair.count >= IDENTICAL_CAP) throw new Error(denyIdenticalLoop(pair.count))
        } else {
          // ext 6.3: continuation-chain cap — CONTINUATIONS only (input.sessionID
          // present), after the fresh-dispatch inner block. Bans and the skill/memory
          // gate have already passed (compliance-teaching denies keep precedence: a
          // gate deny throws before this branch and never consumes the cap). Fresh
          // dispatches never reach this branch — they have the ext-6.4 breaker above.
          const prompt = typeof input.prompt === "string" ? input.prompt : ""
          let perChildCounts = continuationChainCount.get(event.sessionID)
          if (!perChildCounts) {
            perChildCounts = new Map()
            continuationChainCount.set(event.sessionID, perChildCounts)
          }
          const childID = String(input.sessionID)
          // Increment-then-check on every continuation dispatch that reaches this
          // check — a denied continuation still counts, and an override still
          // increments: the counter tracks reality (overrides neither reset nor lift
          // the cap).
          const count = (perChildCounts.get(childID) ?? 0) + 1
          perChildCounts.set(childID, count)
          if (count > CHAIN_CAP && !CHAIN_OVERRIDE_RE.test(prompt)) {
            throw new Error(denyContinuationChain(count))
          }
        }
      } else if (STITCH_PROMPT_TOOLS.has(event.tool)) {
        const prompt = typeof input.prompt === "string" ? input.prompt : ""
        if (prompt.length >= STITCH_MIN_PROMPT) {
          const missing = missingBlocks(prompt, STITCH_PROFILE)
          if (missing.length > 0) {
            throw new Error(denyStructure(`MCP tool "${event.tool}"`, missing, STITCH_PROFILE))
          }
        }
      } else if (event.tool === "write") {
        // ext 6.6: whole-file `write` over an EXISTING global memory file (incl. the
        // root MEMORY.md) is denied — memory is append-only by anchors, supersede via
        // `edit`; creating NEW memory files passes. Runs after the skill gate (the gate
        // already covers `write`). Runtime `write` input key is `path`; legacy stored
        // calls used `filePath` — check BOTH, prefer `path`. The path is resolved BEFORE
        // classification so dot/dot-dot segments cannot dodge the guard (fix round 1).
        // Hygiene backstop, not a security boundary: a stat failure ALLOWS the call.
        // Existence goes through the _testStat seam — production default is
        // existsSync-with-fail-open; tests stub it and never touch the real home tree.
        const raw =
          typeof input.path === "string" && input.path !== ""
            ? input.path
            : typeof input.filePath === "string"
              ? input.filePath
              : undefined
        if (raw !== undefined) {
          const p = path.resolve(expandTilde(raw))
          if (isGlobalMemoryPath(p)) {
            let exists = false
            try {
              exists = _testStat.fn(p)
            } catch {
              exists = false // stat failure → allow (documented fail-open hygiene backstop)
            }
            if (exists) throw new Error(DENY_MEMORY_OVERWRITE)
          }
        }
      }
    })

    // Layer 4: policy hint at tool-selection time. Missing tool IDs are ignored
    // by the editor (documented behavior), so a rename degrades to layers 1-3 only.
    await ctx.tool.transform((editor) => {
      if (enforcementDisabled()) return
      editor.update("subagent", (tool) => {
        tool.description = tool.description + DESCRIPTION_HINT
      })
    })

    // Compliance recording: a completed `skill` execution marks that skill as
    // loaded; a completed `read` of a tracked memory file marks it as read.
    // execute.after exposes status, so failed invocations never count. Neither
    // tool is gated, so recording cannot be blocked by the gate.
    await ctx.tool.hook("execute.after", (event) => {
      if (enforcementDisabled()) return
      if (event.status !== "completed") return
      const input = (event.input ?? {}) as Record<string, unknown>
      if (event.tool === "skill") {
        const skillID = typeof input.id === "string" ? input.id : undefined
        if (!skillID) return
        let loaded = loadedSkills.get(event.sessionID)
        if (!loaded) {
          loaded = new Set()
          loadedSkills.set(event.sessionID, loaded)
        }
        loaded.add(skillID)
        return
      }
      if (event.tool === "read") {
        const target = classifyRead(input.path)
        if (target) markRead(event.sessionID, target)
      }
    })

    // Layer 3: PRIMER as a system text part before every agent model request
    // (survives compaction automatically — system parts are reassembled per request).
    await ctx.session.hook("context", (event) => {
      if (enforcementDisabled()) return
      event.system.push({ type: "text", text: PRIMER })
    })
  },
})
