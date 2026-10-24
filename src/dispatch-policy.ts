import { Plugin } from "@opencode/plugin"
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

// PRIMER — owner-approved policy wording, injected VERBATIM (wave3-a2 brief).
const PRIMER = `[auto-injected operating rules — non-negotiable]
- Before task decisions consult global memory: ~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/* (list what you read). Keep memory live: supersede, never duplicate; subagents never write memory files — send facts to the controller.
- Skills are MANDATORY: \`brainstorming\` before any feature/creative work; \`build-with-exa\` for external facts (Exa primary); \`grilling\` before new features; ≥2 more relevant skills per task; list skills used in every report.
- Subagent dispatches: background:true ALWAYS; specialized agent types only — \`general\` is FORBIDDEN; new task = fresh session (never pass sessionID); dispatch brief must order: read all global memory + skill mandate + report contract; controller verifies results (git status / real output) — never trust reports blindly.
- The orchestrator NEVER implements (no edits/builds/gates/pushes) — dispatch subagents; parallel implementation only with disjoint file scopes or separate worktrees.
- Every change: branch → PR → squash-merge; never push main directly; no stash without explicit yes; no deploy/publish without explicit owner word.
- Quality gates run as standalone blocking commands; a failed gate must make merge/push unreachable; never chain gate+release in one \`;\`/\`&&\` command.
- Scratch in /tmp or ~/.opencode/plan/; engagement memory goes to global memory, never ~/ root clutter; kill processes by exact PID only (no pkill/killall by name).
- Deliverable format (file type, layout standard, one vs many artifacts) is an explicit early question — never default it.
- Estimates (time/cost/points) only on explicit request. Chat with owner: Russian. Code/reports: English.
- External facts via Exa; every screenshot/visual → Z.AI Vision MCP; fail loudly — never fake success paths.
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

function classifyRead(p: unknown): string | undefined {
  if (typeof p !== "string" || !p) return undefined
  let s = p
  if (s === "~") s = os.homedir()
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2))
  for (const [target, suffix] of READ_TARGETS) {
    if (s === suffix || s.endsWith("/" + suffix)) return target
  }
  return undefined
}

// Per-session compliance state; cleared on server restart (fail-closed: sessions
// re-gate after a restart) and on every plugin hot-reload (setup re-runs). Only
// completed `skill` and `read` executions are recorded (execute.after with status
// "completed"), so failed invocations never count.
const loadedSkills = new Map<string, Set<string>>()
const readTargets = new Map<string, Set<string>>()

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
        }
      } else if (STITCH_PROMPT_TOOLS.has(event.tool)) {
        const prompt = typeof input.prompt === "string" ? input.prompt : ""
        if (prompt.length >= STITCH_MIN_PROMPT) {
          const missing = missingBlocks(prompt, STITCH_PROFILE)
          if (missing.length > 0) {
            throw new Error(denyStructure(`MCP tool "${event.tool}"`, missing, STITCH_PROFILE))
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
