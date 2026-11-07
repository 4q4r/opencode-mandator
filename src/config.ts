// src/config.ts — the options resolver for the dispatch-policy plugin (flexibility
// migration Phases 1-3 + the opt-in flip, owner decisions 2026-11-07 — do not
// re-litigate).
//
// OPT-IN SEMANTICS (owner ruling "Empty defaults, setup in JSON", 2026-11-07):
// empty/absent options are VALID and make the plugin completely INERT — no gates, no
// denies, no primer injection, no description hint, no config problems. DEFAULTS is the
// all-off config (src/defaults.ts); enforcement exists only via explicit configuration.
// OFF representations: [] (lists), "" (exaSubstring, memoryMandatePattern,
// chainOverrideMarker, paths, every message template), {} (blocks, mcpSkillHints),
// null (caps.identicalMax / caps.chainMax / structure.stitchMinPrompt), false
// (requireBackground / requireAgent), primer { mode: "default", text: "" } → nothing.
// The owner setup is explicit configuration — canonical snapshot:
// tests/fixtures/mandator-setup.json (lands in opencode.json after merge).
//
// `resolveOptions(raw)` validates + merges the raw `ctx.options` object (untyped flat
// JSON per the OpenCode plugin SDK — the plugin owns 100% of validation) over DEFAULTS.
//
// Owner-approved HYBRID failure semantics (§C(c)) for INVALID values:
//   - Enforcement groups (dispatch, skills, gates, structure, caps, paths): an invalid
//     option fails THAT guard closed — the guard denies affected calls with a
//     CONFIG-ERROR deny naming the option path where the guard is reachable through
//     configured surfaces. Never silent fallback, never silent disable. Sub-guard
//     granularity: gates.memoryMandatePattern errors live in `memoryMandateProblems`
//     (only the ext-6.1 fresh-dispatch check fails closed); structure.stitch* errors
//     live in `stitchProblems` (only the Stitch surface fails closed). The broken
//     guard's fail-closed SCOPE derives from DEFAULTS (post-flip: the broken group's
//     own shaping option broken ⇒ nothing is covered — the guard is inert and the
//     problem surfaces loudly; sub-option breakage inside a configured group still
//     CONFIG-ERRORs at the guard's position).
//   - structure.subagentProfile / structure.stitchProfile are CROSS-VALIDATED against
//     the keys of structure.blocks: an unknown block key is a validation failure
//     (CONFIG-ERROR naming the profile path).
//   - Invalid cap ⇒ EFFECTIVE CAP 1 + CONFIG-ERROR deny (never "guard off").
//   - Empty/absent options are VALID and produce NO problems (the inert default state
//     is intended, not a misconfiguration — post-flip the pre-flight "empty = warned"
//     rulings are superseded).
//   - Unknown keys anywhere ⇒ warn (problem recorded) + ignore (owner ruling 4).
//   - Cap disable representation: `null` means the guard is off (owner ruling 3).
//   - A raw options value that is present but not a plain object cannot name a group, so
//     EVERY enforcement group fails closed (problems recorded; effective caps 1).
//   - PRESENTATION groups (messages, primer): an invalid entry (wrong type, unknown
//     {var}, invalid primer mode, missing primer.text with an explicit mode) falls back
//     to the BUILT-IN DEFAULT ("" — which renders as the plugin's hardcoded generic
//     deny line / no primer) and records a problem. An EMPTY STRING is a VALID template
//     (it means the generic deny line / no injection — the inert default). A non-object
//     messages/primer group is warn + ignored entirely. The per-template {var} sets map
//     1:1 to what the deny builders interpolate today; an unknown {var} in a configured
//     template is caught at resolve time (it would otherwise leak into denies verbatim
//     via fill()).
//
// Primer modes (opt-in flip semantics — supersedes the fix-round-1 PR #12 ruling, whose
// "shipped PRIMER stays pinned" rationale is void now that DEFAULTS.primer.text is ""):
//   "default" → primer.text when configured (non-empty), else DEFAULTS.primer.text
//               ("" — nothing injected). The default mode CONFIGURES the primer.
//   "replace" → primer.text verbatim (explicit; text required)
//   "append"  → DEFAULTS.primer.text + "\n\n" + primer.text when the built-in default is
//               non-empty, else just primer.text (there is nothing to append to)
//   Invalid mode, or replace/append without a usable text ⇒ default primer + problem.
//   With NO options the resolved primer.text is "" and NOTHING is injected (zero
//   problems); with the canonical fixture the injected primer is the fixture's PRIMER
//   verbatim.
//
// FIXED trailer rule (owner ruling 4, design §E-8): the identical-loop deny is composed
// WITHOUT the compliance trailer in the PLUGIN regardless of template content — the
// resolver deliberately does not police trailer text inside templates (a template that
// embeds trailer text is a content bug, caught by parity/e2e tests).
//
// Every problem is a plain human-readable string. The union of all problems (errors and
// warnings) is surfaced by the plugin as a system text part AFTER the primer position
// (session.context); the per-guard error subsets live on the resolved config and drive
// the CONFIG-ERROR denies. Regex options are stored as SOURCE strings and validated by
// compilation at resolve time (design §C: compile once at setup, never per call — the
// plugin compiles the validated sources). Hand-rolled validation — zero new
// dependencies (owner rule).
//
// With NO raw options (ctx.options absent) the resolver returns the all-off DEFAULTS
// values and zero problems — the inert path tests/opt-in.test.ts pins.

