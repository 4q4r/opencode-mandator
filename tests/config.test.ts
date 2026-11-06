// tests/config.test.ts — Flexibility Phase 1: resolveOptions + the 11 wired enforcement
// knobs (task-phase1-brief.md). Contract:
//   - resolveOptions(raw) merges raw ctx.options over DEFAULTS with the owner-approved
//     HYBRID failure semantics (design §C(c)): an invalid option in an enforcement group
//     fails THAT guard closed with a CONFIG-ERROR deny naming the option path; invalid
//     caps mean effective cap 1; empty skills lists are valid + warning; unknown keys are
//     warn + ignore (owner ruling 2026-11-07).
//   - With NO options the plugin resolves to pure defaults (the existing 80-test suite
//     exercises exactly this path, untouched).
// This file has its own module state (bun isolates per test file): the harness calls
// plugin.setup(ctx) per test with ctx.options set, so every knob test pins a real
// deny/allow behavior through the hooks. Session IDs are unique per test (the per-session
// Maps live at module scope and outlive individual setup() calls).
import { describe, expect, test } from "bun:test"
import os from "node:os"
import plugin from "../src/dispatch-policy.ts"
import { DEFAULTS, deepFreeze } from "../src/defaults.ts"
import { resolveOptions } from "../src/config.ts"
import * as pkg from "../plugin-package/index.ts"

// --- harness (mirrors tests/dispatch-policy.test.ts, plus an options plumb) ---
const hooks: Record<string, (event: any) => any> = {}

const ctx: any = {
  options: undefined as unknown,
  tool: {
    hook: async (name: string, cb: (e: any) => any) => {
      hooks[`tool.${name}`] = cb
    },
    transform: async (cb: (editor: any) => void) => {
      const tools: Record<string, { description: string }> = { subagent: { description: "ORIG" } }
      cb({ update: (id: string, fn: (t: any) => void) => { if (tools[id]) fn(tools[id]) } })
    },
  },
  session: { hook: async (name: string, cb: (e: any) => any) => { hooks[`session.${name}`] = cb } },
}

const setupWith = async (options: unknown) => {
  ctx.options = options
  await plugin.setup(ctx)
}

const denyMsg = async (event: any): Promise<string | null> => {
  try {
    await hooks["tool.execute.before"](event)
    return null
  } catch (e: any) {
    return String(e.message)
  }
}
const loadSkill = (sid: string, id: string, status = "completed") =>
  hooks["tool.execute.after"]({ tool: "skill", sessionID: sid, status, input: { id } })
const loadRead = (sid: string, p: string, status = "completed") =>
  hooks["tool.execute.after"]({ tool: "read", sessionID: sid, status, input: { path: p } })

const HOME = os.homedir()

// ext 5/6.1 fixtures (same shape as the main suite): a compliant fresh brief satisfies
// structure + memory mandate; a compliant stitch prompt satisfies the 4-block profile.
const GOOD_PROMPT =
  "Role: you are a senior Go engineer. Task: fix the race in the ingest loop. " +
  "Context: the worker pool drops events under load; repro in tests/race_test.go. " +
  "Constraints: no new dependencies; the public API must stay stable; all tests must pass. " +
  "Output format: root-cause summary, the diff, and test results. " +
  "Before starting, read ~/.config/opencode/MEMORY.md and memory/topics/workflow.md; list what you read in your report."

