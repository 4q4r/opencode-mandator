import { Plugin } from "@opencode/plugin"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  DEFAULTS,
  buildBlocks,
  buildChainOverrideRe,
  buildMemoryMandateRe,
  fill,
  type BlockKey,
} from "./defaults.ts"

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
//   5. Skill gate (ext 1-2 + 7.1): gated tool calls are DENIED until the session invoked
//      `skill` for brainstorming, grilling, build-with-exa, context7-mcp. Gated set:
//      edit, write, shell(+bash, apply_patch legacy), subagent, webfetch, websearch,
//      execute (Code Mode — can compose tools.exa.* internally), MCP tools matching
//      /exa/, plus MCP tools with a skill requirement (layer 14 prefixes).
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
//  14. MCP→skill gate (ext 7.1): an MCP tool whose server has a related skill is DENIED
//      until that skill is loaded in the session. DEFAULTS.gates.mcpRequirements matches by
//      PREFIX on the flat MCP tool name (V2 convention "<server>_<tool>", unsupported
//      chars → "_": server "adb-mcp" → prefix "adb_mcp_"; the context7 tools are
//      "context7_resolve_library_id" / "context7_query_docs"). The prefixes also extend
//      the gated set (layer 5), so a zero-state MCP call receives the BASE deny — the
//      MCP-specific message fires only on top of a base-complete session, keeping
//      compliance-teaching denies first. Check site: inside the gated-call flow, AFTER
//      the base skill/memory gate, BEFORE the ext-5 structure chain. Honest note: the
//      "context7" entry cannot fire while context7-mcp is mandatory (the base gate
//      already requires it for every gated call) — kept for message specificity +
//      future-proofing if the mandatory set ever changes; the live enforcement of this
//      gate is the "adb_mcp" entry. No mappings for the five skill-less MCP servers
//      (zai-mcp-server, cloakbrowser, stitch, ssh-any, circumvention-corpus) —
//      docs/BACKLOG.md.
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

// PRIMER v2 (owner-approved 2026-11-06, 13 bullets; ext-7.1 sync 2026-11-07) lives
// byte-identical in DEFAULTS.primer.text (defaults.ts).
const PRIMER = DEFAULTS.primer.text

const DISPATCH_TOOLS = new Set(DEFAULTS.dispatch.tools)
const FORBIDDEN_AGENT = DEFAULTS.dispatch.forbiddenAgents[0]

// --- Skill gate (wave3-a2 gate extensions 1-3; owner decisions Q1-Q4 + ext3) ---
// Any GATED tool call is DENIED until the session meets the prerequisites. Global
// (all projects/sessions/roles); only escape is OPENCODE_ENFORCE_OFF=1. The gated tool
// names (with their live-DB verification notes) live in DEFAULTS.gates.tools.
const GATED_TOOLS = new Set(DEFAULTS.gates.tools)

// ext 7.1 (owner decision "каждого агента", 2026-11-07): context7-mcp joins the
// mandatory set — see DEFAULTS.skills.mandatory.
const MANDATORY_SKILLS = DEFAULTS.skills.mandatory

// --- Gate extension 3: memory-read verification + orchestrator dispatch preflight ---
// Base gate prerequisite: root MEMORY.md read in this session (owner-accepted proxy
// for "memory consulted"). Dispatch gate (subagent only) additionally requires the
// orchestrator skills and reads of both workflow memory files.
const ORCHESTRATOR_SKILLS = DEFAULTS.skills.orchestrator

// Read-target keys/suffixes live in DEFAULTS.gates.readTargets (suffix match after
// ~-expansion; both absolute and ~ forms occur in real read calls — 11 stored ~/ calls
// verified in the session DB). Demand strings in gateMissing derive from the suffixes.
const READ_TARGET_SUFFIX: Record<string, string> = Object.fromEntries(
  DEFAULTS.gates.readTargets.map((target) => [target.key, target.suffix]),
)

