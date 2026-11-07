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
} from "./defaults.ts"
import { resolveOptions } from "./config.ts"

// OpenCode V2 enforcement plugin — wave3-a2 + gate extensions 1-5 (owner decisions).
// Deterministic enforcement of owner dispatch policy; the model cannot forget these.
//
// Flexibility Phase 1 (owner-approved, 2026-11-07): 11 enforcement knobs are resolved
// per-setup from ctx.options via src/config.ts (hybrid failure semantics: an invalid
// option fails THAT guard closed with a CONFIG-ERROR deny naming the option path;
// invalid caps mean effective cap 1; empty skill lists are valid + warned; unknown keys
// are warn + ignore; `null` caps turn the guard off). Flexibility Phase 2
// (owner-approved, 2026-11-07) wires the remaining enforcement-surface options (+10;
// 26 total): gates.mcpRequirements / gates.readTargets / gates.memoryMandatePattern,
// structure.blocks (invalid regex ⇒ that structure guard fails closed with a
// CONFIG-ERROR naming the path) / structure.subagentProfile / structure.stitchProfile
// (cross-validated against blocks) / structure.stitchPromptTools / structure.stitchMinPrompt,
// paths.memoryIndex / paths.memoryTree. Flexibility Phase 3 (owner-approved,
// 2026-11-07) wires the PRESENTATION groups (+15; 36 total — the taxonomy is
// complete): messages.* (13 deny/description templates consumed by the deny builders
// via fill(); an unknown {var} ⇒ fallback to the default template + problem) and
// primer.mode/text ("default" → DEFAULTS.primer.text verbatim; "replace" → configured
// text verbatim; "append" → default + "\n\n" + configured). Presentation problems are
// warn-class; the identical-loop deny stays trailer-less REGARDLESS of configuration
// (code rule, owner ruling 4). With NO options the resolved config is
// byte-identical to the pre-migration hardcodes — the baseline test suite is the
// parity contract. Config problems surface as a system text part AFTER the PRIMER.
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
//      DISPATCH_TOOLS branch (the resolved dispatch scope) after the fresh-dispatch inner block, behind the
//      skill/memory gate (compliance-teaching denies keep precedence; a gate deny
//      never consumes the cap). The deny carries the live count, the fresh-agent
//      recovery, the marker instruction, and the shared COMPLIANCE_WARNING trailer
//      (here the re-run advice IS valid — re-run with the marker).
//  14. MCP→skill gate (ext 7.1): an MCP tool whose server has a related skill is DENIED
//      until that skill is loaded in the session. gates.mcpRequirements (a Phase-2
//      option; defaults to today's table) matches by
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

// Flexibility Phase 1: the dispatch/gate/cap guard PARAMETERS resolve per-setup from
// ctx.options (src/config.ts, hybrid failure semantics per owner rulings 2026-11-07).
// The DEFAULT-derived sets below exist ONLY as the fail-closed fallback SCOPE for a
// broken group (design §C(c)): when a group's options are invalid, the guard still
// scopes its CONFIG-ERROR denies at the calls the default config would have covered —
// it never silently widens or narrows the affected surface.
// Flexibility Phase 3: the PRESENTATION groups (messages/primer) resolve per-setup as
// well — the deny builders live inside setup() and close over CFG.messages, and the
// context hook injects CFG.primer.text (the FINAL text after primer-mode resolution).
// Presentation fallbacks are warn-class (CONFIG_PROBLEMS); enforcement is unaffected.
//
// OPT-IN ENFORCEMENT FLIP (owner decision "Empty defaults, setup in JSON",
// 2026-11-07 — supersedes the Phase 0-3 zero-change premise): empty/absent options make
// the plugin COMPLETELY INERT — no gates, no denies, no primer injection, no
// description hint, no config problems. DEFAULTS is the all-off config; the owner setup
// lives as explicit configuration (canonical snapshot:
// tests/fixtures/mandator-setup.json → the owner's opencode.json). Every guard runs
// ONLY when its configuration makes it meaningful:
//   dispatch bans          — forbiddenAgents non-empty; requireAgent/requireBackground true
//   base skill gate        — the gated set (gates.tools + exaSubstring non-empty +
//                            mcpRequirements prefixes) is non-empty
//   orchestrator preflight — skills.orchestrator non-empty (via gateMissing)
//   structure checks       — the profile is non-empty; the stitch surface additionally
//                            needs stitchPromptTools non-empty and stitchMinPrompt non-null
//   memory-mandate         — gates.memoryMandatePattern non-empty
//   breakers               — caps.identicalMax / caps.chainMax non-null
//   memory-overwrite       — paths.memoryIndex AND paths.memoryTree non-empty
//   MCP→skill gate         — per gates.mcpRequirements entries
// A firing guard whose deny template is "" still DENIES: the deny text falls back to
// the hardcoded GENERIC_DENY line (CONFIG-ERROR-style, below). CONFIG-ERROR denies
// remain hardcoded (they report the config itself — never configurable). The
// broken-group fail-closed SCOPE constants (DEFAULT_*) now derive from the empty
// DEFAULTS: a broken group whose SHAPING option is itself broken covers nothing (the
// guard is inert + the problem surfaces loudly via CONFIG_PROBLEMS); sub-option
// breakage inside a configured group still CONFIG-ERRORs at the guard's position.
const DEFAULT_DISPATCH_TOOLS = new Set(DEFAULTS.dispatch.tools)

