// src/config.ts — Flexibility Phase 1: the options resolver for the dispatch-policy
// plugin (task-phase1-brief.md; design flex-design-report.md §C/§D, owner rulings
// 2026-11-07 — do not re-litigate).
//
// `resolveOptions(raw)` validates + merges the raw `ctx.options` object (untyped flat
// JSON per the OpenCode plugin SDK — the plugin owns 100% of validation) over DEFAULTS.
// Phase 1 wires exactly the 11 enforcement knobs enumerated in the brief:
//   dispatch.tools / dispatch.forbiddenAgents / dispatch.requireBackground /
//   dispatch.requireAgent / skills.mandatory / skills.orchestrator / gates.tools /
//   gates.exaSubstring / caps.identicalMax / caps.chainMax / caps.chainOverrideMarker
// (the brief's "16" count enumerates these 11; the remaining taxonomy groups are
// Phase-2/3 per the explicit non-goals and are warn+ignored if present).
//
// Owner-approved HYBRID failure semantics (§C(c)):
//   - Enforcement groups (dispatch, skills, gates, caps): an invalid option fails THAT
//     guard closed — the guard denies affected calls with a CONFIG-ERROR deny naming the
//     option path. Never silent fallback, never silent disable.
//   - Invalid cap ⇒ EFFECTIVE CAP 1 + CONFIG-ERROR deny (never "guard off").
//   - Empty skills.mandatory / skills.orchestrator ⇒ valid + startup warning (owner
//     ruling 2), honored; the MEMORY.md read requirement is a separate (Phase-2 readTargets)
//     concern and stays.
//   - Unknown keys anywhere ⇒ warn (problem recorded) + ignore (owner ruling 4).
//   - Cap disable representation: `null` means the guard is off (owner ruling 3).
//   - A raw options value that is present but not a plain object cannot name a group, so
//     EVERY enforcement group fails closed (the plugin must never be silently weaker).
//
// Every problem is a plain human-readable string. The union of all problems (errors and
// warnings) is surfaced by the plugin as a system text part AFTER the PRIMER part
// (session.context); the per-guard error subsets live on the resolved config and drive
// the CONFIG-ERROR denies. Hand-rolled validation — zero new dependencies (owner rule).
//
// With NO raw options (ctx.options absent — the file-discovery install and the whole
// existing 80-test suite) the resolver returns pure DEFAULTS values and zero problems.

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
    problems: string[]
  }
  caps: {
    identicalMax: number | null
    chainMax: number | null
    chainOverrideMarker: string
    identicalProblems: string[] // caps.identicalMax errors (effective cap 1)
    chainMaxProblems: string[] // caps.chainMax errors (effective cap 1)
    markerProblems: string[] // caps.chainOverrideMarker errors (escape fails closed)
  }
}

export type ResolveResult = { resolved: ResolvedConfig; problems: string[] }

// Groups recognized by the taxonomy (DEFAULTS). structure/paths/messages/primer exist in
// DEFAULTS but are NOT wired in Phase 1 — if present they warn + are ignored entirely.
const KNOWN_GROUPS = ["dispatch", "skills", "gates", "caps", "structure", "paths", "messages", "primer"]
const UNWIRED_PHASE: Record<string, string> = {
  structure: "Phase 2",
  paths: "Phase 2",
  messages: "Phase 3",
  primer: "Phase 3",
}
// Known keys per wired group; anything else inside a group is an unknown key (warn+ignore).
const GROUP_KEYS: Record<string, string[]> = {
  dispatch: ["tools", "forbiddenAgents", "requireBackground", "requireAgent"],
  skills: ["mandatory", "orchestrator"],
  gates: ["tools", "exaSubstring"],
  caps: ["identicalMax", "chainMax", "chainOverrideMarker"],
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

function nonEmptyStringOption(
  raw: Record<string, unknown>,
  path: string,
  problems: string[],
  fallback: string,
  consequence: string,
): string {
  const v = raw[keyOf(path)]
  if (v === undefined) return fallback
  if (typeof v !== "string" || v.length === 0) {
    problems.push(`${path} must be a non-empty string (got ${fmtGot(v)}); ${consequence}`)
    return fallback
  }
  return v
}

// gates.exaSubstring (design §A #8): `null` removes the substring rule; a non-empty
// string is the rule; anything else breaks the gate guard.
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
  if (typeof v === "string" && v.length > 0) return v
  problems.push(`${path} must be a non-empty string or null (got ${fmtGot(v)}); ${consequence}`)
  return fallback
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
    for (const [group, phase] of Object.entries(UNWIRED_PHASE)) {
      if (group in (raw as Record<string, unknown>)) {
        problems.push(`options group "${group}" is not configurable until ${phase} — ignored (warning)`)
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
  // Owner ruling 2: empty skill lists are VALID + startup warning (honored, not broken).
  if (mandatory.length === 0) {
    problems.push("skills.mandatory is empty — the base skill gate is inert for skills (warning)")
  }
  if (orchestrator.length === 0) {
    problems.push("skills.orchestrator is empty — the dispatch preflight is inert (warning)")
  }
  const skills: ResolvedConfig["skills"] = { mandatory, orchestrator, problems: skillsProblems }

  // --- gates group ---
  const gatesProblems: string[] = []
  const gatesRaw = o.gates
  const gatesOK = !("gates" in o) || isPlainObject(gatesRaw)
  if ("gates" in o && !gatesOK) {
    gatesProblems.push(
      `options group "gates" must be a plain object (got ${fmtGot(gatesRaw)}); skill gate failing closed`,
    )
  }
  const g = gatesOK && isPlainObject(gatesRaw) ? gatesRaw : {}
  if (gatesOK && "gates" in o) scanUnknownKeys("gates", g, problems)
  const gates: ResolvedConfig["gates"] = {
    tools: stringArrayOption(g, "gates.tools", gatesProblems, DEFAULTS.gates.tools, "skill gate failing closed"),
    exaSubstring: exaSubstringOption(
      g,
      "gates.exaSubstring",
      gatesProblems,
      DEFAULTS.gates.exaSubstring,
      "skill gate failing closed",
    ),
    problems: gatesProblems,
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
  const marker = nonEmptyStringOption(
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

  // Non-object raw: every enforcement guard fails closed (see totalBreak above), and the
  // clause itself is part of the surfaced problem list. The caps reflect the effective
  // values (1), matching how the guards treat them — never "guard off".
  if (totalBreak.length > 0) {
    problems.push(...totalBreak)
    dispatch.problems.push(...totalBreak)
    skills.problems.push(...totalBreak)
    gates.problems.push(...totalBreak)
    caps.identicalProblems.push(...totalBreak)
    caps.chainMaxProblems.push(...totalBreak)
    caps.identicalMax = 1
    caps.chainMax = 1
  }

  return { resolved: deepFreeze({ dispatch, skills, gates, caps }), problems }
}