import { DEFAULTS, deepFreeze } from "./defaults.ts"

// Resolved (per-setup) enforcement config consumed by the plugin's guards. `problems`
// arrays hold ERROR-class clauses only (they feed the CONFIG-ERROR denies and mark the
// guard as broken); warnings live exclusively in the top-level `problems` list.
export type ResolvedConfig = {
  dispatch: {
    tools: string[]
    forbiddenAgents: string[]
    requireBackground: boolean
    requireAgent: boolean
    problems: string[]
  }
  skills: {
    mandatory: string[]
    orchestrator: string[]
    problems: string[]
  }
  gates: {
    tools: string[]
    exaSubstring: string | null
    mcpRequirements: { prefix: string; skill: string }[]
    readTargets: { key: string; suffix: string }[]
    memoryMandatePattern: string // regex SOURCE (validated by compilation with flags "iu")
    problems: string[] // tools/exaSubstring/mcpRequirements/readTargets errors — the skill/memory gate fails closed
    memoryMandateProblems: string[] // gates.memoryMandatePattern errors — the ext-6.1 fresh-dispatch check fails closed
  }
  structure: {
    blocks: Record<string, { name: string; pattern: string }>
    subagentProfile: string[]
    stitchProfile: string[]
    stitchPromptTools: string[]
    stitchMinPrompt: number | null // null = length floor off (the check never fires)
    problems: string[] // blocks/profile cross-validation errors — the structure check fails closed (fresh + stitch)
    stitchProblems: string[] // stitchPromptTools/stitchMinPrompt errors — only the Stitch surface fails closed
  }
  paths: {
    memoryIndex: string
    memoryTree: string
    problems: string[] // paths errors — the ext-6.6 memory-overwrite guard fails closed
  }
  caps: {
    identicalMax: number | null
    chainMax: number | null
    chainOverrideMarker: string
    identicalProblems: string[] // caps.identicalMax errors (effective cap 1)
    chainMaxProblems: string[] // caps.chainMax errors (effective cap 1)
    markerProblems: string[] // caps.chainOverrideMarker errors (escape fails closed)
  }
  // Phase 3 presentation groups: resolved VALUES carry the fallback already applied
  // (an invalid entry resolves to the built-in default; the problem is recorded). These
  // are warn-class — they never mark a guard broken and never produce CONFIG-ERRORs.
  messages: {
    complianceWarning: string
    generalBan: string
    backgroundBan: string
    agentMissing: string
    gateMissing: string
    structureFail: string
    memoryMandateFail: string
    memoryOverwriteFail: string
    identicalLoopFail: string
    chainCapFail: string
    mcpSkillFail: string
    mcpSkillHints: Record<string, string>
    descriptionHint: string
    problems: string[] // presentation fallbacks (unknown {var}, wrong type, …)
  }
  primer: {
    text: string // the FINAL injected system text (mode applied; fallback = DEFAULTS.primer.text)
    problems: string[] // presentation fallbacks (invalid mode, missing/invalid text)
  }
}

export type ResolveResult = { resolved: ResolvedConfig; problems: string[] }

// Groups recognized by the taxonomy (DEFAULTS) — all wired as of Phase 3 (37 options).
const KNOWN_GROUPS = ["dispatch", "skills", "gates", "caps", "structure", "paths", "messages", "primer"]
// Known keys per wired group; anything else inside a group is an unknown key (warn+ignore).
const GROUP_KEYS: Record<string, string[]> = {
  dispatch: ["tools", "forbiddenAgents", "requireBackground", "requireAgent"],
  skills: ["mandatory", "orchestrator"],
  gates: ["tools", "exaSubstring", "mcpRequirements", "readTargets", "memoryMandatePattern"],
  caps: ["identicalMax", "chainMax", "chainOverrideMarker"],
  structure: ["blocks", "subagentProfile", "stitchProfile", "stitchPromptTools", "stitchMinPrompt"],
  paths: ["memoryIndex", "memoryTree"],
  messages: [
    "complianceWarning",
    "generalBan",
    "backgroundBan",
    "agentMissing",
    "gateMissing",
    "structureFail",
    "memoryMandateFail",
    "memoryOverwriteFail",
    "identicalLoopFail",
    "chainCapFail",
    "mcpSkillFail",
    "mcpSkillHints",
    "descriptionHint",
  ],
  primer: ["mode", "text"],
}

