// src/defaults.ts — Flexibility Phase 0: every hardcoded constant of the dispatch-policy
// plugin, extracted verbatim into a deep-frozen DEFAULTS object. The group/key structure
// mirrors the approved option taxonomy (flex-design-report.md §A: dispatch / skills /
// gates / structure / caps / paths / messages / primer); every value is today's default.
// Contract: with no options present the plugin resolves to exactly these values —
// byte-identical behavior (the 75-test suite + tests/defaults-parity.test.ts are the
// parity contract). Phase 0 ONLY: nothing here is read from ctx.options yet (Phase 1
// wires the option reading via a config.ts resolver).
//
// Derived forms the plugin builds at setup are NOT stored as compiled objects — DEFAULTS
// stays a plain serializable snapshot (parity-test-friendly); instead this module exports
// small pure builders that compile them (regex sources → RegExp with the original flags,
// deny-message templates → final strings via fill()). The plugin calls the builders once
// at module scope, exactly where the inline constants used to live.
//
// Template mechanics (§A "messages"): deny templates are the current verbatim strings
// minus the COMPLIANCE_WARNING trailer — the trailer is appended mechanically by the
// plugin (except where it never is: the identical-loop deny), so a template that embeds
// trailer text is a content bug. Dynamic values are {var}-substituted via fill().

export type BlockKey = "role" | "task" | "context" | "constraints" | "output"

// Recursively freeze a plain data structure (objects + arrays at every level). Exported:
// the parity test deep-freezes its snapshot literal with the same helper, and Phase 1's
// config resolver will reuse it for resolved configs.
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

// {var} substitution for the messages templates. Unknown placeholders are left as-is
// (defaults never hit that case; Phase 1 validation rules on unknown {var} come later).
export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? vars[key] : match))
}

// Escape a literal string for use as a regex source (character-class safe: only
// metacharacters are escaped; `-` needs no escaping outside character classes).
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// §A caps.chainOverrideMarker → the Variant-A escape regex: marker + whitespace + a
// NON-EMPTY reason (bare marker does not unlock). Compiles to exactly the original
// /\[chain-cap-override\]\s*\S/i for the default marker.
export function buildChainOverrideRe(marker: string): RegExp {
  return new RegExp(`${escapeRegExp(marker)}\\s*\\S`, "i")
}

// §A structure.blocks → compiled block matchers. Keys are plain strings (Phase 2 allows
// custom block vocabularies — the DEFAULTS record uses the five canonical keys).
// Compiled with the original flag "i"; the check is keyword-presence per block,
// tolerant to header forms ("## Task", "**Task:**", "Task:") and to Russian block
// names — the honest, deterministic subset of "no bad prompts" (it cannot judge
// content quality, only structure; the COMPLIANCE WARNING covers the rest). Source of
// truth: the prompt-engineering-patterns skill — references/system-prompts.md
// ("Effective System Prompt Structure") and the template library (every generation
// template carries Task / Context / Requirements / Constraints / Output).
export function buildBlocks(
  blocks: Record<string, { name: string; pattern: string }>,
): Record<string, { name: string; re: RegExp }> {
  const out = {} as Record<string, { name: string; re: RegExp }>
  for (const key of Object.keys(blocks)) {
    out[key] = { name: blocks[key].name, re: new RegExp(blocks[key].pattern, "i") }
  }
  return out
}

// §A gates.memoryMandatePattern → compiled with the original flags "iu". Regex per the
// ext-6.1 analyst sketch with one deliberate correction: JS `\w` is ASCII-only and
// cannot carry the Cyrillic tail of «глобальную», so the RU forms would never match;
// `\p{L}` under the `u` flag is required (pinned by the RU test in the suite).
export function buildMemoryMandateRe(pattern: string): RegExp {
  return new RegExp(pattern, "iu")
}

