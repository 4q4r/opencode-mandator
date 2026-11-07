// src/defaults.ts — the EMPTY defaults of the dispatch-policy plugin (opt-in
// enforcement flip, owner decision 2026-11-07: "Empty defaults, setup in JSON").
// Every value is OFF: an unconfigured plugin is COMPLETELY INERT — no gates, no denies,
// no primer injection, no description hint, no config problems. Enforcement exists only
// via explicit configuration (ctx.options via src/config.ts); the owner's setup lives as
// configuration, canonically snapshotted in tests/fixtures/mandator-setup.json (the
// pre-flip DEFAULTS verbatim) for the owner's opencode.json.
//
// OFF representations per group: empty arrays (dispatch/skills/gates/structure lists),
// "" (exaSubstring / memoryMandatePattern / chainOverrideMarker / paths / every message
// template), {} (blocks, mcpSkillHints), null (caps.identicalMax / caps.chainMax /
// structure.stitchMinPrompt), false (requireBackground / requireAgent), and primer
// { mode: "default", text: "" } → nothing injected. Empty/absent is VALID everywhere;
// validation rules (types, regex compilability, cross-refs) stand.
//
// CONFIG-ERROR denies remain hardcoded (they report the config itself — never
// configurable). A firing guard whose deny template is empty still DENIES: the deny
// text falls back to the plugin's hardcoded generic line (src/dispatch-policy.ts).
//
// Derived forms the plugin builds at setup are NOT stored as compiled objects — DEFAULTS
// stays a plain serializable snapshot (parity-test-friendly); instead this module exports
// small pure builders that compile them (regex sources → RegExp with the original flags,
// deny-message templates → final strings via fill()). The plugin calls the builders once
// at module scope / inside setup, exactly where the inline constants used to live.
//
// Template mechanics (§A "messages"): deny templates substitute {var} placeholders via
// fill(). The COMPLIANCE_WARNING trailer is appended mechanically by the plugin (except
// where it never is: the identical-loop deny), so a template that embeds trailer text is
// a content bug.

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
// (unknown {var} in a configured template is caught at resolve time and falls back to
// the default template — see src/config.ts).
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

// The owner setup (the pre-flip DEFAULTS verbatim: the 4 mandatory skills, the 9 gated
// tool names, the MCP prefix table, the five structure blocks, caps 4/6, the full
// message templates, the COMPLIANCE_WARNING trailer, and the PRIMER text) is NOT
// hard-coded anymore. Its canonical snapshot lives in tests/fixtures/mandator-setup.json
// (extracted mechanically from the pre-flip DEFAULTS) — the controller lands it into
// ~/.config/opencode/opencode.json (plugin object-form options) after merge. The
// historical verification notes for those values (live-DB gated-name checks, MCP prefix
// conventions, Stitch surface decisions) remain valid and are documented in
// docs/RULES.md + the fixture's consumer tests.
export const DEFAULTS = deepFreeze({
  dispatch: {
    tools: [],
    forbiddenAgents: [],
    requireBackground: false,
    requireAgent: false,
  },
  skills: {
    mandatory: [],
    orchestrator: [],
  },
  gates: {
    tools: [],
    exaSubstring: "", // empty string = the substring rule is off (null also accepted as off)
    mcpRequirements: [],
    readTargets: [],
    memoryMandatePattern: "", // empty = the ext-6.1 memory-mandate check is off
  },
  structure: {
    blocks: {},
    subagentProfile: [],
    stitchProfile: [],
    stitchPromptTools: [],
    stitchMinPrompt: null, // null = the length floor is off (the whole surface is off anyway with no tools)
  },
  caps: {
    identicalMax: null, // null = identical-dispatch breaker off
    chainMax: null, // null = continuation-chain cap off
    chainOverrideMarker: "", // empty = no escape marker accepted (over-cap continuations cannot unlock)
  },
  paths: {
    memoryIndex: "", // empty = overwrite guard off
    memoryTree: "",
  },
  messages: {
    // Every template empty: a firing guard without a template still DENIES — the deny
    // text falls back to the plugin's hardcoded CONFIG-ERROR-style generic line. The
    // trailer (complianceWarning) is likewise empty by default, so a default-config
    // deny (if one ever fires) carries no trailer.
    complianceWarning: "",
    generalBan: "",
    backgroundBan: "",
    agentMissing: "",
    gateMissing: "",
    structureFail: "",
    memoryMandateFail: "",
    memoryOverwriteFail: "",
    identicalLoopFail: "",
    chainCapFail: "",
    mcpSkillFail: "",
    mcpSkillHints: {},
    descriptionHint: "",
  },
  primer: {
    // mode "default" + text "" → NOTHING is injected. With text configured (any mode)
    // the configured text is what gets injected (the pre-flip "shipped PRIMER stays
    // pinned" ruling is superseded: there is no shipped primer anymore).
    mode: "default",
    text: "",
  },
})