// Per-template {var} sets (Phase 3): exactly the placeholders each deny builder
// substitutes (design §A "messages" — vars map 1:1 to today's interpolations). A
// configured template referencing anything else would leak the placeholder verbatim
// into the deny via fill() — caught here at resolve time. Templates without dynamic
// values have an EMPTY known set: any {var} in them is unknown.
const MESSAGE_TEMPLATE_VARS: Record<string, readonly string[]> = {
  complianceWarning: [],
  generalBan: ["agent"],
  backgroundBan: [],
  agentMissing: [],
  gateMissing: ["missing"],
  structureFail: ["target", "missing", "blocks"],
  memoryMandateFail: [],
  memoryOverwriteFail: [],
  identicalLoopFail: ["n"],
  chainCapFail: ["n", "cap"],
  mcpSkillFail: ["tool", "skill", "hint"],
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

// Deterministic value rendering for CONFIG-ERROR/problem messages ("got "…""), capped so
// a huge wrong value cannot flood a deny message.
function fmtGot(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v) ?? String(v)
  } catch {
    s = String(v)
  }
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0)
}

// Wired option paths are exactly "group.key" — the lookup key is everything after the
// first dot; the full path is what problem messages must name (owner ruling 1: the
// CONFIG-ERROR deny names the option path).
function keyOf(path: string): string {
  return path.slice(path.indexOf(".") + 1)
}

// string[] option: undefined → default; invalid → problem + group consequence + default.
function stringArrayOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: readonly string[],
  consequence: string,
): string[] {
  const v = raw[keyOf(path)]
  if (v === undefined) return [...fallback]
  if (!isStringArray(v)) {
    problems.push(`${path} must be an array of non-empty strings (got ${fmtGot(v)}); ${consequence}`)
    return [...fallback]
  }
  return [...v]
}

function boolOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: boolean,
  consequence: string,
): boolean {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (typeof v !== "boolean") {
    problems.push(`${path} must be a boolean (got ${fmtGot(v)}); ${consequence}`)
    return fallback
  }
  return v
}

// cap option (owner rulings 1+3): `null` = guard off; integer ≥ 1 = the cap; anything
// else ⇒ EFFECTIVE CAP 1 + problem (the consequence clause is part of the ruling wording).
function capOption(raw: Record<string, unknown>, path: string, problems: string[], fallback: number): number | null {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (v === null) return null
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v
  problems.push(`${path} must be a positive integer or null (got ${fmtGot(v)}); guard running with effective cap 1`)
  return 1
}

// string option: undefined → default; "" is VALID (empty = the guard/rule is off — the
// opt-in flip); any other non-string is invalid. Used for the knobs whose OFF
// representation is "" (caps.chainOverrideMarker, paths.memoryIndex / memoryTree).
function stringOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: string,
  consequence: string,
): string {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (typeof v !== "string") {
    problems.push(`${path} must be a string (got ${fmtGot(v)}); ${consequence}`)
    return fallback
  }
  return v
}

// gates.exaSubstring (design §A #8, as amended by the opt-in flip): "" (the default)
// removes the substring rule; null also removes it; a non-empty string is the rule;
// anything else breaks the gate guard.
function exaSubstringOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: string,
  consequence: string,
): string | null {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (v === null) return null
  if (typeof v === "string") return v
  problems.push(`${path} must be a non-empty string, an empty string (off), or null (got ${fmtGot(v)}); ${consequence}`)
  return fallback
}

// gates.mcpRequirements (design §A #9): array of {prefix, skill} objects with non-empty
// strings; [] is valid (the MCP→skill gate is inert). Invalid ⇒ the gates guard fails
// closed (the gated set is jointly defined by tools + exaSubstring + MCP prefixes).
function mcpRequirementsOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: readonly { prefix: string; skill: string }[],
  consequence: string,
): { prefix: string; skill: string }[] {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback.map((e) => ({ ...e }))
  const ok =
    Array.isArray(v) &&
    v.every(
      (e) =>
        isPlainObject(e) &&
        typeof e.prefix === "string" &&
        e.prefix.length > 0 &&
        typeof e.skill === "string" &&
        e.skill.length > 0,
    )
  if (!ok) {
    problems.push(
      `${path} must be an array of {prefix, skill} objects with non-empty strings (got ${fmtGot(v)}); ${consequence}`,
    )
    return fallback.map((e) => ({ ...e }))
  }
  return (v as { prefix: string; skill: string }[]).map((e) => ({ prefix: e.prefix, skill: e.skill }))
}

// gates.readTargets (design §A #10): array of {key, suffix} objects with non-empty
// strings; [] is valid + warned by the caller (the read prerequisite is inert).
function readTargetsOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: readonly { key: string; suffix: string }[],
  consequence: string,
): { key: string; suffix: string }[] {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback.map((e) => ({ ...e }))
  const ok =
    Array.isArray(v) &&
    v.every(
      (e) =>
        isPlainObject(e) &&
        typeof e.key === "string" &&
        e.key.length > 0 &&
        typeof e.suffix === "string" &&
        e.suffix.length > 0,
    )
  if (!ok) {
    problems.push(
      `${path} must be an array of {key, suffix} objects with non-empty strings (got ${fmtGot(v)}); ${consequence}`,
    )
    return fallback.map((e) => ({ ...e }))
  }
  return (v as { key: string; suffix: string }[]).map((e) => ({ key: e.key, suffix: e.suffix }))
}