// PRIMER v2 — owner-approved 2026-11-06 (13 bullets; brief-quality rules, cloakbrowser
// owner-lock; designed by the prompt-engineering round, sources in /tmp/opencode/mandator-ext6/primer-v2/primer-v2-report.md).
// ext-7.1 sync (2026-11-07): context7-mcp joins the skill mandate (bullet 2) and the
// [skill gate] bullet — mirror bullets follow live deny behavior (PR #7 rule); 13 bullets
// kept, word delta ≤25.
const PRIMER = `[auto-injected operating rules — non-negotiable]
- Before task decisions consult global memory: ~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/* (list what you read). Keep memory live: supersede, never duplicate; subagents never write memory files — send facts to the controller.
- Skills are MANDATORY and fire BEFORE the work: brainstorming before any feature/creative work (produce a bounded spec first, not code); grilling before new features (interview until the spec has no holes; a found hole is a STOP-blocker — resolve with the owner, never guess); build-with-exa for every external fact (Exa primary source); context7-mcp before touching the context7 MCP (resolve-library-id before query-docs); plus ≥2 more skills you pick as relevant to THIS task. In every report list every skill invoked with one line on what it changed — a report without the skill list is incomplete.
- Subagent dispatches: background:true ALWAYS; specialized agent types only — \`general\` is FORBIDDEN; new task = fresh session (never pass sessionID); controller verifies results (git status / real output) — never trust reports blindly.
- Every dispatch brief has five labeled blocks — Role / Task / Context / Constraints / Output format — written for a cold reader with zero session context: objective, exact output shape, tool/source guidance, task boundaries. The brief must also carry the memory mandate (read ~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/*, list what was read), the skill mandate, and the report contract. The plugin denies briefs missing a block — write it right the first time.
- The orchestrator NEVER implements: no edits, builds, gates, or pushes by your own hand — no exceptions, not even mechanical fixes or scripted renames; ALL implementation goes to dispatched subagents. Parallel implementation only with disjoint file scopes or separate worktrees (never two agents on the same output paths).
- Every change: branch → PR → squash-merge; never push main directly; no stash without explicit yes; no deploy/publish without explicit owner word.
- Quality gates run as standalone blocking commands; a failed gate must make merge/push unreachable; never chain gate+release in one \`;\`/\`&&\` command.
- Scratch in /tmp or ~/.opencode/plan/; engagement memory goes to global memory, never ~/ root clutter; kill processes by exact PID only (no pkill/killall by name).
- Deliverable format (file type, layout standard, one vs many artifacts) is an explicit early question — never default it.
- Estimates (time/cost/points) only on explicit request. Chat with owner: Russian. Code/reports: English.
- External facts via Exa; every screenshot/visual → Z.AI Vision MCP; fail loudly — never fake success paths. cloakbrowser MCP is OWNER-LOCKED: every invocation MUST pass humanize=True and human_preset=careful — no exceptions; all other parameters at your discretion.
- [skill gate] This session's plugin ENFORCES the skill mandate: edit/write/bash/subagent-dispatch/web/execute calls are DENIED until \`skill\` has been invoked for brainstorming, grilling, build-with-exa, and context7-mcp in this session. If denied: invoke the four skills, then re-run your call unchanged.
- [skill gate: memory + orchestrator] Every gated call additionally requires a \`read\` of ~/.config/opencode/MEMORY.md in this session; before dispatching ANY subagent, the session must ALSO have loaded skills \`subagent-driven-development\` + \`dispatching-parallel-agents\` + \`prompt-engineering-patterns\` and read ~/.config/opencode/memory/topics/workflow.md + workflow-git-pr.md. Deny messages list exactly what is missing — comply, then re-run your call unchanged.`