// ext 7.1: MCP→skill requirements — an MCP tool may not be driven without its related
// skill. Flexibility Phase 2: the prefix table is a per-setup option (gates.mcpRequirements,
// resolved inside setup; per-skill hints live in messages.mcpSkillHints — a Phase-3
// option keyed by skillId, an unknown skill gets the generic hint). The
// DEFAULT-derived table below is the broken-group fallback scope only (broken-group
// scoping: a broken gates group still scopes its CONFIG-ERROR denies at the calls the
// default config would have covered).
const DEFAULT_MCP_REQUIREMENTS = DEFAULTS.gates.mcpRequirements

// --- Skill gate (wave3-a2 gate extensions 1-3; owner decisions Q1-Q4 + ext3) ---
// Any GATED tool call is DENIED until the session meets the prerequisites. Global
// (all projects/sessions/roles); only escape is OPENCODE_ENFORCE_OFF=1. The gated tool
// names (with their live-DB verification notes) live in DEFAULTS.gates.tools; the
// Phase-1 option gates.tools overrides the exact-match set per setup (see isGatedTool
// inside setup). The DEFAULT-derived set below is the broken-group fallback scope only.
const DEFAULT_GATED_TOOLS = new Set(DEFAULTS.gates.tools)

// ext 7.1 (owner decision "каждого агента", 2026-11-07): context7-mcp joins the
// mandatory set — see DEFAULTS.skills.mandatory. Phase 1: skills.mandatory /
// skills.orchestrator are per-setup options (resolved inside setup); empty lists are
// valid + warned and make the respective requirement inert (owner ruling 2026-11-07).

// --- Gate extension 3: memory-read verification + orchestrator dispatch preflight ---
// Base gate prerequisite: the "memory"-keyed read target read in this session
// (owner-accepted proxy for "memory consulted"). Dispatch gate (subagent only)
// additionally requires the orchestrator skills (ext 4: dispatch briefs and agent-MCP
// prompts are prompts) and reads of every non-memory read target. Flexibility Phase 2:
// the read-target table is a per-setup option (gates.readTargets, resolved inside
// setup) — the base gate demands the "memory" key, the dispatch path demands the rest.
// The DEFAULT-derived table below is the broken-group fallback scope only.
const DEFAULT_READ_TARGETS = DEFAULTS.gates.readTargets

// --- Gate extension 5: deterministic prompt-structure check (owner decision) ---
// Source of truth: the prompt-engineering-patterns skill — references/system-prompts.md
// ("Effective System Prompt Structure": [Role Definition] + [Expertise Areas] +
// [Behavioral Guidelines] + [Output Format] + [Constraints]) and the template library
// (every generation template carries Task / Context / Requirements / Constraints /
// Output). The check is keyword-presence per block, tolerant to header forms
// ("## Task", "**Task:**", "Task:") and to Russian block names; it is the honest,
// deterministic subset of "no bad prompts" — it cannot judge content quality, only
// structure (the COMPLIANCE WARNING covers the rest). Flexibility Phase 2: the block
// vocabulary (structure.blocks — pattern sources compiled per setup), both profiles,
// the Stitch tool surface, and the length floor are per-setup options (resolved inside
// setup, cross-validated by the resolver). The DEFAULT-derived set below is the
// broken-group fallback scope only (broken-group scoping: a broken structure/stitch
// guard still scopes its CONFIG-ERROR denies at the calls the default config would
// have covered).
const DEFAULT_STITCH_TOOLS = new Set(DEFAULTS.structure.stitchPromptTools)