// Regex-source option (design §A: regex options are pattern SOURCE strings compiled
// with the original flags): "" is VALID and means the check is OFF (the opt-in flip);
// a non-empty value must compile; stored as source, validated by compilation at resolve
// time. Invalid ⇒ the sub-guard fails closed.
function regexSourceOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: string,
  flags: string,
  consequence: string,
): string {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (v === "") return ""
  if (typeof v !== "string") {
    problems.push(`${path} must be a non-empty regex source string, or an empty string (check off) (got ${fmtGot(v)}); ${consequence}`)
    return fallback
  }
  try {
    new RegExp(v, flags)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    problems.push(`${path} must be a valid regex source (got ${fmtGot(v)}: ${msg}); ${consequence}`)
    return fallback
  }
  return v
}

// structure.blocks (design §A #12): a plain-object record of {name, pattern}; every
// pattern must compile with the original flag "i". Invalid entry ⇒ a problem naming
// structure.blocks.<key> (or .pattern) and the whole option falls back to defaults —
// the structure guard is marked broken either way (the check cannot run ⇒ nothing
// passes unvalidated).
function blocksOption(
  raw: Record<string, unknown>,
  problems: string[],
  fallback: Record<string, { name: string; pattern: string }>,
): Record<string, { name: string; pattern: string }> {
  const copy = (src: Record<string, { name: string; pattern: string }>) =>
    Object.fromEntries(Object.keys(src).map((k) => [k, { ...src[k] }]))
  const v = raw.blocks
  if (v === undefined) return copy(fallback)
  if (!isPlainObject(v)) {
    problems.push(
      `structure.blocks must be a plain object record of {name, pattern} (got ${fmtGot(v)}); structure guard failing closed`,
    )
    return copy(fallback)
  }
  const out: Record<string, { name: string; pattern: string }> = {}
  let ok = true
  for (const key of Object.keys(v)) {
    const entry = v[key]
    if (
      !isPlainObject(entry) ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      typeof entry.pattern !== "string" ||
      entry.pattern.length === 0
    ) {
      problems.push(
        `structure.blocks.${key} must be an object with non-empty string "name" and "pattern" (got ${fmtGot(entry)}); structure guard failing closed`,
      )
      ok = false
      continue
    }
    try {
      new RegExp(entry.pattern, "i")
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      problems.push(
        `structure.blocks.${key}.pattern must be a valid regex source (got ${fmtGot(entry.pattern)}: ${msg}); structure guard failing closed`,
      )
      ok = false
      continue
    }
    out[key] = { name: entry.name, pattern: entry.pattern }
  }
  return ok ? out : copy(fallback)
}

// Profile cross-validation (brief: "referencing an unknown block key ⇒ CONFIG-ERROR"):
// every profile key must exist in the block-key universe (the raw override's keys when
// a valid record, else the DEFAULT block keys). Returns the validated profile — the
// DEFAULT profile when the shape or any key is invalid (the guard is marked broken).
function profileOption(
  profile: string[],
  fallback: readonly string[],
  universe: string[] | null,
  path: string,
  problems: string[],
): string[] {
  if (universe === null) return profile // blocks itself broken — the guard already fails closed
  const unknown = profile.filter((key) => !universe.includes(key))
  if (unknown.length === 0) return profile
  for (const key of unknown) {
    problems.push(
      `${path} references unknown block key "${key}" (known blocks: ${universe.join(", ")}); structure guard failing closed`,
    )
  }
  return [...fallback]
}

// structure.stitchMinPrompt (design §A #16, as amended by the opt-in flip): a positive
// integer floor, or null = the floor is off (the stitch check never fires); anything
// else breaks the Stitch surface sub-guard (fresh dispatches unaffected).
function positiveIntOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: number | null,
  consequence: string,
): number | null {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (v === null) return null
  if (typeof v === "number" && Number.isInteger(v) && v >= 1) return v
  problems.push(`${path} must be a positive integer or null (got ${fmtGot(v)}); ${consequence}`)
  return fallback
}

// Presentation-domain message template (Phase 3, as amended by the opt-in flip): a
// present value must be a STRING ("" is VALID — it means the guard renders the plugin's
// hardcoded generic deny line / appends nothing) whose {var} placeholders are all in
// the template's known set; a wrong type or an unknown {var} falls back to the DEFAULT
// template with a recorded problem (presentation semantics — wording problems never
// brick enforcement).
function messageTemplateOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: string,
): string {
  const known = MESSAGE_TEMPLATE_VARS[keyOf(path)] ?? []
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (typeof v !== "string") {
    problems.push(`${path} must be a string (got ${fmtGot(v)}); falling back to the default template (presentation warning)`)
    return fallback
  }
  const unknown = [...new Set([...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).filter((k) => !known.includes(k)))]
  if (unknown.length > 0) {
    const knownList = known.map((k) => `{${k}}`).join(", ") || "none"
    problems.push(
      `${path} references unknown placeholder(s) ${unknown.map((k) => `{${k}}`).join(", ")} (known: ${knownList}); falling back to the default template (presentation warning)`,
    )
    return fallback
  }
  return v
}