const complyAll = (sid: string) => {
  for (const s of [
    "brainstorming",
    "grilling",
    "build-with-exa",
    "context7-mcp",
    "subagent-driven-development",
    "dispatching-parallel-agents",
    "prompt-engineering-patterns",
  ])
    loadSkill(sid, s)
  loadRead(sid, `${HOME}/.config/opencode/MEMORY.md`)
  loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow.md`)
  loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
}

// Fresh dispatch helper for breaker tests (compliant session + structured brief).
const freshDispatch = (sid: string, agent: string, prompt: string) =>
  denyMsg({ tool: "subagent", sessionID: sid, input: { agent, background: true, prompt } })
const continuation = (sid: string, prompt: string, childID: string) =>
  denyMsg({ tool: "subagent", sessionID: sid, input: { agent: "code-reviewer", background: true, prompt, sessionID: childID } })

// --- resolveOptions: pure resolution semantics ---
describe("config — resolveOptions resolution semantics", () => {
  test("no raw (undefined) → pure DEFAULTS values, zero problems", () => {
    const { resolved, problems } = resolveOptions(undefined)
    expect(problems).toEqual([])
    expect(resolved.dispatch.tools).toEqual(DEFAULTS.dispatch.tools)
    expect(resolved.dispatch.forbiddenAgents).toEqual(DEFAULTS.dispatch.forbiddenAgents)
    expect(resolved.dispatch.requireBackground).toBe(true)
    expect(resolved.dispatch.requireAgent).toBe(true)
    expect(resolved.skills.mandatory).toEqual(DEFAULTS.skills.mandatory)
    expect(resolved.skills.orchestrator).toEqual(DEFAULTS.skills.orchestrator)
    expect(resolved.gates.tools).toEqual(DEFAULTS.gates.tools)
    expect(resolved.gates.exaSubstring).toBe("exa")
    expect(resolved.caps.identicalMax).toBe(4)
    expect(resolved.caps.chainMax).toBe(6)
    expect(resolved.caps.chainOverrideMarker).toBe("[chain-cap-override]")
    expect(resolved.dispatch.problems).toEqual([])
    expect(resolved.skills.problems).toEqual([])
    expect(resolved.gates.problems).toEqual([])
    expect(resolved.caps.identicalProblems).toEqual([])
    expect(resolved.caps.chainMaxProblems).toEqual([])
    expect(resolved.caps.markerProblems).toEqual([])
  })

  test("empty object raw → same as absent", () => {
    const a = resolveOptions(undefined)
    const b = resolveOptions({})
    expect(b.problems).toEqual([])
    expect(b.resolved).toEqual(a.resolved)
  })

  test("partial override merges over defaults (only named keys change)", () => {
    const { resolved, problems } = resolveOptions({ caps: { chainMax: 10 } })
    expect(problems).toEqual([])
    expect(resolved.caps.chainMax).toBe(10)
    expect(resolved.caps.identicalMax).toBe(4) // untouched knob stays at default
    expect(resolved.caps.chainOverrideMarker).toBe("[chain-cap-override]")
    expect(resolved.dispatch.requireBackground).toBe(true)
  })

  test("resolved config is deep-frozen", () => {
    const { resolved } = resolveOptions({})
    expect(Object.isFrozen(resolved)).toBeTrue()
    expect(Object.isFrozen(resolved.dispatch)).toBeTrue()
    expect(Object.isFrozen(resolved.skills.mandatory)).toBeTrue()
    expect(() => {
      ;(resolved.caps as { chainMax: number }).chainMax = 99
    }).toThrow()
  })

  test("unknown keys (top-level and nested) warn + ignore", () => {
    const { resolved, problems } = resolveOptions({ dispatchx: 1, dispatch: { toolz: true } })
    expect(problems).toContain(`unknown option key "dispatchx" ignored (warning)`)
    expect(problems).toContain(`unknown option key "dispatch.toolz" ignored (warning)`)
    // ignored: resolved stays at defaults, no group broke
    expect(resolved.dispatch.problems).toEqual([])
    expect(resolved.dispatch.forbiddenAgents).toEqual(DEFAULTS.dispatch.forbiddenAgents)
  })

  test("unwired groups (structure/paths/messages/primer) warn + ignore, named with their phase", () => {
    const { resolved, problems } = resolveOptions({ structure: {}, paths: {}, messages: {}, primer: {} })
    expect(problems).toContain(`options group "structure" is not configurable until Phase 2 — ignored (warning)`)
    expect(problems).toContain(`options group "paths" is not configurable until Phase 2 — ignored (warning)`)
    expect(problems).toContain(`options group "messages" is not configurable until Phase 3 — ignored (warning)`)
    expect(problems).toContain(`options group "primer" is not configurable until Phase 3 — ignored (warning)`)
    expect(resolved.gates.problems).toEqual([]) // nothing broke
  })

  test("empty skills lists are valid + warned, and honored", () => {
    const { resolved, problems } = resolveOptions({ skills: { mandatory: [], orchestrator: [] } })
    expect(problems).toContain("skills.mandatory is empty — the base skill gate is inert for skills (warning)")
    expect(problems).toContain("skills.orchestrator is empty — the dispatch preflight is inert (warning)")
    expect(resolved.skills.mandatory).toEqual([])
    expect(resolved.skills.orchestrator).toEqual([])
    expect(resolved.skills.problems).toEqual([]) // warnings do NOT break the guard
  })

  test("non-object raw → enforcement fails closed (every group broken, effective caps 1)", () => {
    const { resolved, problems } = resolveOptions("probe-not-an-object")
    expect(problems).toContain(`options must be a plain object (got "probe-not-an-object"); enforcement failing closed`)
    expect(resolved.dispatch.problems.length).toBeGreaterThan(0)
    expect(resolved.skills.problems.length).toBeGreaterThan(0)
    expect(resolved.gates.problems.length).toBeGreaterThan(0)
    expect(resolved.caps.identicalProblems.length).toBeGreaterThan(0)
    expect(resolved.caps.chainMaxProblems.length).toBeGreaterThan(0)
    expect(resolved.caps.identicalMax).toBe(1) // effective cap 1, never "guard off"
    expect(resolved.caps.chainMax).toBe(1)
  })

  test("deep-frozen helper still exported for resolved configs", () => {
    expect(typeof deepFreeze).toBe("function")
  })
})

// --- absent options through the plugin: the defaults path the existing 80 tests use ---
describe("config — absent options = pure defaults (parity path)", () => {
  test("setup without options → normal gate deny, no problems part, PRIMER byte-identical", async () => {
    await setupWith(undefined)
    const msg = await denyMsg({ tool: "shell", sessionID: "sess-cfg-parity", input: {} })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "brainstorming"')
    expect(msg!).toContain('skill "context7-mcp"')
    expect(msg!).toContain("read of ~/.config/opencode/MEMORY.md")
    expect(msg!).not.toContain("config-error")
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(1) // PRIMER only — no config-problems part
    expect(sys[0]!.text).toBe(DEFAULTS.primer.text) // PRIMER text unchanged
  })
})

// --- per-knob override behavior (one deny/allow behavior per knob) ---
describe("config — per-knob override behavior", () => {
  test("dispatch.tools override: 'task' becomes the dispatch surface, 'subagent' leaves it", async () => {
    await setupWith({ dispatch: { tools: ["task"] } })
    // 'task' is now dispatch-shaped: the agent-missing ban fires on it at zero state.
    const mTask = await denyMsg({ tool: "task", sessionID: "sess-cfg-dtools", input: { background: true } })
    expect(mTask).not.toBeNull()
    expect(mTask!).toContain("missing a specialized agent type")
    // 'subagent' is no longer dispatch-shaped: the background ban does not apply to it.
    complyAll("sess-cfg-dtools-sub")
    const mSub = await denyMsg({
      tool: "subagent",
      sessionID: "sess-cfg-dtools-sub",
      input: { agent: "code-reviewer", background: false, prompt: "anything" },
    })
    expect(mSub).toBeNull() // passes: not dispatch-shaped (no bans/structure/breakers)
  })

  test("dispatch.forbiddenAgents list: deny when the agent matches ANY entry", async () => {
    await setupWith({ dispatch: { forbiddenAgents: ["general", "general-purpose"] } })
    const m1 = await denyMsg({ tool: "subagent", sessionID: "sess-cfg-fa1", input: { agent: "general", background: true } })
    expect(m1).not.toBeNull()
    expect(m1!).toContain("FORBIDDEN")
    expect(m1!).toContain('agent type "general"')
    const m2 = await denyMsg({ tool: "subagent", sessionID: "sess-cfg-fa2", input: { agent: "general-purpose", background: true } })
    expect(m2).not.toBeNull()
    expect(m2!).toContain("FORBIDDEN")
    expect(m2!).toContain('agent type "general-purpose"')
    // A specialized agent is not banned — its zero-state deny is the gate, not the ban.
    const m3 = await denyMsg({ tool: "subagent", sessionID: "sess-cfg-fa3", input: { agent: "code-reviewer", background: true } })
    expect(m3).not.toBeNull()
    expect(m3!).not.toContain("FORBIDDEN")
    expect(m3!).toContain("Owner mandate")
  })

  test("dispatch.requireBackground=false makes the background ban inert", async () => {
    await setupWith({ dispatch: { requireBackground: false } })
    complyAll("sess-cfg-nobg")
    const m = await freshDispatch("sess-cfg-nobg", "code-reviewer", GOOD_PROMPT)
    expect(m).toBeNull() // foreground dispatch passes with the knob off
    // the ban is really off: background explicitly false also passes
    const m2 = await denyMsg({
      tool: "subagent",
      sessionID: "sess-cfg-nobg",
      input: { agent: "trend-researcher", background: false, prompt: `${GOOD_PROMPT} Perspective: novelty.` },
    })
    expect(m2).toBeNull()
  })

  test("dispatch.requireAgent=false disables the agent-missing deny; the general ban still wins", async () => {
    await setupWith({ dispatch: { requireAgent: false } })
    complyAll("sess-cfg-noagent")
    const m = await denyMsg({
      tool: "subagent",
      sessionID: "sess-cfg-noagent",
      input: { background: true, prompt: GOOD_PROMPT }, // no agent at all
    })
    expect(m).toBeNull() // agent-missing deny is off
    const mGeneral = await denyMsg({
      tool: "subagent",
      sessionID: "sess-cfg-noagent2",
      input: { agent: "general", background: true, prompt: GOOD_PROMPT },
    })
    expect(mGeneral).not.toBeNull()
    expect(mGeneral!).toContain("FORBIDDEN") // the ban is independent of requireAgent
  })

  test("skills.mandatory=[] → base gate inert for skills (memory read still required)", async () => {
    await setupWith({ skills: { mandatory: [] } })
    const sid = "sess-cfg-nomand"
    loadRead(sid, `${HOME}/.config/opencode/MEMORY.md`)
    const m = await denyMsg({ tool: "shell", sessionID: sid, input: {} })
    expect(m).toBeNull() // no skills required; memory read satisfied
    // the read requirement itself is NOT part of the ruling — without it the gate still denies
    const m0 = await denyMsg({ tool: "shell", sessionID: "sess-cfg-nomand0", input: {} })
    expect(m0).not.toBeNull()
    expect(m0!).toContain("read of ~/.config/opencode/MEMORY.md")
    // dispatch preflight still demands the orchestrator set (separate knob)
    const mSub = await denyMsg({ tool: "subagent", sessionID: sid, input: { agent: "code-reviewer", background: true } })
    expect(mSub).not.toBeNull()
    expect(mSub!).toContain('skill "subagent-driven-development"')
    expect(mSub!).not.toContain('skill "brainstorming"') // mandatory list really is empty
  })

  test("skills.orchestrator=[] → subagent needs no orchestrator SKILLS (workflow reads stay: readTargets is Phase 2)", async () => {
    await setupWith({ skills: { orchestrator: [] } })
    const sid = "sess-cfg-noorch"
    for (const s of ["brainstorming", "grilling", "build-with-exa", "context7-mcp"]) loadSkill(sid, s)
    loadRead(sid, `${HOME}/.config/opencode/MEMORY.md`)
    // the workflow reads are NOT governed by the orchestrator knob (they are Phase-2
    // readTargets): until Phase 2 they stay demanded on the dispatch path.
    const mReads = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(mReads).not.toBeNull()
    expect(mReads!).toContain("workflow.md")
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow.md`)
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
    const m = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m).toBeNull() // no orchestrator skills required — only 4 base skills were ever loaded
  })

  test("gates.tools override: the exact-match gated set is authoritative", async () => {
    await setupWith({ gates: { tools: ["shell"] } })
    const zero = "sess-cfg-gtools"
    const mEdit = await denyMsg({ tool: "edit", sessionID: `${zero}-edit`, input: {} })
    expect(mEdit).toBeNull() // edit is no longer gated
    const mShell = await denyMsg({ tool: "shell", sessionID: `${zero}-shell`, input: {} })
    expect(mShell).not.toBeNull()
    expect(mShell!).toContain('skill "brainstorming"')
    // subagent left the gated set too: at zero state a compliant fresh brief passes the gate
    const mSub = await freshDispatch(`${zero}-sub`, "code-reviewer", GOOD_PROMPT)
    expect(mSub).toBeNull()
  })

  test("gates.exaSubstring: null removes the substring rule; a custom string re-aims it", async () => {
    await setupWith({ gates: { exaSubstring: null } })
    const mExa = await denyMsg({ tool: "exa_web_search_exa", sessionID: "sess-cfg-noexa", input: {} })
    expect(mExa).toBeNull() // exa tools ungated
    await setupWith({ gates: { exaSubstring: "zzz" } })
    const mZzz = await denyMsg({ tool: "zzz_probe_tool", sessionID: "sess-cfg-zzz", input: {} })
    expect(mZzz).not.toBeNull()
    expect(mZzz!).toContain('skill "brainstorming"') // the custom substring gates it
    const mExa2 = await denyMsg({ tool: "exa_web_search_exa", sessionID: "sess-cfg-zzz-exa", input: {} })
    expect(mExa2).toBeNull() // the rule no longer matches exa tools
  })

  test("caps.identicalMax=2 tightens the breaker (2nd identical dispatch denies)", async () => {
    await setupWith({ caps: { identicalMax: 2 } })
    const sid = "sess-cfg-icap2"
    complyAll(sid)
    expect(await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)).toBeNull()
    const m2 = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m2).not.toBeNull()
    expect(m2!).toContain("runaway-loop guard")
    expect(m2!).toContain("2")
  })

  test("caps.identicalMax=null turns the breaker off", async () => {
    await setupWith({ caps: { identicalMax: null } })
    const sid = "sess-cfg-icapnull"
    complyAll(sid)
    for (let i = 0; i < 6; i++) {
      expect(await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)).toBeNull()
    }
  })

  test("caps.chainMax=2 tightens the chain cap (3rd continuation denies with cap 2)", async () => {
    await setupWith({ caps: { chainMax: 2 } })
    const sid = "sess-cfg-ccap2"
    complyAll(sid)
    expect(await continuation(sid, "step 1", "ses_child_ccap2")).toBeNull()
    expect(await continuation(sid, "step 2", "ses_child_ccap2")).toBeNull()
    const m3 = await continuation(sid, "step 3", "ses_child_ccap2")
    expect(m3).not.toBeNull()
    expect(m3!).toContain("continuation chain reached 3")
    expect(m3!).toContain("cap 2")
  })

  test("caps.chainMax=null turns the chain cap off", async () => {
    await setupWith({ caps: { chainMax: null } })
    const sid = "sess-cfg-ccapnull"
    complyAll(sid)
    for (let i = 1; i <= 8; i++) {
      expect(await continuation(sid, `step ${i}`, "ses_child_ccapnull")).toBeNull()
    }
  })

  test("caps.chainOverrideMarker re-aims the one-shot escape", async () => {
    await setupWith({ caps: { chainOverrideMarker: "[let-me-through]" } })
    const sid = "sess-cfg-marker"
    complyAll(sid)
    for (let i = 1; i <= 6; i++) {
      expect(await continuation(sid, `step ${i}`, "ses_child_marker")).toBeNull()
    }
    // the DEFAULT marker no longer unlocks
    const m7 = await continuation(sid, "step 7 [chain-cap-override] owner approved", "ses_child_marker")
    expect(m7).not.toBeNull()
    expect(m7!).toContain("continuation chain reached 7")
    // the custom marker does (marker + non-empty reason)
    const m8 = await continuation(sid, "step 8 [let-me-through] owner approved one-shot", "ses_child_marker")
    expect(m8).toBeNull()
  })

  test("config problems surface as a system text part AFTER the PRIMER", async () => {
    await setupWith({ dispatch: { toolz: 1 }, skills: { mandatory: [] } })
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(2)
    expect(sys[0]!.text).toBe(DEFAULTS.primer.text) // PRIMER part unchanged, first
    expect(sys[1]!.type).toBe("text")
    expect(sys[1]!.text).toContain("dispatch-policy config problems:")
    expect(sys[1]!.text).toContain(`unknown option key "dispatch.toolz" ignored (warning)`)
    expect(sys[1]!.text).toContain("skills.mandatory is empty")
    // clean options → exactly one part again
    await setupWith({})
    const clean: any[] = []
    await hooks["session.context"]({ system: clean, messages: [] })
    expect(clean.length).toBe(1)
  })
})