// --- Gate extension 5: deterministic prompt-structure check (owner decision) ---
// Source of truth: the prompt-engineering-patterns skill — references/system-prompts.md
// ("Effective System Prompt Structure": [Role Definition] + [Expertise Areas] +
// [Behavioral Guidelines] + [Output Format] + [Constraints]) and the template library
// (every generation template carries Task / Context / Requirements / Constraints /
// Output). The check is keyword-presence per block, tolerant to header forms
// ("## Task", "**Task:**", "Task:") and to Russian block names; it is the honest,
// deterministic subset of "no bad prompts" — it cannot judge content quality, only
// structure (the COMPLIANCE WARNING covers the rest). Block vocabulary, matchers
// (compiled from DEFAULTS.structure.blocks pattern sources with the original flag "i"),
// profiles, and their rationale live in DEFAULTS.structure.
const BLOCKS = buildBlocks(DEFAULTS.structure.blocks)
const SUBAGENT_PROFILE: ReadonlyArray<BlockKey> = DEFAULTS.structure.subagentProfile
const STITCH_PROFILE: ReadonlyArray<BlockKey> = DEFAULTS.structure.stitchProfile
// Stitch free-text prompt tools + the 120-char length floor live in
// DEFAULTS.structure.stitchPromptTools / stitchMinPrompt.
const STITCH_PROMPT_TOOLS = new Set(DEFAULTS.structure.stitchPromptTools)
const STITCH_MIN_PROMPT = DEFAULTS.structure.stitchMinPrompt

function missingBlocks(prompt: string, profile: ReadonlyArray<BlockKey>): string[] {
  return profile.filter((key) => !BLOCKS[key].re.test(prompt)).map((key) => BLOCKS[key].name)
}

// --- ext 6.1: memory-mandate keyword in fresh dispatch briefs (owner hard dispatch
// protocol 2026-10-10) — the pattern source lives in
// DEFAULTS.gates.memoryMandatePattern, compiled with the original flags "iu" (the
// `\p{L}`-under-`u` requirement for the RU forms is documented at the builder).
const MEMORY_MANDATE_RE = buildMemoryMandateRe(DEFAULTS.gates.memoryMandatePattern)

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
  for (const target of DEFAULTS.gates.readTargets) {
    if (s === target.suffix || s.endsWith("/" + target.suffix)) return target.key
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
const MEMORY_INDEX_PATH = expandTilde(DEFAULTS.paths.memoryIndex)
const MEMORY_TREE_PATH = expandTilde(DEFAULTS.paths.memoryTree)

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
  if (tool.includes(DEFAULTS.gates.exaSubstring)) return true // MCP exa tools appear as exa_<...>_exa
  // ext 7.1: MCP servers with a skill requirement are gated tools — the base gate
  // teaches the full mandatory list at zero state; the MCP-specific gate (below) layers
  // the per-server requirement on top of a base-complete session.
  if (DEFAULTS.gates.mcpRequirements.some((req) => tool.startsWith(req.prefix))) return true
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
  if (!reads?.has("memory")) missing.push(`read of ~/${READ_TARGET_SUFFIX.memory}`)
  if (dispatch) {
    for (const skill of ORCHESTRATOR_SKILLS) if (!loaded?.has(skill)) missing.push(`skill "${skill}"`)
    if (!reads?.has("workflow")) missing.push(`read of ~/${READ_TARGET_SUFFIX.workflow}`)
    if (!reads?.has("workflow-git-pr")) missing.push(`read of ~/${READ_TARGET_SUFFIX["workflow-git-pr"]}`)
  }
  return missing
}

// Declarative compliance warning (ext 4, owner decision — "пугалка"): appended to every
// deny message. Wording lives in DEFAULTS.messages.complianceWarning (including the
// honesty note: NO hook audits output — deterrent only, docs/RULES.md §3); the trailer's
// PRESENCE on every deny except the identical-loop deny is fixed in code (§E).
const COMPLIANCE_WARNING = DEFAULTS.messages.complianceWarning

// ext 6.7 / row-3 ban: the general-ban deny names the banned agent ({agent} template).
function denyGeneral(agent: string): string {
  return fill(DEFAULTS.messages.generalBan, { agent }) + COMPLIANCE_WARNING
}

const DENY_BACKGROUND = DEFAULTS.messages.backgroundBan + COMPLIANCE_WARNING

// ext 6.7: actionable deny for missing/empty agent (runtime would only produce the
// generic schema error "Invalid arguments … agent: Missing key" — no policy guidance).
const DENY_AGENT_MISSING = DEFAULTS.messages.agentMissing + COMPLIANCE_WARNING

// ext 6.1: fresh dispatch brief never instructs the subagent to read global memory.
const DENY_MEMORY_MANDATE = DEFAULTS.messages.memoryMandateFail + COMPLIANCE_WARNING

// ext 6.6: whole-file `write` over an existing global memory file (last-writer-wins
// rewrites destroyed memory entries in the 2026-10-09/10 incidents).
const DENY_MEMORY_OVERWRITE = DEFAULTS.messages.memoryOverwriteFail + COMPLIANCE_WARNING

// ext 7.1: per-skill usage hint in the MCP→skill deny; an unmapped skill gets the
// generic hint. Hints live in DEFAULTS.messages.mcpSkillHints.
function mcpSkillHint(skill: string): string {
  return (DEFAULTS.messages.mcpSkillHints as Record<string, string>)[skill] ?? "load it before driving this server"
}