// messages.mcpSkillHints (Phase 3): a plain-object record of non-empty string hints;
// ANY skill keys are valid (future skills). Invalid ⇒ the default hints + problem.
function mcpSkillHintsOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: Record<string, string>,
): Record<string, string> {
  const v = raw[keyOf(path)]
  if (v === undefined) return { ...fallback }
  const ok =
    isPlainObject(v) &&
    Object.values(v).every((s) => typeof s === "string" && s.length > 0)
  if (!ok) {
    problems.push(
      `${path} must be a plain object record of non-empty string hints (got ${fmtGot(v)}); falling back to the default hints (presentation warning)`,
    )
    return { ...fallback }
  }
  return { ...(v as Record<string, string>) }
}

// Primer group: resolve primer.mode/primer.text into the FINAL injected text.
// Opt-in flip semantics (supersedes the fix-round-1 PR #12 ruling — there is no shipped
// primer to pin anymore; DEFAULTS.primer.text is ""):
//   "default" (implicit or explicit) → the configured text when present-and-valid, else
//             DEFAULTS.primer.text ("") — the default mode CONFIGURES the primer; a bare
//             primer.text is therefore EFFECTIVE now (zero problems).
//   "replace" → text verbatim (explicit; a usable text is required — a present-but-
//             invalid one is a fallback problem in every mode).
//   "append"  → DEFAULTS.primer.text + "\n\n" + text when the built-in default is
//             non-empty, else just text (nothing to append to).
// Invalid mode, or replace/append without a usable text ⇒ the default primer (the
// configured text in default mode, else "") + a fallback problem. With NO options the
// resolution is text "" + zero problems → the plugin injects NOTHING.
function resolvePrimer(
  raw: Record<string, unknown>,
  problems: string[],
  groupBroken: boolean,
): { text: string; problems: string[] } {
  const primerProblems: string[] = []
  const fallbackWith = (): { text: string; problems: string[] } => {
    problems.push(...primerProblems)
    return { text: DEFAULTS.primer.text, problems: primerProblems }
  }
  if (groupBroken) return { text: DEFAULTS.primer.text, problems: primerProblems } // group warned+ignored by the caller

  const explicitMode = raw.mode !== undefined
  let mode: string = DEFAULTS.primer.mode
  if (explicitMode) {
    if (raw.mode === "default" || raw.mode === "replace" || raw.mode === "append") {
      mode = raw.mode
    } else {
      primerProblems.push(
        `primer.mode must be "default", "replace", or "append" (got ${fmtGot(raw.mode)}); falling back to the default primer (presentation warning)`,
      )
      return fallbackWith()
    }
  }

  // Text source: a valid configured string; "" is VALID (it means no configured text /
  // nothing injected); a present-but-invalid value is a fallback problem in every mode.
  let text: string | undefined
  if (raw.text !== undefined) {
    if (typeof raw.text === "string") {
      text = raw.text
    } else {
      primerProblems.push(
        `primer.text must be a string (got ${fmtGot(raw.text)}); falling back to the default primer (presentation warning)`,
      )
      return fallbackWith()
    }
  }

  if (mode === "default") {
    // The default mode resolves to the configured text (may be ""), zero problems.
    return { text: text ?? DEFAULTS.primer.text, problems: primerProblems }
  }
  if (text !== undefined && text !== "") {
    const base = DEFAULTS.primer.text
    return mode === "append"
      ? { text: base === "" ? text : base + "\n\n" + text, problems: primerProblems }
      : { text, problems: primerProblems }
  }
  if (explicitMode) {
    primerProblems.push(
      `primer.text is required when primer.mode is "${mode}" (got ${fmtGot(raw.text)}); falling back to the default primer (presentation warning)`,
    )
    return fallbackWith()
  }
  // Unreachable in practice (mode is only replace/append here when explicitMode), kept
  // as the safe default-primer fallback.
  return { text: DEFAULTS.primer.text, problems: primerProblems }
}

function scanUnknownKeys(group: string, obj: Record<string, unknown>, problems: string[]): void {
  for (const key of Object.keys(obj)) {
    if (!GROUP_KEYS[group].includes(key)) {
      problems.push(`unknown option key "${group}.${key}" ignored (warning)`)
    }
  }
}