// --- invalid input per group: hybrid failure semantics with teeth ---
describe("config — invalid options fail closed per guard (CONFIG-ERROR denies)", () => {
  test("dispatch.requireBackground invalid → dispatch guard denies with CONFIG-ERROR naming the path; other guards unaffected", async () => {
    await setupWith({ dispatch: { requireBackground: "yes" } })
    complyAll("sess-cfg-badbg")
    const m = await freshDispatch("sess-cfg-badbg", "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("dispatch.requireBackground")
    expect(m!).toContain(`got "yes"`)
    expect(m!).toContain("failing closed")
    // the gate is a different guard: a compliant shell call still passes
    const mShell = await denyMsg({ tool: "shell", sessionID: "sess-cfg-badbg-shell", input: {} })
    complyAll("sess-cfg-badbg-shell")
    const mShellOk = await denyMsg({ tool: "shell", sessionID: "sess-cfg-badbg-shell", input: {} })
    expect(mShell).not.toBeNull() // zero-state shell → normal gate deny (not config-error)
    expect(mShell!).not.toContain("config-error")
    expect(mShellOk).toBeNull()
  })

  test("skills.mandatory invalid → gated calls deny with CONFIG-ERROR naming the path; bans keep precedence", async () => {
    await setupWith({ skills: { mandatory: "brainstorming" } })
    const m = await denyMsg({ tool: "shell", sessionID: "sess-cfg-badmand", input: {} })
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("skills.mandatory")
    expect(m!).toContain(`got "brainstorming"`)
    // dispatch bans are a different guard and keep precedence: general still gets FORBIDDEN
    const mGeneral = await denyMsg({ tool: "subagent", sessionID: "sess-cfg-badmand2", input: { agent: "general", background: true } })
    expect(mGeneral).not.toBeNull()
    expect(mGeneral!).toContain("FORBIDDEN")
    expect(mGeneral!).not.toContain("config-error")
  })

  test("gates.tools invalid → formerly-gated calls deny with CONFIG-ERROR; ungated tools pass", async () => {
    await setupWith({ gates: { tools: "shell" } })
    const mEdit = await denyMsg({ tool: "edit", sessionID: "sess-cfg-badgt", input: {} })
    expect(mEdit).not.toBeNull()
    expect(mEdit!).toContain("[config-error]")
    expect(mEdit!).toContain("gates.tools")
    expect(mEdit!).toContain(`got "shell"`)
    const mGrep = await denyMsg({ tool: "grep", sessionID: "sess-cfg-badgt2", input: {} })
    expect(mGrep).toBeNull() // never gated, unaffected
  })

  test("caps.identicalMax invalid → effective cap 1 + CONFIG-ERROR deny on the fresh path; chain guard unaffected", async () => {
    await setupWith({ caps: { identicalMax: "abc" } })
    const sid = "sess-cfg-badicap"
    complyAll(sid)
    const m = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("caps.identicalMax")
    expect(m!).toContain(`got "abc"`)
    expect(m!).toContain("effective cap 1")
    // the chain guard is a different sub-guard: its first continuation still passes
    expect(await continuation(sid, "please continue", "ses_child_badicap")).toBeNull()
  })

  test("caps.chainMax invalid (0) → effective cap 1: first continuation passes, second CONFIG-ERRORs", async () => {
    await setupWith({ caps: { chainMax: 0 } })
    const sid = "sess-cfg-badccap"
    complyAll(sid)
    expect(await continuation(sid, "step 1", "ses_child_badccap")).toBeNull() // 1 > 1 is false
    const m2 = await continuation(sid, "step 2", "ses_child_badccap")
    expect(m2).not.toBeNull()
    expect(m2!).toContain("[config-error]")
    expect(m2!).toContain("caps.chainMax")
    expect(m2!).toContain("got 0")
    expect(m2!).toContain("effective cap 1")
  })

  test("caps.chainOverrideMarker invalid → over-cap continuations CONFIG-ERROR (escape cannot be honored); under-cap passes", async () => {
    await setupWith({ caps: { chainMax: 2, chainOverrideMarker: "" } })
    const sid = "sess-cfg-badmarker"
    complyAll(sid)
    expect(await continuation(sid, "step 1", "ses_child_badmarker")).toBeNull()
    expect(await continuation(sid, "step 2", "ses_child_badmarker")).toBeNull() // not over cap yet
    const m3 = await continuation(sid, "step 3 [chain-cap-override] even a marker cannot help", "ses_child_badmarker")
    expect(m3).not.toBeNull()
    expect(m3!).toContain("[config-error]")
    expect(m3!).toContain("caps.chainOverrideMarker")
    expect(m3!).toContain(`got ""`)
  })

  test("unknown keys are warn+ignore at runtime: defaults keep enforcing, warnings recorded", async () => {
    await setupWith({ dispatch: { toolz: 1 }, bogus: true })
    const mGeneral = await denyMsg({ tool: "subagent", sessionID: "sess-cfg-unknown", input: { agent: "general", background: true } })
    expect(mGeneral).not.toBeNull()
    expect(mGeneral!).toContain("FORBIDDEN") // default enforcement intact
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(2)
    expect(sys[1]!.text).toContain(`unknown option key "dispatch.toolz" ignored (warning)`)
    expect(sys[1]!.text).toContain(`unknown option key "bogus" ignored (warning)`)
  })
})

// --- dual-mode package layout: the package-directory entry re-exports the plugin ---
describe("config — dual-mode package layout", () => {
  test("plugin-package entry re-exports the same plugin (identity) and the test seams", async () => {
    expect(pkg.default).toBe(plugin) // same module instance, not a copy
    expect(typeof (pkg as any)._testStat?.fn).toBe("function")
    expect(typeof (pkg as any)._djb2?.fn).toBe("function")
  })
})