// Gated names verified against the live v2.0.27 session DB:
//   edit/write (live), shell (live bash-class; 52k calls, last 2026-10-14),
//   bash/apply_patch (legacy defensive inclusions; bash last 2026-09-16,
//   apply_patch last 2026-08-28; multiedit/patch never existed on this install),
//   subagent (dispatch), webfetch/websearch (built-in web), execute (Code Mode —
//   can compose tools.exa.* internally: bypass surface, owner decision; 4477 live
//   calls, last 2026-10-14), plus substring "exa" for MCP exa tools
//   (live: exa_web_search_exa, exa_web_fetch_exa).
//
// Read targets are matched by suffix after ~-expansion; both absolute and ~ forms occur
// in real read calls (11 stored ~/ calls verified in the session DB).
//
// ext 7.1: MCP→skill requirements — an MCP tool may not be driven without its related
// skill. PREFIX match on the flat MCP tool name (V2 convention "<server>_<tool>",
// unsupported chars → "_": server "adb-mcp" → prefix "adb_mcp_"; the context7 tools are
// "context7_resolve_library_id" / "context7_query_docs"). The prefixes ALSO extend the
// gated set (isGatedTool), mirroring the exa-substring treatment: the base gate covers
// these MCP tools and the MCP-specific deny layers on top of a base-complete session.
// HONEST NOTE: the "context7" entry cannot fire while context7-mcp is mandatory — the
// base gate already requires context7-mcp for every gated call — it is kept in the
// table for message specificity + future-proofing if the mandatory set ever changes;
// the live enforcement of this gate is the "adb_mcp" entry. Deliberately NO mappings
// for zai-mcp-server / cloakbrowser / stitch / ssh-any / circumvention-corpus: no
// related skills exist in the system (owner informed 2026-11-07; authoring them is
// tracked in docs/BACKLOG.md).
//
// ext 7.1 (owner decision "каждого агента", 2026-11-07): context7-mcp joins the
// mandatory set — every gated call now requires all four skills + the MEMORY.md read.
//
// prompt-engineering-patterns (ext 4, owner decision 2026-10-24): dispatch briefs
// (subagent prompts) and agent-MCP prompts are prompts — the orchestrator must apply
// prompt-engineering patterns when writing them.
//
// Stitch profiles: the subagent brief requires all five blocks (a full prompt to an LLM
// agent); Stitch generation prompts require four — no Role (the tool's role is fixed by
// the design tool itself; forcing "You are..." into a screen prompt would be artificial).
// Free-text `prompt: string` (Required) inputs, verified in the Stitch MCP catalog:
//   stitch_generate_screen_from_text — "The input text to generate the screen from"
//   stitch_edit_screens              — "The input text to generate the screen from"
//   stitch_generate_variants         — "The input text used to generate the variants"
// Other Stitch surfaces are deliberately exempt (owner decision — "don't block commands
// where arbitrary text cannot be entered"): IDs/enums/flags tools (get_project, list_*,
// download_file, apply_design_system, …); create_project.title (a short label, not a
// prompt); designMd / styleGuidelines on create/update_design_system (design-spec genre
// — a token/style document, not a task prompt; the block profile does not fit);
// upload_design_md (base64 file upload). The 120-char floor: short prompts pass the
// structure check — the Stitch tools themselves recommend re-calling with an accepted
// suggestion verbatim (e.g. "Yes, make them all") — tactical follow-ups must keep
// flowing; a structured generation brief is naturally longer than this floor.
export const DEFAULTS = deepFreeze({
  dispatch: {
    tools: ["subagent"],
    forbiddenAgents: ["general"],
    requireBackground: true,
    requireAgent: true,
  },
  skills: {
    mandatory: ["brainstorming", "grilling", "build-with-exa", "context7-mcp"],
    orchestrator: [
      "subagent-driven-development",
      "dispatching-parallel-agents",
      "prompt-engineering-patterns",
    ],
  },
  gates: {
    tools: ["edit", "write", "shell", "bash", "apply_patch", "subagent", "webfetch", "websearch", "execute"],
    exaSubstring: "exa",
    mcpRequirements: [
      { prefix: "context7", skill: "context7-mcp" },
      { prefix: "adb_mcp", skill: "adb-mcp" },
    ],
    readTargets: [
      { key: "memory", suffix: ".config/opencode/MEMORY.md" },
      { key: "workflow", suffix: ".config/opencode/memory/topics/workflow.md" },
      { key: "workflow-git-pr", suffix: ".config/opencode/memory/topics/workflow-git-pr.md" },
    ],
    memoryMandatePattern:
      "(MEMORY\\.md|memory/(topics|projects)|глобальн\\p{L}*\\s+пам(ять|яти)|global memory)",
  },
  structure: {
    blocks: {
      role: { name: "Role", pattern: "(you are|your role|role\\s*:|acting as|роль\\s*:)" },
      task: { name: "Task", pattern: "(tasks?\\b|objectives?\\b|goals?\\b|mission\\b|задач|цель)" },
      context: { name: "Context", pattern: "(contexts?\\b|background\\b|контекст)" },
      constraints: {
        name: "Constraints",
        pattern:
          "(constraints?\\b|requirements?\\b|guidelines?\\b|rules?\\b|\\bmust\\b|do not|don't|avoid|never|forbidden|требован|ограничен|правил|запрещ)",
      },
      output: {
        name: "Output format",
        pattern:
          "(output format|response format|expected output|deliverable|reports?\\b|formats?\\b|includes?\\b|отч[её]т|формат)",
      },
    },
    subagentProfile: ["role", "task", "context", "constraints", "output"],
    stitchProfile: ["task", "context", "constraints", "output"],
    stitchPromptTools: [
      "stitch_generate_screen_from_text",
      "stitch_edit_screens",
      "stitch_generate_variants",
    ],
    stitchMinPrompt: 120,
  },
  caps: {
    identicalMax: 4,
    chainMax: 6,
    chainOverrideMarker: "[chain-cap-override]",
  },
  paths: {
    memoryIndex: "~/.config/opencode/MEMORY.md",
    memoryTree: "~/.config/opencode/memory",
  },
  messages: {
    // Declarative compliance warning (ext 4, owner decision — "пугалка"): appended to
    // every deny message by the plugin. It claims output is audited and skill violations
    // — including badly written subagent briefs — are REJECTED. NO hook in the plugin
    // performs that audit; the warning is a behavioral deterrent only (the owner accepts
    // the mismatch; docs/RULES.md §3 documents it honestly). Owner rationale: models
    // that believe non-compliance is caught comply with the loaded skills' requirements
    // more readily. Presence is fixed (§E); this string is wording-only.
    complianceWarning:
      " COMPLIANCE WARNING: all output is audited against the requirements of the skills applied in this " +
      "session — work that violates them is REJECTED and must be redone. This explicitly covers dispatches: " +
      "a subagent sent with a poorly written brief (violating prompt-engineering requirements — vague task, " +
      "missing context/constraints, no report contract) will be REJECTED and must be re-dispatched.",
    // The plugin-identity prefixes ("DENIED by dispatch-policy plugin:") stay hardcoded
    // in the plugin: they attribute the deny to the enforcer and are load-bearing in
    // audit forensics (6.2). The "Owner mandate:" prefix of gateMissing is part of the
    // template below for the same reason it shipped inside the original inline string.
    generalBan:
      'DENIED by dispatch-policy plugin: agent type "{agent}" is FORBIDDEN by owner mandate. ' +
      "Re-dispatch with a specialized agent type — e.g. code-reviewer, backend-architect, " +
      "frontend-developer, trend-researcher (full list: opencode debug agents).",
    backgroundBan:
      "DENIED by dispatch-policy plugin: owner mandate requires background:true on every subagent " +
      "dispatch. Re-dispatch the SAME call with background:true.",
    // ext 6.7: actionable deny for missing/empty agent (the runtime would only produce
    // the generic schema error "Invalid arguments … agent: Missing key" — no policy
    // guidance).
    agentMissing:
      "DENIED by dispatch-policy plugin: the dispatch is missing a specialized agent type " +
      "(agent missing or empty). Pick a specialized agent type — e.g. backend-architect, " +
      "code-reviewer, frontend-developer, trend-researcher (full list: opencode debug agents) — " +
      "then re-run this exact call.",
    gateMissing:
      "Owner mandate: this action requires, in this session first: {missing}. Load skills via the " +
      "`skill` tool (one call per skill); read memory files with the `read` tool. Then re-run this exact call.",
    structureFail:
      "DENIED by dispatch-policy plugin: prompt-structure check (per the prompt-engineering-patterns " +
      "skill) on the {target} prompt failed. Missing required block(s): {missing}. " +
      "Structure the prompt with explicit blocks: {blocks}. Then re-run this exact call.",
    // ext 6.1: fresh dispatch brief never instructs the subagent to read global memory
    // (owner hard dispatch protocol 2026-10-10).
    memoryMandateFail:
      "DENIED by dispatch-policy plugin: the dispatch brief does not mandate reading global memory " +
      "(owner hard dispatch protocol: every subagent brief must instruct the subagent to read " +
      "~/.config/opencode/MEMORY.md + memory/topics/* + memory/projects/* and list what it read " +
      "in its report). Add the memory mandate to the brief, then re-run this exact call.",
    // ext 6.6: whole-file `write` over an existing global memory file (last-writer-wins
    // rewrites destroyed memory entries in the 2026-10-09/10 incidents).
    memoryOverwriteFail:
      "DENIED by dispatch-policy plugin: whole-file write over an EXISTING global memory file is " +
      "forbidden — whole-file rewrites of memory race concurrent agents (2026-10-09/10 incidents). " +
      "Append or supersede the entry via the `edit` tool instead (append-only by anchors; " +
      "supersede-in-place, never full-file write). Creating a NEW memory file is allowed.",
    // ext 6.4 deny body — deliberately trailer-less: this deny carries NO
    // COMPLIANCE_WARNING (its "must be re-dispatched" wording contradicts the guard) and
    // NO "re-run this exact call" instruction (re-running is exactly what is being
    // denied). It is the plugin's only deny without the shared trailer (docs/RULES.md
    // §3); the no-trailer rule is enforced in the plugin, not by template content.
    identicalLoopFail:
      "DENIED by dispatch-policy plugin: identical dispatch sent {n} times in this session — " +
      "runaway-loop guard on identical (agent, prompt) pairs. This deny is final for identical " +
      "resends: differentiate the briefs (per-perspective prompts) or escalate to the owner.",
    // ext 6.3 deny body — unlike identicalLoopFail, this one DOES carry the trailer and
    // the re-run instruction in the plugin: re-running with the added marker is exactly
    // the sanctioned one-shot escape, alongside the primary recovery (start a FRESH
    // agent; the persistent-worker anti-pattern, owner bans 2026-09-20 / PR97 / PR111).
    chainCapFail:
      "DENIED by dispatch-policy plugin: this child-session continuation chain reached {n} " +
      "continuations in one session (cap {cap}) — persistent-worker pumping of one child " +
      "session is the anti-pattern the owner bans (2026-09-20; PR97/PR111). Start a FRESH agent " +
      "instead and hand off state via a git branch + a structured brief. To continue once beyond " +
      "the cap deliberately, add [chain-cap-override] <reason> to the continuation prompt, then " +
      "re-run this exact call.",
    // ext 7.1 deny body — carries the trailer and the re-run instruction in the plugin:
    // loading the named skill and re-running the exact call is the recovery.
    mcpSkillFail:
      'DENIED by dispatch-policy plugin: MCP tool "{tool}" requires its skill first. Invoke ' +
      "`skill`" +
      ' with id "{skill}" — it defines the correct usage of this server\'s tools ({hint}) — then re-run this exact call.',
    // Per-skill usage hints in the MCP→skill deny; an unmapped skill gets the plugin's
    // hardcoded generic "load it before driving this server".
    mcpSkillHints: {
      "context7-mcp": "for context7: resolve-library-id before query-docs",
      "adb-mcp": "for adb-mcp: read the accessibility tree before tapping",
    },
    // Layer 4: the one-line policy hint appended to the subagent tool description at
    // selection time.
    descriptionHint:
      "\n\nPOLICY (enforced by the dispatch-policy plugin): every dispatch MUST pass " +
      'background:true; agent type "general" is FORBIDDEN — pick a specialized agent type.',
  },
  primer: {
    // §A primer: "replace" (the injected system text is exactly primer.text) is the
    // Phase-0 default; "append" support and option reading are Phase 3.
    mode: "replace",
    text: PRIMER,
  },
})