export function resolveOptions(raw: unknown): ResolveResult {
  const problems: string[] = []
  const plain = isPlainObject(raw)
  // A present-but-non-object options value cannot name a group: every enforcement guard
  // fails closed (§C(c) spirit — never silently weaker than owner intent).
  const totalBreak =
    raw !== undefined && !plain
      ? [`options must be a plain object (got ${fmtGot(raw)}); enforcement failing closed`]
      : []

  if (plain) {
    for (const key of Object.keys(raw as Record<string, unknown>)) {
      if (!KNOWN_GROUPS.includes(key)) {
        problems.push(`unknown option key "${key}" ignored (warning)`)
      }
    }
  }

  const o = plain ? (raw as Record<string, unknown>) : {}

  // --- dispatch group ---
  const dispatchProblems: string[] = []
  const dispatchRaw = o.dispatch
  const dispatchOK = !("dispatch" in o) || isPlainObject(dispatchRaw)
  if ("dispatch" in o && !dispatchOK) {
    dispatchProblems.push(
      `options group "dispatch" must be a plain object (got ${fmtGot(dispatchRaw)}); dispatch guard failing closed`,
    )
  }
  const d = dispatchOK && isPlainObject(dispatchRaw) ? dispatchRaw : {}
  if (dispatchOK && "dispatch" in o) scanUnknownKeys("dispatch", d, problems)
  const dispatch: ResolvedConfig["dispatch"] = {
    tools: stringArrayOption(d, "dispatch.tools", dispatchProblems, DEFAULTS.dispatch.tools, "dispatch guard failing closed"),
    forbiddenAgents: stringArrayOption(
      d,
      "dispatch.forbiddenAgents",
      dispatchProblems,
      DEFAULTS.dispatch.forbiddenAgents,
      "dispatch guard failing closed",
    ),
    requireBackground: boolOption(
      d,
      "dispatch.requireBackground",
      dispatchProblems,
      DEFAULTS.dispatch.requireBackground,
      "dispatch guard failing closed",
    ),
    requireAgent: boolOption(
      d,
      "dispatch.requireAgent",
      dispatchProblems,
      DEFAULTS.dispatch.requireAgent,
      "dispatch guard failing closed",
    ),
    problems: dispatchProblems,
  }

  // --- skills group ---
  const skillsProblems: string[] = []
  const skillsRaw = o.skills
  const skillsOK = !("skills" in o) || isPlainObject(skillsRaw)
  if ("skills" in o && !skillsOK) {
    skillsProblems.push(
      `options group "skills" must be a plain object (got ${fmtGot(skillsRaw)}); skill gate failing closed`,
    )
  }
  const sk = skillsOK && isPlainObject(skillsRaw) ? skillsRaw : {}
  if (skillsOK && "skills" in o) scanUnknownKeys("skills", sk, problems)
  const mandatory = stringArrayOption(
    sk,
    "skills.mandatory",
    skillsProblems,
    DEFAULTS.skills.mandatory,
    "skill gate failing closed",
  )
  const orchestrator = stringArrayOption(
    sk,
    "skills.orchestrator",
    skillsProblems,
    DEFAULTS.skills.orchestrator,
    "dispatch preflight failing closed",
  )
  // Empty skill lists are VALID and produce NO problems (opt-in flip: the inert default
  // state is intended, not a misconfiguration — the pre-flip "empty = warned" ruling is
  // superseded).
  const skills: ResolvedConfig["skills"] = { mandatory, orchestrator, problems: skillsProblems }

  // --- gates group ---
  const gatesProblems: string[] = []
  const gatesMemoryMandateProblems: string[] = [] // ext-6.1 sub-guard pool (separate from the gate)
  const gatesRaw = o.gates
  const gatesOK = !("gates" in o) || isPlainObject(gatesRaw)
  if ("gates" in o && !gatesOK) {
    gatesProblems.push(
      `options group "gates" must be a plain object (got ${fmtGot(gatesRaw)}); skill gate failing closed`,
    )
  }
  const g = gatesOK && isPlainObject(gatesRaw) ? gatesRaw : {}
  if (gatesOK && "gates" in o) scanUnknownKeys("gates", g, problems)
  const readTargets = readTargetsOption(
    g,
    "gates.readTargets",
    gatesProblems,
    DEFAULTS.gates.readTargets,
    "skill gate failing closed",
  )
  // Empty readTargets ⇒ VALID, no warning (opt-in flip: the read prerequisite is off —
  // the intended default state, superseding the pre-flip vacuous-gate warning ruling).
  const gates: ResolvedConfig["gates"] = {
    tools: stringArrayOption(g, "gates.tools", gatesProblems, DEFAULTS.gates.tools, "skill gate failing closed"),
    exaSubstring: exaSubstringOption(
      g,
      "gates.exaSubstring",
      gatesProblems,
      DEFAULTS.gates.exaSubstring,
      "skill gate failing closed",
    ),
    mcpRequirements: mcpRequirementsOption(
      g,
      "gates.mcpRequirements",
      gatesProblems,
      DEFAULTS.gates.mcpRequirements,
      "skill gate failing closed",
    ),
    readTargets,
    memoryMandatePattern: regexSourceOption(
      g,
      "gates.memoryMandatePattern",
      gatesMemoryMandateProblems,
      DEFAULTS.gates.memoryMandatePattern,
      "iu",
      "memory-mandate check failing closed",
    ),
    problems: gatesProblems,
    memoryMandateProblems: gatesMemoryMandateProblems,
  }

  // --- structure group (Phase 2) ---
  const structureProblems: string[] = []
  const stitchProblems: string[] = []
  const structureRaw = o.structure
  const structureOK = !("structure" in o) || isPlainObject(structureRaw)
  if ("structure" in o && !structureOK) {
    structureProblems.push(
      `options group "structure" must be a plain object (got ${fmtGot(structureRaw)}); structure guard failing closed`,
    )
  }
  const st = structureOK && isPlainObject(structureRaw) ? structureRaw : {}
  if (structureOK && "structure" in o) scanUnknownKeys("structure", st, problems)
  const blocks = blocksOption(st, structureProblems, DEFAULTS.structure.blocks)
  // Cross-validation universe: the raw override's keys when a valid record, the DEFAULT
  // keys when no override, and null when the override itself is broken (the guard is
  // already failing closed — no second verdict on unreadable data).
  const blockKeyUniverse =
    st.blocks === undefined
      ? Object.keys(DEFAULTS.structure.blocks)
      : isPlainObject(st.blocks)
        ? Object.keys(st.blocks)
        : null
  const subagentProfile = profileOption(
    stringArrayOption(
      st,
      "structure.subagentProfile",
      structureProblems,
      DEFAULTS.structure.subagentProfile,
      "structure guard failing closed",
    ),
    DEFAULTS.structure.subagentProfile,
    blockKeyUniverse,
    "structure.subagentProfile",
    structureProblems,
  )
  const stitchProfile = profileOption(
    stringArrayOption(
      st,
      "structure.stitchProfile",
      structureProblems,
      DEFAULTS.structure.stitchProfile,
      "structure guard failing closed",
    ),
    DEFAULTS.structure.stitchProfile,
    blockKeyUniverse,
    "structure.stitchProfile",
    structureProblems,
  )
  const structure: ResolvedConfig["structure"] = {
    blocks,
    subagentProfile,
    stitchProfile,
    stitchPromptTools: stringArrayOption(
      st,
      "structure.stitchPromptTools",
      stitchProblems,
      DEFAULTS.structure.stitchPromptTools,
      "stitch structure check failing closed",
    ),
    stitchMinPrompt: positiveIntOption(
      st,
      "structure.stitchMinPrompt",
      stitchProblems,
      DEFAULTS.structure.stitchMinPrompt,
      "stitch structure check failing closed",
    ),
    problems: structureProblems,
    stitchProblems,
  }

  // --- paths group (Phase 2) ---
  const pathsProblems: string[] = []
  const pathsRaw = o.paths
  const pathsOK = !("paths" in o) || isPlainObject(pathsRaw)
  if ("paths" in o && !pathsOK) {
    pathsProblems.push(
      `options group "paths" must be a plain object (got ${fmtGot(pathsRaw)}); memory-overwrite guard failing closed`,
    )
  }
  const p = pathsOK && isPlainObject(pathsRaw) ? pathsRaw : {}
  if (pathsOK && "paths" in o) scanUnknownKeys("paths", p, problems)
  const paths: ResolvedConfig["paths"] = {
    memoryIndex: stringOption(
      p,
      "paths.memoryIndex",
      pathsProblems,
      DEFAULTS.paths.memoryIndex,
      "memory-overwrite guard failing closed",
    ),
    memoryTree: stringOption(
      p,
      "paths.memoryTree",
      pathsProblems,
      DEFAULTS.paths.memoryTree,
      "memory-overwrite guard failing closed",
    ),
    problems: pathsProblems,
  }

  // --- caps group ---
  const identicalProblems: string[] = []
  const chainMaxProblems: string[] = []
  const markerProblems: string[] = []
  const capsRaw = o.caps
  const capsOK = !("caps" in o) || isPlainObject(capsRaw)
  if ("caps" in o && !capsOK) {
    // The whole group is unreadable: both cap guards fail closed with effective cap 1.
    chainMaxProblems.push(
      `options group "caps" must be a plain object (got ${fmtGot(capsRaw)}); guard running with effective cap 1`,
    )
    identicalProblems.push(
      `options group "caps" must be a plain object (got ${fmtGot(capsRaw)}); guard running with effective cap 1`,
    )
  }
  const c = capsOK && isPlainObject(capsRaw) ? capsRaw : {}
  if (capsOK && "caps" in o) scanUnknownKeys("caps", c, problems)
  const marker = stringOption(
    c,
    "caps.chainOverrideMarker",
    markerProblems,
    DEFAULTS.caps.chainOverrideMarker,
    "override escape failing closed",
  )
  const caps: ResolvedConfig["caps"] = {
    identicalMax: capOption(c, "caps.identicalMax", identicalProblems, DEFAULTS.caps.identicalMax),
    chainMax: capOption(c, "caps.chainMax", chainMaxProblems, DEFAULTS.caps.chainMax),
    chainOverrideMarker: marker,
    identicalProblems,
    chainMaxProblems,
    markerProblems,
  }

  // --- messages group (Phase 3, presentation domain) ---
  // Presentation semantics: an invalid entry falls back to the DEFAULT template with a
  // recorded problem; a non-object group is warn + ignored entirely. Enforcement is
  // never affected — wording problems must not brick the guards.
  const messagesProblems: string[] = []
  const messagesRaw = o.messages
  const messagesOK = !("messages" in o) || isPlainObject(messagesRaw)
  if ("messages" in o && !messagesOK) {
    problems.push(
      `options group "messages" must be a plain object (got ${fmtGot(messagesRaw)}); ignored (presentation warning)`,
    )
  }
  const msg = messagesOK && isPlainObject(messagesRaw) ? messagesRaw : {}
  if (messagesOK && "messages" in o) scanUnknownKeys("messages", msg, problems)
  const messages: ResolvedConfig["messages"] = {
    complianceWarning: messageTemplateOption(
      msg,
      "messages.complianceWarning",
      messagesProblems,
      DEFAULTS.messages.complianceWarning,
    ),
    generalBan: messageTemplateOption(msg, "messages.generalBan", messagesProblems, DEFAULTS.messages.generalBan),
    backgroundBan: messageTemplateOption(
      msg,
      "messages.backgroundBan",
      messagesProblems,
      DEFAULTS.messages.backgroundBan,
    ),
    agentMissing: messageTemplateOption(
      msg,
      "messages.agentMissing",
      messagesProblems,
      DEFAULTS.messages.agentMissing,
    ),
    gateMissing: messageTemplateOption(msg, "messages.gateMissing", messagesProblems, DEFAULTS.messages.gateMissing),
    structureFail: messageTemplateOption(
      msg,
      "messages.structureFail",
      messagesProblems,
      DEFAULTS.messages.structureFail,
    ),
    memoryMandateFail: messageTemplateOption(
      msg,
      "messages.memoryMandateFail",
      messagesProblems,
      DEFAULTS.messages.memoryMandateFail,
    ),
    memoryOverwriteFail: messageTemplateOption(
      msg,
      "messages.memoryOverwriteFail",
      messagesProblems,
      DEFAULTS.messages.memoryOverwriteFail,
    ),
    identicalLoopFail: messageTemplateOption(
      msg,
      "messages.identicalLoopFail",
      messagesProblems,
      DEFAULTS.messages.identicalLoopFail,
    ),
    chainCapFail: messageTemplateOption(
      msg,
      "messages.chainCapFail",
      messagesProblems,
      DEFAULTS.messages.chainCapFail,
    ),
    mcpSkillFail: messageTemplateOption(
      msg,
      "messages.mcpSkillFail",
      messagesProblems,
      DEFAULTS.messages.mcpSkillFail,
    ),
    mcpSkillHints: mcpSkillHintsOption(
      msg,
      "messages.mcpSkillHints",
      messagesProblems,
      DEFAULTS.messages.mcpSkillHints as Record<string, string>,
    ),
    descriptionHint: messageTemplateOption(
      msg,
      "messages.descriptionHint",
      messagesProblems,
      DEFAULTS.messages.descriptionHint,
    ),
    problems: messagesProblems,
  }
  // Presentation problems have no deny channel — their surfacing channel is the
  // top-level problems part ("loud startup warning naming the path", design §C).
  problems.push(...messagesProblems)

  // --- primer group (Phase 3, presentation domain) ---
  const primerRaw = o.primer
  const primerOK = !("primer" in o) || isPlainObject(primerRaw)
  if ("primer" in o && !primerOK) {
    problems.push(
      `options group "primer" must be a plain object (got ${fmtGot(primerRaw)}); ignored (presentation warning)`,
    )
  }
  const prm = primerOK && isPlainObject(primerRaw) ? primerRaw : {}
  if (primerOK && "primer" in o) scanUnknownKeys("primer", prm, problems)
  const primer = resolvePrimer(prm, problems, !primerOK)

  // Surface EVERY problem (enforcement-group errors included) in the top-level list —
  // the plugin renders it as the config-problems system part (RULES §6.3). Pre-flip the
  // enforcement-group pools surfaced only via their CONFIG-ERROR denies; post-flip a
  // broken group whose shaping option is itself broken covers nothing (its scope
  // derives from the empty defaults), so the system part is the ONLY surfacing channel
  // it has — silent degradation is not acceptable.
  problems.push(
    ...dispatch.problems,
    ...skills.problems,
    ...gates.problems,
    ...gates.memoryMandateProblems,
    ...structure.problems,
    ...structure.stitchProblems,
    ...paths.problems,
    ...caps.identicalProblems,
    ...caps.chainMaxProblems,
    ...caps.markerProblems,
  )

  // Non-object raw: every enforcement guard fails closed (see totalBreak above), and the
  // clause itself is part of the surfaced problem list. The caps reflect the effective
  // values (1), matching how the guards treat them — never "guard off".
  if (totalBreak.length > 0) {
    problems.push(...totalBreak)
    dispatch.problems.push(...totalBreak)
    skills.problems.push(...totalBreak)
    gates.problems.push(...totalBreak)
    gates.memoryMandateProblems.push(...totalBreak)
    structure.problems.push(...totalBreak)
    structure.stitchProblems.push(...totalBreak)
    paths.problems.push(...totalBreak)
    caps.identicalProblems.push(...totalBreak)
    caps.chainMaxProblems.push(...totalBreak)
    caps.identicalMax = 1
    caps.chainMax = 1
  }

  return { resolved: deepFreeze({ dispatch, skills, gates, structure, paths, caps, messages, primer }), problems }
}