// `~` and `~/`-prefixed paths are expanded against the real home directory; both forms
// occur in real traffic (11 stored ~/ read calls verified in the session DB). Shared by
// classifyRead (ext 3 recording) and the ext 6.6 write guard.
function expandTilde(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

// ext 3 recording: classify a read call's path against the RESOLVED read-target table
// (suffix match after ~-expansion; both absolute and ~ forms occur in real read calls —
// 11 stored ~/ calls verified in the session DB).
function classifyRead(
  p: unknown,
  targets: ReadonlyArray<{ key: string; suffix: string }>,
): string | undefined {
  if (typeof p !== "string" || !p) return undefined
  const s = expandTilde(p)
  for (const target of targets) {
    if (s === target.suffix || s.endsWith("/" + target.suffix)) return target.key
  }
  return undefined
}

// ext 6.6 (fix round 1): global memory targets — the memory tree (topics/, projects/)
// and the root memory index. Matching is normalize + home-anchored containment: the
// previous substring/ends-with match had (a) a BYPASS — absolute dot-segment paths like
// ~/.config/opencode/./MEMORY.md matched no pattern, so a whole-file write over the real
// MEMORY.md slipped past the guard — and (b) FALSE POSITIVES — /tmp/.config/opencode/memory/…
// counted as memory though the documented target is the GLOBAL tree. Canonical rule: the path
// resolves to exactly the home-anchored index path, or lands inside the home-anchored
// memory tree (path.relative semantics: relative === "" or not ".."-prefixed and not
// absolute). Case-sensitive by design (Linux install). Flexibility Phase 2: both paths
// are per-setup options (paths.memoryIndex / paths.memoryTree, resolved inside setup);
// the DEFAULT-derived constants below are the broken-group fallback scope only.
const DEFAULT_MEMORY_INDEX_PATH = expandTilde(DEFAULTS.paths.memoryIndex)
const DEFAULT_MEMORY_TREE_PATH = expandTilde(DEFAULTS.paths.memoryTree)

function isGlobalMemoryPath(p: string, indexPath: string, treePath: string): boolean {
  const resolved = path.resolve(p)
  if (resolved === indexPath) return true
  const rel = path.relative(treePath, resolved)
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

// Phase-1 per-guard config state lives inside setup() (resolved from ctx.options);
// isGatedTool is defined there too — it needs the resolved gates scope.

function markRead(sessionID: string, target: string): void {
  let set = readTargets.get(sessionID)
  if (!set) {
    set = new Set()
    readTargets.set(sessionID, set)
  }
  set.add(target)
}

// Returns exactly what a gated call is missing, human-readable, for the deny message.
// The skill lists and the read-target table are the resolved per-setup options
// (defaults keep today's behavior). Base gate: the mandatory skills + the "memory"-keyed
// read target; dispatch path: the orchestrator skills + every other read target.
function gateMissing(
  sessionID: string,
  dispatch: boolean,
  mandatory: readonly string[],
  orchestrator: readonly string[],
  targets: ReadonlyArray<{ key: string; suffix: string }>,
): string[] {
  const missing: string[] = []
  const loaded = loadedSkills.get(sessionID)
  const reads = readTargets.get(sessionID)
  for (const skill of mandatory) if (!loaded?.has(skill)) missing.push(`skill "${skill}"`)
  const base = targets.find((t) => t.key === "memory")
  const rest = targets.filter((t) => t.key !== "memory")
  if (base && !reads?.has("memory")) missing.push(`read of ~/${base.suffix}`)
  if (dispatch) {
    for (const skill of orchestrator) if (!loaded?.has(skill)) missing.push(`skill "${skill}"`)
    for (const target of rest) if (!reads?.has(target.key)) missing.push(`read of ~/${target.suffix}`)
  }
  return missing
}

// ext 5: block-presence scan (pure logic — the deny wording is a resolved template).
function missingBlocks(
  prompt: string,
  profile: ReadonlyArray<string>,
  blocks: Record<string, { name: string; re: RegExp }>,
): string[] {
  return profile.filter((key) => !blocks[key]?.re.test(prompt)).map((key) => blocks[key]!.name)
}

function enforcementDisabled(): boolean {
  return process.env.OPENCODE_ENFORCE_OFF === "1"
}

export default Plugin.define({
  id: "dispatch-policy",
  async setup(ctx) {
    // Flexibility Phase 1: resolve the enforcement knobs from ctx.options (absent ⇒
    // pure defaults — the path the file-discovery install and the whole baseline suite
    // exercise; design §C "zero options ⇒ defaults, zero problems"). CONFIG_PROBLEMS
    // (errors + warnings) surface as a system text part AFTER the PRIMER; the per-guard
    // error subsets drive the CONFIG-ERROR denies below.
    const { resolved: CFG, problems: CONFIG_PROBLEMS } = resolveOptions(
      (ctx as { options?: unknown } | undefined)?.options ?? {},
    )

    // Flexibility Phase 3: presentation groups — the deny builders close over the
    // RESOLVED templates (CFG.messages) instead of DEFAULTS; primer injection uses
    // CFG.primer.text (the FINAL text after primer-mode resolution). Presentation
    // fallbacks are warn-class (they surface via CONFIG_PROBLEMS); enforcement is
    // never affected by wording problems.
    const MSG = CFG.messages

    // Declarative compliance warning (ext 4, owner decision — "пугалка"): appended to
    // every deny message. Wording is messages.complianceWarning (Phase-3 template);
    // the trailer's PRESENCE on every deny except the identical-loop deny is fixed in
    // code (design §E-4) — a configured template cannot remove it. Empty by default:
    // a default-config deny (if one ever fires) carries no trailer.
    const COMPLIANCE_WARNING = MSG.complianceWarning

    // Hardcoded generic deny line (opt-in flip): a firing guard whose deny template is
    // "" still DENIES — the text falls back to this CONFIG-ERROR-style line. Hardcoded
    // by design: it teaches the config recovery and is never configurable.
    const GENERIC_DENY =
      "DENIED by dispatch-policy plugin: this action violates the configured dispatch policy; " +
      "the deny template for this guard is not configured. Fix the plugin options in opencode.json, " +
      "run `opencode service restart`, then re-run this exact call."

    // Empty template ⇒ the hardcoded generic line; otherwise the filled template.
    function rendered(template: string, filled: string): string {
      return template === "" ? GENERIC_DENY : filled
    }

    // Row-3 ban: the general-ban deny names the banned agent ({agent} template).
    function denyGeneral(agent: string): string {
      return rendered(MSG.generalBan, fill(MSG.generalBan, { agent })) + COMPLIANCE_WARNING
    }

    const DENY_BACKGROUND = rendered(MSG.backgroundBan, MSG.backgroundBan) + COMPLIANCE_WARNING

    // ext 6.7: actionable deny for missing/empty agent (runtime would only produce the
    // generic schema error "Invalid arguments … agent: Missing key" — no policy guidance).
    const DENY_AGENT_MISSING = rendered(MSG.agentMissing, MSG.agentMissing) + COMPLIANCE_WARNING

    // ext 6.1: fresh dispatch brief never instructs the subagent to read global memory.
    const DENY_MEMORY_MANDATE = rendered(MSG.memoryMandateFail, MSG.memoryMandateFail) + COMPLIANCE_WARNING

    // ext 6.6: whole-file `write` over an existing global memory file (last-writer-wins
    // rewrites destroyed memory entries in the 2026-10-09/10 incidents).
    const DENY_MEMORY_OVERWRITE = rendered(MSG.memoryOverwriteFail, MSG.memoryOverwriteFail) + COMPLIANCE_WARNING

    // ext 7.1: per-skill usage hint in the MCP→skill deny; an unmapped skill gets the
    // hardcoded generic hint (messages.mcpSkillHints is the configured hint table).
    function mcpSkillHint(skill: string): string {
      return MSG.mcpSkillHints[skill] ?? "load it before driving this server"
    }

    function denyMcpSkill(tool: string, skill: string): string {
      return (
        rendered(MSG.mcpSkillFail, fill(MSG.mcpSkillFail, { tool, skill, hint: mcpSkillHint(skill) })) +
        COMPLIANCE_WARNING
      )
    }

    // Row-3 gate deny: names exactly what is missing ({missing} template).
    function denyGateMissing(missing: string[]): string {
      return rendered(MSG.gateMissing, fill(MSG.gateMissing, { missing: missing.join("; ") })) + COMPLIANCE_WARNING
    }

    // ext 6.4 deny — deliberately trailer-less REGARDLESS of configuration (owner
    // ruling 4 / design §E-8): this deny carries NO COMPLIANCE_WARNING trailer (its
    // "must be re-dispatched" wording contradicts the guard) and NO "re-run this exact
    // call" instruction (re-running is exactly what is being denied). The no-trailer
    // rule is enforced HERE, in code — never by template content (a template that
    // embeds trailer text is a content bug, caught by the e2e parity tests).
    function denyIdenticalLoop(n: number): string {
      return rendered(MSG.identicalLoopFail, fill(MSG.identicalLoopFail, { n: String(n) }))
    }

    // ext 6.3 deny — unlike denyIdenticalLoop, this one DOES carry the trailer and the
    // re-run instruction: re-running with the added marker is exactly the sanctioned
    // one-shot escape, alongside the primary recovery (start a FRESH agent; the
    // persistent-worker anti-pattern, owner bans 2026-09-20 / PR97 / PR111).
    function denyContinuationChain(n: number, cap: number): string {
      return rendered(MSG.chainCapFail, fill(MSG.chainCapFail, { n: String(n), cap: String(cap) })) + COMPLIANCE_WARNING
    }

    // ext 5 deny — the empty-prompt prefix is composed by the CALLER (hardcoded code
    // rule, design §A #27), not part of the template.
    function denyStructure(
      target: string,
      missing: string[],
      profile: ReadonlyArray<string>,
      blocks: Record<string, { name: string; re: RegExp }>,
    ): string {
      const guide = profile.map((key) => blocks[key]!.name).join(" / ")
      return (
        rendered(
          MSG.structureFail,
          fill(MSG.structureFail, {
            target,
            missing: missing.join("; "),
            blocks: guide,
          }),
        ) + COMPLIANCE_WARNING
      )
    }

    // Layer 4: the one-line policy hint appended to the dispatch tool description.
    const DESCRIPTION_HINT = MSG.descriptionHint

    const dispatchBroken = CFG.dispatch.problems.length > 0
    const dispatchScope = dispatchBroken ? DEFAULT_DISPATCH_TOOLS : new Set(CFG.dispatch.tools)
    const forbiddenAgents = CFG.dispatch.forbiddenAgents
    const gatesBroken = CFG.gates.problems.length > 0
    const gatedScope = gatesBroken ? DEFAULT_GATED_TOOLS : new Set(CFG.gates.tools)
    const exaSubstring = gatesBroken ? DEFAULTS.gates.exaSubstring : CFG.gates.exaSubstring
    // Phase 2: the MCP prefix table + read targets resolve per-setup; when the gates
    // group is broken they fall back to the DEFAULT tables (broken-group scoping — the
    // CONFIG-ERROR deny fires before any of these values is used for a decision).
    const mcpRequirements = gatesBroken ? DEFAULT_MCP_REQUIREMENTS : CFG.gates.mcpRequirements
    const readTargetTable = gatesBroken ? DEFAULT_READ_TARGETS : CFG.gates.readTargets
    // ext 6.1 sub-guard: an invalid gates.memoryMandatePattern fails ONLY the fresh
    // dispatch memory-mandate check closed (its own CONFIG-ERROR at its own position);
    // the base skill/memory gate stays healthy. Empty pattern = the check is OFF
    // (opt-in flip) — memoryMandateRe null without any problem.
    const memoryMandateBroken = CFG.gates.memoryMandateProblems.length > 0
    const memoryMandateRe = memoryMandateBroken
      ? null
      : CFG.gates.memoryMandatePattern === ""
        ? null
        : buildMemoryMandateRe(CFG.gates.memoryMandatePattern)
    // Phase 2: structure group — blocks/profiles errors break the structure check for
    // BOTH surfaces (fresh dispatches + Stitch); stitch-knob errors break only the
    // Stitch surface. A broken guard denies at its own position (compliance-teaching
    // denies keep precedence) and never falls back to unvalidated passing.
    const structureBroken = CFG.structure.problems.length > 0
    const stitchBroken = CFG.structure.stitchProblems.length > 0
    const blocks = structureBroken ? null : buildBlocks(CFG.structure.blocks)
    const subagentProfile = CFG.structure.subagentProfile
    const stitchProfile = CFG.structure.stitchProfile
    const stitchScope = stitchBroken ? DEFAULT_STITCH_TOOLS : new Set(CFG.structure.stitchPromptTools)
    const stitchMinPrompt = CFG.structure.stitchMinPrompt
    // Phase 2: paths group — an invalid path fails the ext-6.6 memory-overwrite guard
    // closed, scoped at the calls the DEFAULT topology would have covered.
    const pathsBroken = CFG.paths.problems.length > 0
    const memoryIndexPath = expandTilde(CFG.paths.memoryIndex)
    const memoryTreePath = expandTilde(CFG.paths.memoryTree)
    // Invalid cap ⇒ effective cap 1 (owner ruling); valid `null` ⇒ guard off. Empty
    // marker = VALID and means NO escape marker is accepted (opt-in flip): the escape
    // regex is not built at all, so an over-cap continuation can never unlock.
    const identicalCap = CFG.caps.identicalProblems.length > 0 ? 1 : CFG.caps.identicalMax
    const chainCap = CFG.caps.chainMaxProblems.length > 0 ? 1 : CFG.caps.chainMax
    const chainOverrideRe =
      CFG.caps.chainOverrideMarker === "" ? null : buildChainOverrideRe(CFG.caps.chainOverrideMarker)

    // CONFIG-ERROR deny (§C(c)): names the failing option path(s) verbatim, teaches the
    // recovery (fix opencode.json + `opencode service restart` + re-run), and carries the
    // shared trailer per the every-deny-except-the-identical-loop convention (§3).
    function denyConfigError(groupProblems: readonly string[]): string {
      return (
        "DENIED by dispatch-policy plugin: [config-error] " +
        groupProblems.join("; ") +
        ". Fix the plugin options in opencode.json, run `opencode service restart`, then re-run this exact call." +
        COMPLIANCE_WARNING
      )
    }

    // Gated-set predicate over the RESOLVED gates config (Phase 1 knobs gates.tools +
    // gates.exaSubstring; Phase 2 knob gates.mcpRequirements — the prefix table). When
    // the gates group is broken the scope falls back to the DEFAULT sets so the
    // CONFIG-ERROR deny still hits exactly the formerly-gated calls (§C(c)).
    function isGatedTool(tool: string): boolean {
      if (gatedScope.has(tool)) return true
      if (exaSubstring !== null && exaSubstring !== "" && tool.includes(exaSubstring)) return true // MCP exa tools appear as exa_<...>_exa; "" = rule off (opt-in flip)
      // ext 7.1: MCP servers with a skill requirement are gated tools — the base gate
      // teaches the full mandatory list at zero state; the MCP-specific gate (below) layers
      // the per-server requirement on top of a base-complete session.
      if (mcpRequirements.some((req) => tool.startsWith(req.prefix))) return true
      return false
    }

    // Layers 1+2: intercept subagent dispatches before execution.
    await ctx.tool.hook("execute.before", (event) => {
      if (enforcementDisabled()) return
      const input = (event.input ?? {}) as Record<string, unknown>
      if (dispatchScope.has(event.tool)) {
        // §C(c): a broken dispatch guard denies affected calls BEFORE evaluating any
        // ban — the ban parameters themselves may be the broken values.
        if (dispatchBroken) throw new Error(denyConfigError(CFG.dispatch.problems))
        // ext 6.7: actionable deny for missing/empty agent, BEFORE the general ban —
        // the message teaches agent selection. "general" is a non-empty string, so the
        // ban below still wins for agent === "general". requireAgent=false (option)
        // disables this deny (layer 2 inert, design §A #4).
        if (CFG.dispatch.requireAgent && (typeof input.agent !== "string" || input.agent.trim() === ""))
          throw new Error(DENY_AGENT_MISSING)
        // Phase 1: forbiddenAgents is a LIST — deny when the agent matches ANY entry.
        if (typeof input.agent === "string" && forbiddenAgents.includes(input.agent))
          throw new Error(denyGeneral(input.agent))
        if (CFG.dispatch.requireBackground && input.background !== true) throw new Error(DENY_BACKGROUND)
      }
      // Skill + memory gate: gated actions wait until this session loaded the
      // mandatory skills and read root MEMORY.md; dispatches additionally need the
      // orchestrator preflight. Deny lists exactly what is missing.
      if (isGatedTool(event.tool)) {
        // §C(c): a broken skills/gates group denies gated calls with the CONFIG-ERROR
        // naming the failing paths — the compliance prerequisites cannot be evaluated
        // against untrusted parameters. (Dispatch bans above keep precedence.)
        const gateConfigProblems = [...CFG.skills.problems, ...CFG.gates.problems]
        if (gateConfigProblems.length > 0) throw new Error(denyConfigError(gateConfigProblems))
        const missing = gateMissing(
          event.sessionID,
          dispatchScope.has(event.tool),
          CFG.skills.mandatory,
          CFG.skills.orchestrator,
          readTargetTable,
        )
        if (missing.length > 0) {
          throw new Error(denyGateMissing(missing))
        }
        // ext 7.1: MCP→skill gate — AFTER the base skill/memory gate, BEFORE the ext-5
        // structure chain. A base-complete session driving an MCP tool without its
        // related skill gets the per-server deny with the usage hint. (A zero-state MCP
        // call never reaches this loop: the base deny above keeps precedence and already
        // lists the mandatory skills.) Phase 2: the table is the resolved
        // gates.mcpRequirements option; per-skill hints stay keyed by skillId.
        for (const { prefix, skill } of mcpRequirements) {
          if (event.tool.startsWith(prefix) && !loadedSkills.get(event.sessionID)?.has(skill)) {
            throw new Error(denyMcpSkill(event.tool, skill))
          }
        }
      }
      // Ext 5: prompt-structure gate — AFTER the skill gate (compliance first: the
      // orchestrator loads prompt-engineering-patterns, THEN the brief is checked).
      // Subagent: every fresh dispatch must carry a structured brief; continuations
      // (sessionID present) are exempt — the original dispatch already passed.
      if (dispatchScope.has(event.tool)) {
        if (input.sessionID === undefined) {
          const prompt = typeof input.prompt === "string" ? input.prompt : ""
          // §C(c) Phase 2: a broken structure guard denies at its own position (after
          // the gate, before memory-mandate) — the check cannot run, so nothing passes
          // unvalidated. Zero-state calls still receive the normal gate deny above.
          if (structureBroken || blocks === null) throw new Error(denyConfigError(CFG.structure.problems))
          const missing = missingBlocks(prompt, subagentProfile, blocks)
          if (missing.length > 0) {
            const prefix = prompt === "" ? "The dispatch prompt is missing or empty. " : ""
            throw new Error(prefix + denyStructure("subagent dispatch", missing, subagentProfile, blocks))
          }
          // ext 6.1: fresh briefs must mandate reading global memory — AFTER the
          // structure check (ordering: bans → skill/memory gate → structure →
          // memory-mandate). Continuations (sessionID present) are exempt: the original
          // dispatch already passed. Opt-in flip: an empty pattern means the check is
          // OFF (skip); an INVALID pattern still fails ONLY this check closed (its own
          // CONFIG-ERROR at its own position).
          if (memoryMandateBroken) throw new Error(denyConfigError(CFG.gates.memoryMandateProblems))
          if (memoryMandateRe !== null && !memoryMandateRe.test(prompt)) throw new Error(DENY_MEMORY_MANDATE)
          // ext 6.4: identical-dispatch circuit breaker — LAST check on the fresh path,
          // after the structure and memory-mandate checks (compliance-teaching denies
          // keep precedence: a loop of malformed briefs keeps receiving the structure
          // deny, which is the correct lesson). Increment-then-check per session:
          // 3 identical executions pass, the 4th identical dispatch is denied. Different
          // (agent, prompt) pairs never share a counter; continuations never reach this
          // branch (sessionID present → exempt, governed by the ext-6.3 cap below).
          // Opt-in flip: the whole breaker (state included) runs only when
          // caps.identicalMax is non-null — with the cap off no counter is kept.
          if (identicalCap !== null) {
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
            // Increment-then-check, unchanged: a denied dispatch still counts. Against
            // the RESOLVED cap — an invalid value means effective cap 1 with the
            // CONFIG-ERROR deny (compliance-teaching denies above keep precedence: the
            // structure and memory-mandate checks still run first).
            pair.count += 1
            if (pair.count >= identicalCap) {
              throw new Error(
                CFG.caps.identicalProblems.length > 0
                  ? denyConfigError(CFG.caps.identicalProblems)
                  : denyIdenticalLoop(pair.count),
              )
            }
          }
        } else {
          // ext 6.3: continuation-chain cap — CONTINUATIONS only (input.sessionID
          // present), after the fresh-dispatch inner block. Bans and the skill/memory
          // gate have already passed (compliance-teaching denies keep precedence: a
          // gate deny throws before this branch and never consumes the cap). Fresh
          // dispatches never reach this branch — they have the ext-6.4 breaker above.
          // Opt-in flip: the whole cap (state included) runs only when caps.chainMax
          // is non-null — with the cap off no counter is kept.
          if (chainCap !== null) {
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
            // Against the RESOLVED cap — an invalid value means effective cap 1 with
            // the CONFIG-ERROR deny. An invalid marker also fails this guard closed:
            // the one-shot escape cannot be evaluated, so an over-cap continuation is
            // denied with the CONFIG-ERROR naming the marker path instead of silently
            // allowing or denying unteachably. A VALID EMPTY marker (opt-in flip) means
            // no escape marker is accepted: chainOverrideRe is null and every
            // over-cap continuation denies — with the normal chain deny (no escape).
            if (count > chainCap) {
              if (CFG.caps.chainMaxProblems.length > 0) throw new Error(denyConfigError(CFG.caps.chainMaxProblems))
              if (CFG.caps.markerProblems.length > 0) throw new Error(denyConfigError(CFG.caps.markerProblems))
              if (chainOverrideRe === null || !chainOverrideRe.test(prompt))
                throw new Error(denyContinuationChain(count, chainCap))
            }
          }
        }
      } else if (stitchScope.has(event.tool)) {
        // §C(c) Phase 2: broken structure blocks/profiles fail BOTH surfaces closed;
        // broken stitch knobs (tools list / floor) fail only this surface. The combined
        // CONFIG-ERROR names every failing path.
        const stitchConfigProblems = [...CFG.structure.problems, ...CFG.structure.stitchProblems]
        if (stitchConfigProblems.length > 0 || blocks === null)
          throw new Error(denyConfigError(stitchConfigProblems))
        const prompt = typeof input.prompt === "string" ? input.prompt : ""
        // Opt-in flip: stitchMinPrompt null = the floor is off (the check never fires);
        // an empty stitchProfile yields no missing blocks (vacuous pass) either way.
        if (stitchMinPrompt !== null && prompt.length >= stitchMinPrompt) {
          const missing = missingBlocks(prompt, stitchProfile, blocks)
          if (missing.length > 0) {
            throw new Error(denyStructure(`MCP tool "${event.tool}"`, missing, stitchProfile, blocks))
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
          // §C(c) Phase 2: a broken paths guard CONFIG-ERRORs on the calls the DEFAULT
          // topology would have covered (broken-group scoping — the broken values are
          // never used to widen or narrow the surface); other writes pass.
          if (pathsBroken) {
            if (isGlobalMemoryPath(p, DEFAULT_MEMORY_INDEX_PATH, DEFAULT_MEMORY_TREE_PATH)) {
              throw new Error(denyConfigError(CFG.paths.problems))
            }
          } else if (
            memoryIndexPath !== "" &&
            memoryTreePath !== "" && // opt-in flip: either path empty = overwrite guard off
            isGlobalMemoryPath(p, memoryIndexPath, memoryTreePath)
          ) {
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

    // Layer 4: policy hint at tool-selection time. Opt-in flip: the hint is appended
    // only when BOTH the dispatch surface is configured (first tool exists) AND the
    // descriptionHint template is non-empty — an unconfigured plugin leaves the tool
    // description untouched. The hinted tool is the FIRST resolved dispatch tool
    // (defaults → no hint at all). Missing tool IDs are ignored by the editor
    // (documented behavior), so a rename degrades to layers 1-3 only.
    await ctx.tool.transform((editor) => {
      if (enforcementDisabled()) return
      const target = CFG.dispatch.tools[0]
      if (target === undefined || DESCRIPTION_HINT === "") return
      editor.update(target, (tool) => {
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
        // Phase 2: classification runs against the resolved read-target table (the
        // DEFAULT table while the gates group is broken — recording keeps its semantics
        // and the gate's CONFIG-ERROR never lets an unreadable prerequisite pass).
        const target = classifyRead(input.path, readTargetTable)
        if (target) markRead(event.sessionID, target)
      }
    })

    // Layer 3: PRIMER as a system text part before every agent model request
    // (survives compaction automatically — system parts are reassembled per request).
    // Flexibility Phase 1: when the resolved options carry problems (errors AND
    // warnings), an additional system text part naming them is pushed AFTER the primer
    // position (owner-approved surfacing channel; with zero problems nothing extra is
    // pushed). OPT-IN FLIP: the primer part is pushed only when the resolved text is
    // non-empty — with no options the resolved primer.text is "" and NOTHING is
    // injected. With the canonical fixture the injected text is the fixture's PRIMER
    // verbatim.
    await ctx.session.hook("context", (event) => {
      if (enforcementDisabled()) return
      if (CFG.primer.text !== "") {
        event.system.push({ type: "text", text: CFG.primer.text })
      }
      if (CONFIG_PROBLEMS.length > 0) {
        event.system.push({ type: "text", text: `dispatch-policy config problems: ${CONFIG_PROBLEMS.join("; ")}` })
      }
    })
  },
})