function denyMcpSkill(tool: string, skill: string): string {
  return (
    fill(DEFAULTS.messages.mcpSkillFail, { tool, skill, hint: mcpSkillHint(skill) }) +
    COMPLIANCE_WARNING
  )
}

// ext 6.4: identical-dispatch circuit breaker — increment-then-check per session; the
// deny fires when the count of identical fresh dispatches (same agent + prompt) reaches
// IDENTICAL_CAP (3 identical executions pass, the 4th is denied). Owner approved 2026-10-25.
const IDENTICAL_CAP = DEFAULTS.caps.identicalMax

// Deliberate deltas vs the analyst sketch, owner decision (ext-6.4 brief): this deny
// carries NO COMPLIANCE_WARNING trailer (its "must be re-dispatched" wording contradicts
// the guard) and NO "re-run this exact call" instruction (re-running is exactly what is
// being denied). The deny is FINAL for identical resends: differentiate the briefs or
// escalate. It is the plugin's only deny without the shared trailer (docs/RULES.md §3) —
// the no-trailer rule is enforced HERE, not by template content.
function denyIdenticalLoop(n: number): string {
  return fill(DEFAULTS.messages.identicalLoopFail, { n: String(n) })
}

// ext 6.3: continuation-chain cap — increment-then-check per (parent session, child
// session) pair; the deny fires when a child's continuation count passes CHAIN_CAP
// (6 continuations pass, the 7th is denied). Denied calls still increment, and
// Variant A overrides still increment: the counter tracks reality. Owner approved
// 2026-10-25 (Variant A: constant cap + visible one-shot escape, no config knob).
const CHAIN_CAP = DEFAULTS.caps.chainMax

// Variant A escape (owner requirement 2026-10-25: adjustable without config edits): a
// continuation that would exceed the cap is ALLOWED iff the prompt carries the marker
// followed by a NON-EMPTY reason — a bare marker does not unlock. Compiled from
// DEFAULTS.caps.chainOverrideMarker.
const CHAIN_OVERRIDE_RE = buildChainOverrideRe(DEFAULTS.caps.chainOverrideMarker)

// Unlike denyIdenticalLoop, this deny carries the COMPLIANCE_WARNING trailer and the
// re-run instruction — here the re-run advice IS valid: re-running with the added
// marker is exactly the sanctioned one-shot escape, alongside the primary recovery
// (start a FRESH agent; the persistent-worker anti-pattern, owner bans 2026-09-20 /
// PR97 / PR111).
function denyContinuationChain(n: number): string {
  return (
    fill(DEFAULTS.messages.chainCapFail, { n: String(n), cap: String(CHAIN_CAP) }) +
    COMPLIANCE_WARNING
  )
}

function denyStructure(target: string, missing: string[], profile: ReadonlyArray<BlockKey>): string {
  const guide = profile.map((key) => BLOCKS[key].name).join(" / ")
  return (
    fill(DEFAULTS.messages.structureFail, {
      target,
      missing: missing.join("; "),
      blocks: guide,
    }) + COMPLIANCE_WARNING
  )
}

const DESCRIPTION_HINT = DEFAULTS.messages.descriptionHint

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
        if (input.agent === FORBIDDEN_AGENT) throw new Error(denyGeneral(input.agent))
        if (input.background !== true) throw new Error(DENY_BACKGROUND)
      }
      // Skill + memory gate: gated actions wait until this session loaded the
      // mandatory skills and read root MEMORY.md; dispatches additionally need the
      // orchestrator preflight. Deny lists exactly what is missing.
      if (isGatedTool(event.tool)) {
        const missing = gateMissing(event.sessionID, DISPATCH_TOOLS.has(event.tool))
        if (missing.length > 0) {
          throw new Error(
            fill(DEFAULTS.messages.gateMissing, { missing: missing.join("; ") }) + COMPLIANCE_WARNING,
          )
        }
        // ext 7.1: MCP→skill gate — AFTER the base skill/memory gate, BEFORE the ext-5
        // structure chain. A base-complete session driving an MCP tool without its
        // related skill gets the per-server deny with the usage hint. (A zero-state MCP
        // call never reaches this loop: the base deny above keeps precedence and already
        // lists context7-mcp among the mandatory skills.)
        for (const { prefix, skill } of DEFAULTS.gates.mcpRequirements) {
          if (event.tool.startsWith(prefix) && !loadedSkills.get(event.sessionID)?.has(skill)) {
            throw new Error(denyMcpSkill(event.tool, skill))
          }
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
      editor.update(DEFAULTS.dispatch.tools[0], (tool) => {
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
