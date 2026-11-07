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
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import os from "node:os"
import plugin, { _testStat } from "../src/dispatch-policy.ts"
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
      transformed = tools // captured like tests/dispatch-policy.test.ts (Phase-3 descriptionHint tests)
    },
  },
  session: { hook: async (name: string, cb: (e: any) => any) => { hooks[`session.${name}`] = cb } },
}

let transformed: Record<string, { description: string }> | null = null

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

  test("messages/primer are wired since Phase 3 — no unwired-group warnings remain", () => {
    const { resolved, problems } = resolveOptions({ structure: {}, paths: {}, messages: {}, primer: {} })
    expect(problems.some((p) => p.includes("not configurable"))).toBeFalse()
    expect(resolved.messages.problems).toEqual([]) // nothing broke
    expect(resolved.primer.problems).toEqual([])
    expect(resolved.primer.text).toBe(DEFAULTS.primer.text)
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

// ============================================================================
// Flexibility Phase 2 — the remaining enforcement-surface options (+10; 26 total):
// gates.mcpRequirements / gates.readTargets / gates.memoryMandatePattern /
// structure.blocks / structure.subagentProfile / structure.stitchProfile /
// structure.stitchPromptTools / structure.stitchMinPrompt / paths.memoryIndex /
// paths.memoryTree. Same hybrid failure semantics as Phase 1: an invalid option
// fails THAT guard closed with a CONFIG-ERROR naming the option path (per-guard
// granularity: memory-mandate and stitch pools are separate sub-guards); unknown
// keys warn+ignore; defaults do not change.
// ============================================================================

// Custom (non-Latin) block vocabulary: Cyrillic block names + RU-only patterns.
const RU_BLOCKS = {
  role: { name: "Роль", pattern: "(роль\\s*:|ты\\s+—|выступаешь|acting as)" },
  task: { name: "Задача", pattern: "(задач|цель|миссия)" },
  context: { name: "Контекст", pattern: "(контекст|предыстория|фон\\b)" },
  constraints: { name: "Ограничения", pattern: "(ограничен|требован|правил|запрещ|нельзя)" },
  output: { name: "Формат вывода", pattern: "(формат|результат|отч[её]т|итог)" },
}

// A fully RU structured brief: satisfies the RU block vocabulary + the default
// memory-mandate pattern («глобальную память» + MEMORY.md).
const RU_BRIEF =
  "Роль: ты — старший Go-инженер. Задача: починить гонку в цикле ingest. " +
  "Контекст: пул воркеров теряет события под нагрузкой; репро в tests/race_test.go. " +
  "Ограничения: никаких новых зависимостей; публичный API стабилен; все тесты зелёные. " +
  "Формат вывода: резюме причины, дифф и результаты тестов. " +
  "Перед стартом обязательно прочитай глобальную память ~/.config/opencode/MEMORY.md и memory/topics/*."

// Same brief WITHOUT the output sentence and with a mandate sentence that carries no
// output-block keyword: exactly the «Формат вывода» block is missing.
const RU_BRIEF_NO_OUTPUT =
  "Роль: ты — старший Go-инженер. Задача: починить гонку в цикле ingest. " +
  "Контекст: пул воркеров теряет события под нагрузкой; репро в tests/race_test.go. " +
  "Ограничения: никаких новых зависимостей; публичный API стабилен; все тесты зелёные. " +
  "Перед стартом обязательно прочитай глобальную память ~/.config/opencode/MEMORY.md и memory/topics/*."

// English-structured brief whose memory mandate is RU-ONLY: matches the DEFAULT
// mandate pattern («глобальную память») but NOT an ASCII-only override pattern.
const RU_MANDATE_PROMPT =
  "Role: you are a senior Go engineer. Task: fix the race in the ingest loop. " +
  "Context: the worker pool drops events under load; repro in tests/race_test.go. " +
  "Constraints: no new dependencies; the public API must stay stable; all tests must pass. " +
  "Output format: root-cause summary, the diff, and test results. " +
  "Перед стартом обязательно прочитай глобальную память и перечисли прочитанное."

// Long (>120 chars) prompt that matches NO default block: the stitch check denies it.
const BAD_STITCH_PROMPT =
  "Make a pretty landing page with a hero section, some cards, and a footer. " +
  "Keep it minimal and modern, dark theme, rounded corners, subtle animations everywhere."

describe("config Phase 2 — resolveOptions: gates/structure/paths resolution semantics", () => {
  test("no raw → new Phase-2 fields resolve to pure DEFAULTS values, zero problems", () => {
    const { resolved, problems } = resolveOptions(undefined)
    expect(problems).toEqual([])
    expect(resolved.gates.mcpRequirements).toEqual(DEFAULTS.gates.mcpRequirements)
    expect(resolved.gates.readTargets).toEqual(DEFAULTS.gates.readTargets)
    expect(resolved.gates.memoryMandatePattern).toBe(DEFAULTS.gates.memoryMandatePattern)
    expect(resolved.gates.problems).toEqual([])
    expect(resolved.gates.memoryMandateProblems).toEqual([])
    expect(resolved.structure.blocks).toEqual(DEFAULTS.structure.blocks)
    expect(resolved.structure.subagentProfile).toEqual(DEFAULTS.structure.subagentProfile)
    expect(resolved.structure.stitchProfile).toEqual(DEFAULTS.structure.stitchProfile)
    expect(resolved.structure.stitchPromptTools).toEqual(DEFAULTS.structure.stitchPromptTools)
    expect(resolved.structure.stitchMinPrompt).toBe(120)
    expect(resolved.structure.problems).toEqual([])
    expect(resolved.structure.stitchProblems).toEqual([])
    expect(resolved.paths.memoryIndex).toBe(DEFAULTS.paths.memoryIndex)
    expect(resolved.paths.memoryTree).toBe(DEFAULTS.paths.memoryTree)
    expect(resolved.paths.problems).toEqual([])
  })

  test("structure.blocks override REPLACES the record (swap-the-whole-set semantics)", () => {
    const { resolved, problems } = resolveOptions({ structure: { blocks: RU_BLOCKS } })
    expect(problems).toEqual([])
    expect(resolved.structure.blocks).toEqual(RU_BLOCKS)
    expect(resolved.structure.blocks.role?.name).toBe("Роль") // custom vocabulary kept
    expect(resolved.structure.subagentProfile).toEqual(DEFAULTS.structure.subagentProfile) // untouched knob
    expect(resolved.structure.problems).toEqual([])
  })

  test("gates.mcpRequirements / gates.readTargets overrides replace the tables", () => {
    const mcp = [{ prefix: "acme_", skill: "acme-skill" }]
    const targets = [
      { key: "memory", suffix: ".config/acme/MEMORY.md" },
      { key: "team", suffix: ".config/acme/team.md" },
    ]
    const { resolved, problems } = resolveOptions({ gates: { mcpRequirements: mcp, readTargets: targets } })
    expect(problems).toEqual([])
    expect(resolved.gates.mcpRequirements).toEqual(mcp)
    expect(resolved.gates.readTargets).toEqual(targets)
    expect(resolved.gates.problems).toEqual([])
    expect(DEFAULTS.gates.mcpRequirements).toEqual([
      { prefix: "context7", skill: "context7-mcp" },
      { prefix: "adb_mcp", skill: "adb-mcp" },
    ]) // defaults untouched
  })

  test("invalid regex source in blocks → problem names structure.blocks.<key>.pattern; blocks fall back to defaults", () => {
    const { resolved } = resolveOptions({
      structure: { blocks: { ...RU_BLOCKS, role: { name: "Role", pattern: "((" } } },
    })
    expect(
      resolved.structure.problems.some((p) =>
        p.startsWith("structure.blocks.role.pattern must be a valid regex source"),
      ),
    ).toBeTrue()
    expect(resolved.structure.problems.some((p) => p.includes("structure guard failing closed"))).toBeTrue()
    expect(resolved.structure.blocks).toEqual(DEFAULTS.structure.blocks) // whole-option fallback
    expect(resolved.structure.problems.length).toBeGreaterThan(0) // the guard is marked broken
  })

  test("invalid blocks entry shape (missing name) → problem names structure.blocks.<key>", () => {
    const { resolved } = resolveOptions({
      structure: { blocks: { task: { pattern: "(задач)" } } }, // no name
    })
    expect(
      resolved.structure.problems.some((p) =>
        p.startsWith("structure.blocks.task must be an object with non-empty string"),
      ),
    ).toBeTrue()
    expect(resolved.structure.blocks).toEqual(DEFAULTS.structure.blocks)
  })

  test("profile referencing an unknown block → problem names structure.subagentProfile; structure guard broken", () => {
    const { resolved } = resolveOptions({ structure: { subagentProfile: ["role", "tasks"] } })
    expect(
      resolved.structure.problems.some((p) =>
        p.includes('structure.subagentProfile references unknown block key "tasks"'),
      ),
    ).toBeTrue()
    expect(resolved.structure.problems.some((p) => p.includes("structure guard failing closed"))).toBeTrue()
    expect(resolved.structure.subagentProfile).toEqual(DEFAULTS.structure.subagentProfile) // fallback
  })

  test("stitchProfile referencing an unknown block → problem names structure.stitchProfile", () => {
    const { resolved } = resolveOptions({ structure: { stitchProfile: ["task", "outputz"] } })
    expect(
      resolved.structure.problems.some((p) =>
        p.includes('structure.stitchProfile references unknown block key "outputz"'),
      ),
    ).toBeTrue()
    expect(resolved.structure.stitchProfile).toEqual(DEFAULTS.structure.stitchProfile)
  })

  test("mcpRequirements invalid shape → gates.problems name the path; readTargets invalid shape → same pool", () => {
    const a = resolveOptions({ gates: { mcpRequirements: [{ prefix: "acme_" }] } }) // missing skill
    expect(
      a.resolved.gates.problems.some((p) =>
        p.startsWith("gates.mcpRequirements must be an array of {prefix, skill}"),
      ),
    ).toBeTrue()
    expect(a.resolved.gates.mcpRequirements).toEqual(DEFAULTS.gates.mcpRequirements)
    const b = resolveOptions({ gates: { readTargets: "MEMORY.md" } })
    expect(
      b.resolved.gates.problems.some((p) => p.startsWith("gates.readTargets must be an array of {key, suffix}")),
    ).toBeTrue()
    expect(b.resolved.gates.readTargets).toEqual(DEFAULTS.gates.readTargets)
  })

  test("memoryMandatePattern invalid regex → memoryMandateProblems only (the base gate stays healthy)", () => {
    const { resolved } = resolveOptions({ gates: { memoryMandatePattern: "(" } })
    expect(
      resolved.gates.memoryMandateProblems.some((p) =>
        p.startsWith("gates.memoryMandatePattern must be a valid regex source"),
      ),
    ).toBeTrue()
    expect(resolved.gates.problems).toEqual([]) // separate sub-guard pool
    expect(resolved.gates.memoryMandatePattern).toBe(DEFAULTS.gates.memoryMandatePattern)
  })

  test("stitch knobs: stitchMinPrompt must be a positive integer; stitchPromptTools must be a string[]", () => {
    const a = resolveOptions({ structure: { stitchMinPrompt: 0 } })
    expect(
      a.resolved.structure.stitchProblems.some((p) =>
        p.startsWith("structure.stitchMinPrompt must be a positive integer"),
      ),
    ).toBeTrue()
    expect(a.resolved.structure.stitchMinPrompt).toBe(120)
    expect(a.resolved.structure.problems).toEqual([]) // fresh-dispatch structure guard unaffected
    const b = resolveOptions({ structure: { stitchPromptTools: [42] } })
    expect(
      b.resolved.structure.stitchProblems.some((p) =>
        p.startsWith("structure.stitchPromptTools must be an array of non-empty strings"),
      ),
    ).toBeTrue()
  })

  test("paths: non-empty strings; invalid → paths.problems + default fallback; unknown keys warn+ignore", () => {
    const a = resolveOptions({ paths: { memoryTree: "" } })
    expect(
      a.resolved.paths.problems.some((p) => p.startsWith("paths.memoryTree must be a non-empty string")),
    ).toBeTrue()
    expect(a.resolved.paths.memoryTree).toBe(DEFAULTS.paths.memoryTree)
    const b = resolveOptions({ structure: { blockz: 1 }, paths: { treez: 1 } })
    expect(b.problems).toContain(`unknown option key "structure.blockz" ignored (warning)`)
    expect(b.problems).toContain(`unknown option key "paths.treez" ignored (warning)`)
    expect(b.resolved.structure.problems).toEqual([])
    expect(b.resolved.paths.problems).toEqual([])
  })

  test("empty profiles are valid and inert (no problems); empty readTargets is valid + warned", () => {
    const a = resolveOptions({ structure: { subagentProfile: [], stitchProfile: [] } })
    expect(a.problems).toEqual([])
    expect(a.resolved.structure.problems).toEqual([])
    const b = resolveOptions({ gates: { readTargets: [] } })
    expect(b.problems).toContain("gates.readTargets is empty — the read prerequisite is inert (warning)")
    expect(b.resolved.gates.problems).toEqual([]) // warning does NOT break the guard
  })

  test("resolved config is deep-frozen including the new groups", () => {
    const { resolved } = resolveOptions({})
    expect(Object.isFrozen(resolved.structure)).toBeTrue()
    expect(Object.isFrozen(resolved.paths)).toBeTrue()
    expect(Object.isFrozen(resolved.gates.readTargets)).toBeTrue()
    expect(Object.isFrozen(resolved.structure.blocks)).toBeTrue()
  })

  test("non-object raw → structure/paths/memory-mandate guards also fail closed", () => {
    const { resolved } = resolveOptions("probe-not-an-object")
    expect(resolved.gates.memoryMandateProblems.length).toBeGreaterThan(0)
    expect(resolved.structure.problems.length).toBeGreaterThan(0)
    expect(resolved.structure.stitchProblems.length).toBeGreaterThan(0)
    expect(resolved.paths.problems.length).toBeGreaterThan(0)
  })
})

describe("config Phase 2 — per-option override behavior", () => {
  test("custom non-Latin blocks drive the structure gate: a RU structured brief passes end-to-end", async () => {
    await setupWith({ structure: { blocks: RU_BLOCKS } }) // swap the WHOLE block set
    const sid = "sess-p2-ruswap"
    complyAll(sid)
    const m = await freshDispatch(sid, "backend-architect", RU_BRIEF)
    expect(m).toBeNull() // structure + memory mandate + breaker all pass on the RU brief
  })

  test("RU swap: a RU brief missing the «Формат вывода» block denies naming the Cyrillic block", async () => {
    await setupWith({ structure: { blocks: RU_BLOCKS } })
    const sid = "sess-p2-ruswap-miss"
    complyAll(sid)
    const m = await freshDispatch(sid, "backend-architect", RU_BRIEF_NO_OUTPUT)
    expect(m).not.toBeNull()
    expect(m!).toContain("prompt-structure check")
    expect(m!).toContain("Формат вывода") // block NAME from the custom vocabulary
    expect(m!).not.toContain("Output format") // default name gone with the swapped set
  })

  test("empty subagentProfile [] → fresh dispatches un-checked (later checks still run)", async () => {
    await setupWith({ structure: { subagentProfile: [] } })
    const sid = "sess-p2-noprofile"
    complyAll(sid)
    // a structure-less prompt passes the (inert) structure check…
    const mandateOnly = "Please read ~/.config/opencode/MEMORY.md and memory/topics/* first."
    expect(await freshDispatch(sid, "code-reviewer", mandateOnly)).toBeNull()
    // …but the memory-mandate check still applies to the next fresh dispatch
    const m2 = await freshDispatch(sid, "code-reviewer", "Just do the thing.")
    expect(m2).not.toBeNull()
    expect(m2!).toContain("does not mandate reading global memory")
  })

  test("gates.readTargets override: custom suffixes record gate reads; the default MEMORY.md no longer satisfies", async () => {
    await setupWith({
      gates: {
        readTargets: [
          { key: "memory", suffix: ".config/acme/MEMORY.md" },
          { key: "team", suffix: ".config/acme/team.md" },
        ],
      },
    })
    const sid = "sess-p2-readtargets"
    // zero-state: the deny names the CUSTOM suffix, not the default one
    const m0 = await denyMsg({ tool: "shell", sessionID: sid, input: {} })
    expect(m0).not.toBeNull()
    expect(m0!).toContain("read of ~/.config/acme/MEMORY.md")
    expect(m0!).not.toContain(".config/opencode/MEMORY.md")
    // the DEFAULT read does NOT satisfy the custom target
    loadRead(sid, `${HOME}/.config/opencode/MEMORY.md`)
    for (const s of ["brainstorming", "grilling", "build-with-exa", "context7-mcp"]) loadSkill(sid, s)
    const m1 = await denyMsg({ tool: "shell", sessionID: sid, input: {} })
    expect(m1).not.toBeNull()
    expect(m1!).toContain("read of ~/.config/acme/MEMORY.md")
    // the custom read does — recorded via the ~ form (both forms must keep working)
    loadRead(sid, "~/.config/acme/MEMORY.md")
    expect(await denyMsg({ tool: "shell", sessionID: sid, input: {} })).toBeNull()
    // dispatch preflight demands the non-memory custom target; reading it unlocks
    for (const s of ["subagent-driven-development", "dispatching-parallel-agents", "prompt-engineering-patterns"]) loadSkill(sid, s)
    const m2 = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m2).not.toBeNull()
    expect(m2!).toContain("read of ~/.config/acme/team.md")
    loadRead(sid, `${HOME}/.config/acme/team.md`)
    expect(await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)).toBeNull()
  })

  test("gates.readTargets [] → the read prerequisite is inert (skills alone satisfy the base gate)", async () => {
    await setupWith({ gates: { readTargets: [] } })
    const sid = "sess-p2-noreads"
    for (const s of ["brainstorming", "grilling", "build-with-exa", "context7-mcp"]) loadSkill(sid, s)
    expect(await denyMsg({ tool: "shell", sessionID: sid, input: {} })).toBeNull() // no read demanded
  })

  test("gates.mcpRequirements [] → the MCP→skill gate is inert (valid per the §C empty-list ruling)", async () => {
    await setupWith({ gates: { mcpRequirements: [] } })
    const sid = "sess-p2-nomcp"
    complyAll(sid) // base-complete session (default tables gone: adb_mcp_* is ungated anyway)
    expect(await denyMsg({ tool: "adb_mcp_tap", sessionID: sid, input: {} })).toBeNull()
    expect(await denyMsg({ tool: "context7_query_docs", sessionID: sid, input: {} })).toBeNull()
  })

  test("gates.mcpRequirements override: custom prefix → custom skill (deny/allow pair); default prefixes gone", async () => {
    await setupWith({ gates: { mcpRequirements: [{ prefix: "acme_", skill: "acme-skill" }] } })
    const sid = "sess-p2-mcp"
    // the custom prefix extends the gated set: zero-state → BASE gate deny
    const m0 = await denyMsg({ tool: "acme_drive", sessionID: sid, input: {} })
    expect(m0).not.toBeNull()
    expect(m0!).toContain('skill "brainstorming"')
    // the default prefixes left the table: adb_mcp_* is ungated now
    expect(await denyMsg({ tool: "adb_mcp_tap", sessionID: `${sid}-adb`, input: {} })).toBeNull()
    // base-complete session → the MCP-specific deny names the CUSTOM skill (generic hint)
    complyAll(sid)
    const m1 = await denyMsg({ tool: "acme_drive", sessionID: sid, input: {} })
    expect(m1).not.toBeNull()
    expect(m1!).toContain('MCP tool "acme_drive"')
    expect(m1!).toContain('with id "acme-skill"')
    expect(m1!).toContain("load it before driving this server") // unknown skill → generic hint
    // loading the custom skill unlocks the server
    loadSkill(sid, "acme-skill")
    expect(await denyMsg({ tool: "acme_drive", sessionID: sid, input: {} })).toBeNull()
  })

  test("gates.memoryMandatePattern override: an ASCII-only pattern no longer accepts the RU-only mandate", async () => {
    await setupWith({ gates: { memoryMandatePattern: "(MEMORY\\.md|memory/(topics|projects)|global memory)" } })
    const sid1 = "sess-p2-mandate-ascii"
    complyAll(sid1)
    expect(await freshDispatch(sid1, "code-reviewer", GOOD_PROMPT)).toBeNull() // MEMORY.md mandate passes
    const sid2 = "sess-p2-mandate-ru"
    complyAll(sid2)
    const m = await freshDispatch(sid2, "code-reviewer", RU_MANDATE_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("does not mandate reading global memory") // RU-only mandate now denies
  })

  test("structure.stitchPromptTools: [] disables the stitch surface; a custom name re-aims it", async () => {
    await setupWith({ structure: { stitchPromptTools: [] } })
    const mOff = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: "sess-p2-stitch-off",
      input: { prompt: BAD_STITCH_PROMPT },
    })
    expect(mOff).toBeNull() // surface disabled
    await setupWith({ structure: { stitchPromptTools: ["mcp_paint"] } })
    const mAim = await denyMsg({
      tool: "mcp_paint",
      sessionID: "sess-p2-stitch-aim",
      input: { prompt: BAD_STITCH_PROMPT },
    })
    expect(mAim).not.toBeNull()
    expect(mAim!).toContain('MCP tool "mcp_paint"')
  })

  test("structure.stitchMinPrompt: a small floor checks short prompts; a huge floor disables the surface", async () => {
    await setupWith({ structure: { stitchMinPrompt: 5 } })
    const mShort = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: "sess-p2-floor5",
      input: { prompt: "short" },
    })
    expect(mShort).not.toBeNull()
    expect(mShort!).toContain("prompt-structure check")
    const mTiny = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: "sess-p2-floor5-tiny",
      input: { prompt: "hi" },
    })
    expect(mTiny).toBeNull() // below the floor → never checked
    await setupWith({ structure: { stitchMinPrompt: 100000 } })
    const mHuge = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: "sess-p2-floorhuge",
      input: { prompt: BAD_STITCH_PROMPT },
    })
    expect(mHuge).toBeNull() // surface effectively off
  })

  test("paths override re-aims the memory-overwrite guard (hermetic: _testStat stub decides existence)", async () => {
    const ACME_INDEX = "/tmp/opencode/mandator-ext6/flex-design/acme/MEMORY.md"
    const ACME_TREE = "/tmp/opencode/mandator-ext6/flex-design/acme/memory"
    const ACME_FILE = `${ACME_TREE}/topics/x.md`
    const defaultStat = _testStat.fn
    _testStat.fn = () => true // everything "exists"; only classification may deny
    try {
      await setupWith({ paths: { memoryIndex: ACME_INDEX, memoryTree: ACME_TREE } })
      const sid = "sess-p2-paths"
      complyAll(sid) // write is gated: pass the skill/memory gate to reach the overwrite guard
      // a write under the CUSTOM tree is guarded…
      const mAcme = await denyMsg({ tool: "write", sessionID: sid, input: { path: ACME_FILE } })
      expect(mAcme).not.toBeNull()
      expect(mAcme!).toContain("whole-file write over an EXISTING global memory file")
      // …and a write to the REAL home tree is no longer classified as memory (passes)
      const mReal = await denyMsg({
        tool: "write",
        sessionID: sid,
        input: { path: "~/.config/opencode/MEMORY.md" },
      })
      expect(mReal).toBeNull()
    } finally {
      _testStat.fn = defaultStat
    }
  })

  test("unknown keys inside the newly wired groups warn+ignore; defaults keep enforcing", async () => {
    await setupWith({ structure: { blockz: 1 }, paths: { treez: 1 } })
    const sid = "sess-p2-unknownkeys"
    complyAll(sid)
    expect(await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)).toBeNull() // enforcement intact
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys[1]!.text).toContain(`unknown option key "structure.blockz" ignored (warning)`)
    expect(sys[1]!.text).toContain(`unknown option key "paths.treez" ignored (warning)`)
  })
})

describe("config Phase 2 — invalid options fail closed per guard (CONFIG-ERROR denies)", () => {
  test("structure.blocks invalid regex → fresh dispatch + stitch deny with CONFIG-ERROR; zero-state keeps the normal gate deny (precedence)", async () => {
    await setupWith({ structure: { blocks: { ...RU_BLOCKS, role: { name: "Role", pattern: "((" } } } })
    // compliance-teaching denies keep precedence: a zero-state dispatch still gets the GATE deny
    const mGate = await denyMsg({
      tool: "subagent",
      sessionID: "sess-p2-badblocks0",
      input: { agent: "code-reviewer", background: true, prompt: GOOD_PROMPT },
    })
    expect(mGate).not.toBeNull()
    expect(mGate!).not.toContain("config-error")
    expect(mGate!).toContain('skill "brainstorming"')
    // a compliant session's fresh dispatch hits the structure CONFIG-ERROR at its position
    const sid = "sess-p2-badblocks"
    complyAll(sid)
    const m = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("structure.blocks.role.pattern")
    // the stitch surface (a different sub-guard trigger, same broken pool) denies too
    const mStitch = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: `${sid}-stitch`,
      input: { prompt: BAD_STITCH_PROMPT },
    })
    expect(mStitch).not.toBeNull()
    expect(mStitch!).toContain("[config-error]")
    expect(mStitch!).toContain("structure.blocks.role.pattern")
  })

  test("structure.subagentProfile referencing an unknown block → fresh dispatch CONFIG-ERROR names the path", async () => {
    await setupWith({ structure: { subagentProfile: ["role", "tasks"] } })
    const sid = "sess-p2-badprofile"
    complyAll(sid)
    const m = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("structure.subagentProfile")
    expect(m!).toContain('unknown block key "tasks"')
  })

  test("gates.readTargets broken → gated calls deny with CONFIG-ERROR naming the path", async () => {
    await setupWith({ gates: { readTargets: "MEMORY.md" } })
    const m = await denyMsg({ tool: "shell", sessionID: "sess-p2-badtargets", input: {} })
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("gates.readTargets")
    expect(m!).toContain(`got "MEMORY.md"`)
  })

  test("gates.mcpRequirements broken → gated calls deny with CONFIG-ERROR naming the path", async () => {
    await setupWith({ gates: { mcpRequirements: [{ prefix: "acme_" }] } }) // missing skill field
    const sid = "sess-p2-badmcp"
    complyAll(sid) // even a base-complete session cannot pass: prerequisites are unreadable
    const m = await denyMsg({ tool: "shell", sessionID: sid, input: {} })
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("gates.mcpRequirements")
  })

  test("gates.memoryMandatePattern broken regex → fresh dispatch CONFIG-ERROR at the mandate position only", async () => {
    await setupWith({ gates: { memoryMandatePattern: "(" } })
    // the base gate is a different guard: a zero-state shell call gets the NORMAL gate deny
    const mGate = await denyMsg({ tool: "shell", sessionID: "sess-p2-badmandate0", input: {} })
    expect(mGate).not.toBeNull()
    expect(mGate!).not.toContain("config-error")
    expect(mGate!).toContain('skill "brainstorming"')
    // a compliant shell call passes — the gate is healthy
    const sid = "sess-p2-badmandate"
    complyAll(sid)
    expect(await denyMsg({ tool: "shell", sessionID: sid, input: {} })).toBeNull()
    // a compliant dispatch with a malformed brief gets the STRUCTURE deny first (precedence)
    const mStruct = await freshDispatch(sid, "code-reviewer", "no structure here at all")
    expect(mStruct).not.toBeNull()
    expect(mStruct!).toContain("prompt-structure check")
    expect(mStruct!).not.toContain("config-error")
    // a well-structured brief reaches the broken mandate check → CONFIG-ERROR
    const m = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain("gates.memoryMandatePattern")
  })

  test("stitch knobs broken → the stitch call CONFIG-ERRORs; fresh dispatches are unaffected", async () => {
    await setupWith({ structure: { stitchMinPrompt: 0 } })
    const mStitch = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: "sess-p2-badfloor",
      input: { prompt: BAD_STITCH_PROMPT },
    })
    expect(mStitch).not.toBeNull()
    expect(mStitch!).toContain("[config-error]")
    expect(mStitch!).toContain("structure.stitchMinPrompt")
    // fresh dispatches: a different sub-guard — normal flow with a compliant session
    const sid = "sess-p2-badfloor-fresh"
    complyAll(sid)
    expect(await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)).toBeNull()
  })

  test("structure group not a plain object → structure guard fails closed (fresh + stitch)", async () => {
    await setupWith({ structure: 42 })
    const sid = "sess-p2-badgroup"
    complyAll(sid)
    const m = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("[config-error]")
    expect(m!).toContain(`options group "structure" must be a plain object`)
    const mStitch = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: `${sid}-stitch`,
      input: { prompt: BAD_STITCH_PROMPT },
    })
    expect(mStitch).not.toBeNull()
    expect(mStitch!).toContain("[config-error]")
  })

  test("paths broken → writes covered by the DEFAULT memory topology CONFIG-ERROR; other writes pass", async () => {
    const defaultStat = _testStat.fn
    _testStat.fn = () => true
    try {
      await setupWith({ paths: { memoryTree: "" } })
      const sid = "sess-p2-badpaths"
      complyAll(sid) // pass the gate to reach the write guard
      // default-covered write → CONFIG-ERROR naming the broken path (broken-group scoping)
      const mCovered = await denyMsg({
        tool: "write",
        sessionID: sid,
        input: { path: "~/.config/opencode/MEMORY.md" },
      })
      expect(mCovered).not.toBeNull()
      expect(mCovered!).toContain("[config-error]")
      expect(mCovered!).toContain("paths.memoryTree")
      // a write the default config would never have inspected passes
      const mOutside = await denyMsg({
        tool: "write",
        sessionID: sid,
        input: { path: "/tmp/opencode/mandator-ext6/flex-design/unrelated.txt" },
      })
      expect(mOutside).toBeNull()
    } finally {
      _testStat.fn = defaultStat
    }
  })
})

// ============================================================================
// Flexibility Phase 3 — the presentation groups (+15; 36 total):
// messages.complianceWarning / generalBan / backgroundBan / agentMissing /
// gateMissing / structureFail / memoryMandateFail / memoryOverwriteFail /
// identicalLoopFail / chainCapFail / mcpSkillFail / mcpSkillHints /
// descriptionHint + primer.mode / primer.text.
//
// PRESENTATION failure semantics (design §C(c), the other half of the hybrid):
// an invalid presentation entry (wrong type, empty string, unknown {var},
// invalid primer mode, missing primer.text) falls back to the BUILT-IN DEFAULT
// and records a problem — wording problems must never brick enforcement. The
// per-template {var} sets map 1:1 to what the deny builders interpolate today;
// unknown {var} in a configured template is caught at resolve time.
//
// FIXED trailer rule (owner ruling 4 / design §E-8): the identical-loop deny
// stays trailer-less REGARDLESS of configuration — the no-trailer rule is
// enforced in code, never by template content.
//
// Primer modes (owner ruling 5, as amended by the phase-3 brief):
//   "default" → DEFAULTS.primer.text verbatim (primer.text ignored)
//   "replace" → primer.text verbatim (DEFAULTS ignored; the effective default
//               mode, so a bare primer.text override works standalone)
//   "append"  → DEFAULTS.primer.text + "\n\n" + primer.text
//   invalid mode or missing/invalid text in replace/append ⇒ default primer +
//   problem. No-options resolution stays byte-identical (mode "replace" +
//   DEFAULTS.primer.text verbatim).
// ============================================================================

describe("config Phase 3 — resolveOptions: messages/primer resolution semantics", () => {
  test("no raw → messages/primer resolve to pure DEFAULTS values, zero problems", () => {
    const { resolved, problems } = resolveOptions(undefined)
    expect(problems).toEqual([])
    expect(resolved.messages.complianceWarning).toBe(DEFAULTS.messages.complianceWarning)
    expect(resolved.messages.generalBan).toBe(DEFAULTS.messages.generalBan)
    expect(resolved.messages.backgroundBan).toBe(DEFAULTS.messages.backgroundBan)
    expect(resolved.messages.agentMissing).toBe(DEFAULTS.messages.agentMissing)
    expect(resolved.messages.gateMissing).toBe(DEFAULTS.messages.gateMissing)
    expect(resolved.messages.structureFail).toBe(DEFAULTS.messages.structureFail)
    expect(resolved.messages.memoryMandateFail).toBe(DEFAULTS.messages.memoryMandateFail)
    expect(resolved.messages.memoryOverwriteFail).toBe(DEFAULTS.messages.memoryOverwriteFail)
    expect(resolved.messages.identicalLoopFail).toBe(DEFAULTS.messages.identicalLoopFail)
    expect(resolved.messages.chainCapFail).toBe(DEFAULTS.messages.chainCapFail)
    expect(resolved.messages.mcpSkillFail).toBe(DEFAULTS.messages.mcpSkillFail)
    expect(resolved.messages.mcpSkillHints).toEqual(DEFAULTS.messages.mcpSkillHints)
    expect(resolved.messages.descriptionHint).toBe(DEFAULTS.messages.descriptionHint)
    expect(resolved.messages.problems).toEqual([])
    expect(resolved.primer.text).toBe(DEFAULTS.primer.text) // byte-identical injected text
    expect(resolved.primer.problems).toEqual([])
  })

  test("configured templates with exactly their known vars resolve verbatim", () => {
    const { resolved, problems } = resolveOptions({
      messages: {
        generalBan: 'NO "{agent}" HERE.',
        gateMissing: "NEEDED: {missing}.",
        structureFail: "BAD {target}: missing {missing}, use {blocks}.",
        identicalLoopFail: "LOOP x{n}.",
        chainCapFail: "CHAIN {n}/{cap}.",
        mcpSkillFail: 'MCP "{tool}" → "{skill}" ({hint}).',
      },
    })
    expect(problems).toEqual([])
    expect(resolved.messages.generalBan).toBe('NO "{agent}" HERE.')
    expect(resolved.messages.gateMissing).toBe("NEEDED: {missing}.")
    expect(resolved.messages.structureFail).toBe("BAD {target}: missing {missing}, use {blocks}.")
    expect(resolved.messages.identicalLoopFail).toBe("LOOP x{n}.")
    expect(resolved.messages.chainCapFail).toBe("CHAIN {n}/{cap}.")
    expect(resolved.messages.mcpSkillFail).toBe('MCP "{tool}" → "{skill}" ({hint}).')
    expect(resolved.messages.problems).toEqual([])
  })

  test("unknown {var} in a configured template → fallback to the default template + problem naming the path", () => {
    const { resolved, problems } = resolveOptions({ messages: { gateMissing: "NEEDED: {missing} plus {tool}." } })
    expect(
      resolved.messages.problems.some(
        (p) => p.includes("messages.gateMissing") && p.includes("{tool}") && p.includes("falling back"),
      ),
    ).toBeTrue()
    expect(resolved.messages.gateMissing).toBe(DEFAULTS.messages.gateMissing) // presentation fallback
    expect(problems.some((p) => p.includes("messages.gateMissing"))).toBeTrue() // surfaced too
  })

  test("unknown {var} in a zero-var template (complianceWarning) → fallback + problem (known: none)", () => {
    const { resolved } = resolveOptions({ messages: { complianceWarning: " AUDIT: {n} violations." } })
    expect(
      resolved.messages.problems.some(
        (p) => p.includes("messages.complianceWarning") && p.includes("{n}") && p.includes("(known: none)"),
      ),
    ).toBeTrue()
    expect(resolved.messages.complianceWarning).toBe(DEFAULTS.messages.complianceWarning)
  })

  test("non-string or empty message values → fallback + problem", () => {
    const a = resolveOptions({ messages: { generalBan: 42 } })
    expect(
      a.resolved.messages.problems.some((p) => p.startsWith("messages.generalBan must be a non-empty string")),
    ).toBeTrue()
    expect(a.resolved.messages.generalBan).toBe(DEFAULTS.messages.generalBan)
    const b = resolveOptions({ messages: { backgroundBan: "" } })
    expect(
      b.resolved.messages.problems.some((p) => p.startsWith("messages.backgroundBan must be a non-empty string")),
    ).toBeTrue()
    expect(b.resolved.messages.backgroundBan).toBe(DEFAULTS.messages.backgroundBan)
    // enforcement is untouched either way (presentation domain)
    expect(a.resolved.dispatch.problems).toEqual([])
    expect(b.resolved.dispatch.problems).toEqual([])
  })

  test("unknown keys inside messages/primer warn+ignore; valid keys resolve", () => {
    const { resolved, problems } = resolveOptions({
      messages: { gateMissing: "NEEDED: {missing}.", hintz: 1 },
      primer: { mode: "default", textz: 1 },
    })
    expect(problems).toContain(`unknown option key "messages.hintz" ignored (warning)`)
    expect(problems).toContain(`unknown option key "primer.textz" ignored (warning)`)
    expect(resolved.messages.gateMissing).toBe("NEEDED: {missing}.")
    expect(resolved.messages.problems).toEqual([])
    expect(resolved.primer.problems).toEqual([])
  })

  test("messages group not a plain object → warn + ignore entirely (presentation: never breaks enforcement)", () => {
    const { resolved, problems } = resolveOptions({ messages: 42 })
    expect(problems.some((p) => p.includes(`options group "messages" must be a plain object`))).toBeTrue()
    expect(resolved.messages.generalBan).toBe(DEFAULTS.messages.generalBan)
    expect(resolved.messages.problems).toEqual([])
    expect(resolved.dispatch.problems).toEqual([]) // enforcement unaffected
  })

  test("mcpSkillHints: custom record resolves (any skill keys); invalid shape → fallback + problem", () => {
    const a = resolveOptions({ messages: { mcpSkillHints: { "acme-skill": "drive it gently", "adb-mcp": "tree first" } } })
    expect(a.resolved.messages.mcpSkillHints).toEqual({ "acme-skill": "drive it gently", "adb-mcp": "tree first" })
    expect(a.resolved.messages.problems).toEqual([])
    const b = resolveOptions({ messages: { mcpSkillHints: { "adb-mcp": 42 } } })
    expect(
      b.resolved.messages.problems.some((p) => p.startsWith("messages.mcpSkillHints must be a plain object record")),
    ).toBeTrue()
    expect(b.resolved.messages.mcpSkillHints).toEqual(DEFAULTS.messages.mcpSkillHints)
  })

  test("primer.mode 'default' → DEFAULTS.primer.text verbatim (configured primer.text ignored)", () => {
    const { resolved, problems } = resolveOptions({ primer: { mode: "default", text: "CUSTOM RULES" } })
    expect(problems).toEqual([])
    expect(resolved.primer.text).toBe(DEFAULTS.primer.text)
  })

  test("primer.mode 'replace'/'append' apply text; a bare primer.text override works (effective default mode 'replace')", () => {
    const a = resolveOptions({ primer: { mode: "replace", text: "MY RULES" } })
    expect(a.problems).toEqual([])
    expect(a.resolved.primer.text).toBe("MY RULES")
    const b = resolveOptions({ primer: { mode: "append", text: "ADDENDUM" } })
    expect(b.problems).toEqual([])
    expect(b.resolved.primer.text).toBe(DEFAULTS.primer.text + "\n\nADDENDUM")
    const c = resolveOptions({ primer: { text: "TEXT ONLY" } }) // no mode → effective default "replace"
    expect(c.problems).toEqual([])
    expect(c.resolved.primer.text).toBe("TEXT ONLY")
  })

  test("primer.mode invalid → fallback to the default primer + problem naming primer.mode", () => {
    const { resolved, problems } = resolveOptions({ primer: { mode: "prepend" } })
    expect(
      problems.some((p) => p.includes("primer.mode") && p.includes(`"prepend"`) && p.includes("falling back")),
    ).toBeTrue()
    expect(resolved.primer.text).toBe(DEFAULTS.primer.text)
    expect(resolved.primer.problems.length).toBeGreaterThan(0)
  })

  test("primer.mode replace/append with missing or invalid text → fallback + problem", () => {
    const a = resolveOptions({ primer: { mode: "replace" } }) // text missing
    expect(
      a.resolved.primer.problems.some((p) => p.includes("primer.text") && p.includes(`"replace"`) && p.includes("falling back")),
    ).toBeTrue()
    expect(a.resolved.primer.text).toBe(DEFAULTS.primer.text)
    const b = resolveOptions({ primer: { mode: "append", text: 42 } })
    expect(
      b.resolved.primer.problems.some((p) => p.includes("primer.text must be a non-empty string")),
    ).toBeTrue()
    expect(b.resolved.primer.text).toBe(DEFAULTS.primer.text)
    const c = resolveOptions({ primer: { mode: "append", text: "" } }) // empty string is not a text
    expect(c.resolved.primer.problems.length).toBeGreaterThan(0)
    expect(c.resolved.primer.text).toBe(DEFAULTS.primer.text)
  })

  test("primer group not a plain object → warn + ignore entirely", () => {
    const { resolved, problems } = resolveOptions({ primer: "nope" })
    expect(problems.some((p) => p.includes(`options group "primer" must be a plain object`))).toBeTrue()
    expect(resolved.primer.text).toBe(DEFAULTS.primer.text)
    expect(resolved.primer.problems).toEqual([])
  })

  test("resolved config is deep-frozen including messages/primer", () => {
    const { resolved } = resolveOptions({})
    expect(Object.isFrozen(resolved.messages)).toBeTrue()
    expect(Object.isFrozen(resolved.messages.mcpSkillHints)).toBeTrue()
    expect(Object.isFrozen(resolved.primer)).toBeTrue()
    expect(() => {
      ;(resolved.messages as { generalBan: string }).generalBan = "mutated"
    }).toThrow()
  })

  test("non-object raw → presentation groups stay at DEFAULTS (warn class, NOT fail-closed)", () => {
    const { resolved, problems } = resolveOptions("probe-not-an-object")
    expect(problems.some((p) => p.includes("enforcement failing closed"))).toBeTrue()
    expect(resolved.messages.generalBan).toBe(DEFAULTS.messages.generalBan) // defaults, not broken
    expect(resolved.primer.text).toBe(DEFAULTS.primer.text)
    expect(resolved.messages.problems).toEqual([]) // presentation groups are not guards
    expect(resolved.primer.problems).toEqual([])
    expect(resolved.dispatch.problems.length).toBeGreaterThan(0) // enforcement DID fail closed
  })
})

describe("config Phase 3 — per-template deny rendering + primer modes (end-to-end)", () => {
  test("generalBan + complianceWarning overrides render exactly: filled template + configured trailer", async () => {
    await setupWith({
      messages: {
        generalBan: 'BANNED: "{agent}" is not allowed here.',
        complianceWarning: " TRAILER-MARKER-P3: audited.",
      },
    })
    const m = await denyMsg({ tool: "subagent", sessionID: "sess-p3-ban", input: { agent: "general", background: true } })
    expect(m).toBe('BANNED: "general" is not allowed here. TRAILER-MARKER-P3: audited.')
  })

  test("gateMissing override renders with the real missing list, fully substituted", async () => {
    await setupWith({ messages: { gateMissing: "NEEDED FIRST: {missing}. Go load them." } })
    const m = await denyMsg({ tool: "shell", sessionID: "sess-p3-gate", input: {} })
    expect(m).not.toBeNull()
    expect(m!).toContain("NEEDED FIRST: ")
    expect(m!).toContain('skill "brainstorming"')
    expect(m!).toContain("read of ~/.config/opencode/MEMORY.md")
    expect(m!).not.toContain("{missing}")
    expect(m!).not.toContain("Owner mandate") // default wording gone
  })

  test("structureFail override renders {target}/{missing}/{blocks}; the empty-prompt prefix stays hardcoded", async () => {
    await setupWith({ messages: { structureFail: "BAD BRIEF for {target}: missing {missing}. Use {blocks}." } })
    const sid = "sess-p3-struct"
    complyAll(sid)
    const m = await freshDispatch(sid, "code-reviewer", "Role: tester. Task: test things thoroughly.")
    expect(m).not.toBeNull()
    expect(m!).toContain("BAD BRIEF for subagent dispatch: missing Context; Constraints; Output format.")
    expect(m!).toContain("Use Role / Task / Context / Constraints / Output format.")
    expect(m!).not.toContain("{target}")
    // the empty-prompt prefix is a code rule, not part of the template
    const sidEmpty = "sess-p3-struct-empty"
    complyAll(sidEmpty) // pass the gate so the structure check is reached
    const mEmpty = await freshDispatch(sidEmpty, "code-reviewer", "")
    expect(mEmpty).not.toBeNull()
    expect(mEmpty!.startsWith("The dispatch prompt is missing or empty. BAD BRIEF for subagent dispatch:")).toBeTrue()
  })

  test("TRAILER RULE: the identical-loop deny stays trailer-less regardless of configuration (exact equality)", async () => {
    await setupWith({
      caps: { identicalMax: 2 },
      messages: {
        identicalLoopFail: "LOOP GUARD: identical dispatch sent {n} times. Stop.",
        complianceWarning: " TRAILER-MARKER-P3: audited.",
      },
    })
    const sid = "sess-p3-trailer"
    complyAll(sid)
    expect(await freshDispatch(sid, "code-reviewer", GOOD_PROMPT)).toBeNull() // count 1 < 2
    const m = await freshDispatch(sid, "code-reviewer", GOOD_PROMPT) // count 2 → deny
    expect(m).toBe("LOOP GUARD: identical dispatch sent 2 times. Stop.") // NO trailer, exactly
    expect(m).not.toContain("TRAILER-MARKER-P3")
  })

  test("chainCapFail override renders with the configured trailer (contrast to the identical-loop rule)", async () => {
    await setupWith({
      caps: { chainMax: 1 },
      messages: { chainCapFail: "CHAIN: {n} of cap {cap}. Stop.", complianceWarning: " TRAILER-MARKER-P3." },
    })
    const sid = "sess-p3-chain"
    complyAll(sid)
    expect(await continuation(sid, "step 1", "ses_child_p3chain")).toBeNull() // 1 > 1 false
    const m = await continuation(sid, "step 2", "ses_child_p3chain")
    expect(m).toBe("CHAIN: 2 of cap 1. Stop. TRAILER-MARKER-P3.") // template + configured trailer
  })

  test("mcpSkillFail + mcpSkillHints overrides render together; unknown skill keeps the generic hint", async () => {
    await setupWith({
      messages: {
        mcpSkillFail: 'SERVER GATE: "{tool}" needs "{skill}" ({hint}).',
        mcpSkillHints: { "adb-mcp": "open the accessibility tree first" },
      },
    })
    const sid = "sess-p3-mcp"
    complyAll(sid)
    const m = await denyMsg({ tool: "adb_mcp_tap", sessionID: sid, input: {} })
    expect(m).toBe(
      'SERVER GATE: "adb_mcp_tap" needs "adb-mcp" (open the accessibility tree first).' +
        DEFAULTS.messages.complianceWarning,
    )
    // a skill with no configured hint keeps the hardcoded generic hint
    await setupWith({
      messages: {
        mcpSkillFail: 'SERVER GATE: "{tool}" needs "{skill}" ({hint}).',
        mcpSkillHints: { "acme-skill": "unrelated" },
      },
    })
    const sidGeneric = "sess-p3-mcp-generic"
    complyAll(sidGeneric) // base-complete so the MCP-specific deny is reached
    const m2 = await denyMsg({ tool: "adb_mcp_tap", sessionID: sidGeneric, input: {} })
    expect(m2).toBe(
      'SERVER GATE: "adb_mcp_tap" needs "adb-mcp" (load it before driving this server).' +
        DEFAULTS.messages.complianceWarning,
    )
  })

  test("backgroundBan + agentMissing overrides render on their own deny sites", async () => {
    await setupWith({
      messages: {
        backgroundBan: "FOREGROUND DENIED. Use background:true.",
        agentMissing: "NO AGENT GIVEN. Pick one.",
      },
    })
    const mBg = await denyMsg({
      tool: "subagent",
      sessionID: "sess-p3-bgb",
      input: { agent: "code-reviewer", background: false },
    })
    expect(mBg).toBe("FOREGROUND DENIED. Use background:true." + DEFAULTS.messages.complianceWarning)
    const mAgent = await denyMsg({
      tool: "subagent",
      sessionID: "sess-p3-agent",
      input: { background: true, prompt: GOOD_PROMPT },
    })
    expect(mAgent).toBe("NO AGENT GIVEN. Pick one." + DEFAULTS.messages.complianceWarning)
  })

  test("memoryMandateFail override renders on a structured brief without the mandate", async () => {
    await setupWith({ messages: { memoryMandateFail: "NO MEMORY MANDATE. Add it." } })
    const sid = "sess-p3-mandate"
    complyAll(sid)
    const m = await freshDispatch(sid, "code-reviewer", "Role: tester. Task: test. Context: c. Constraints: none. Output format: report.")
    expect(m).toBe("NO MEMORY MANDATE. Add it." + DEFAULTS.messages.complianceWarning)
  })

  test("memoryOverwriteFail override renders on a guarded write (hermetic via _testStat)", async () => {
    const defaultStat = _testStat.fn
    _testStat.fn = () => true
    try {
      await setupWith({ messages: { memoryOverwriteFail: "MEMORY IS APPEND-ONLY." } })
      const sid = "sess-p3-overwrite"
      complyAll(sid)
      const m = await denyMsg({ tool: "write", sessionID: sid, input: { path: "~/.config/opencode/MEMORY.md" } })
      expect(m).toBe("MEMORY IS APPEND-ONLY." + DEFAULTS.messages.complianceWarning)
    } finally {
      _testStat.fn = defaultStat
    }
  })

  test("descriptionHint override replaces the tool-description hint", async () => {
    await setupWith({ messages: { descriptionHint: "\n\nSHORT POLICY HINT." } })
    expect(transformed!.subagent.description).toBe("ORIG" + "\n\nSHORT POLICY HINT.")
    await setupWith({}) // defaults → the default hint again
    expect(transformed!.subagent.description).toBe("ORIG" + DEFAULTS.messages.descriptionHint)
  })

  test("configured template with an unknown {var} falls back at runtime: deny renders the DEFAULT template + problem recorded", async () => {
    await setupWith({ messages: { gateMissing: "NEEDED: {missing} plus {tool}." } }) // {tool} unknown here
    const m = await denyMsg({ tool: "shell", sessionID: "sess-p3-fallback", input: {} })
    expect(m).not.toBeNull()
    expect(m!).toContain("Owner mandate: this action requires") // the DEFAULT template rendered
    expect(m!).not.toContain("NEEDED: {missing}")
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(2)
    expect(sys[1]!.text).toContain("messages.gateMissing")
    expect(sys[1]!.text).toContain("{tool}")
  })

  test("primer modes end-to-end: replace/append/text-only/byte-identical-default via session.context", async () => {
    await setupWith({ primer: { mode: "replace", text: "MY RULES ONLY." } })
    const sysReplace: any[] = []
    await hooks["session.context"]({ system: sysReplace, messages: [] })
    expect(sysReplace.length).toBe(1)
    expect(sysReplace[0]!.text).toBe("MY RULES ONLY.")

    await setupWith({ primer: { mode: "append", text: "ADDENDUM." } })
    const sysAppend: any[] = []
    await hooks["session.context"]({ system: sysAppend, messages: [] })
    expect(sysAppend.length).toBe(1)
    expect(sysAppend[0]!.text).toBe(DEFAULTS.primer.text + "\n\nADDENDUM.")

    await setupWith({ primer: { text: "TEXT ONLY OVERRIDE." } }) // effective default mode "replace"
    const sysTextOnly: any[] = []
    await hooks["session.context"]({ system: sysTextOnly, messages: [] })
    expect(sysTextOnly[0]!.text).toBe("TEXT ONLY OVERRIDE.")

    await setupWith({}) // defaults → byte-identical PRIMER, no problems part
    const sysDefault: any[] = []
    await hooks["session.context"]({ system: sysDefault, messages: [] })
    expect(sysDefault.length).toBe(1)
    expect(sysDefault[0]!.text).toBe(DEFAULTS.primer.text)
  })

  test("primer invalid mode end-to-end: default primer injected + problems part naming primer.mode", async () => {
    await setupWith({ primer: { mode: "prepend" } })
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(2)
    expect(sys[0]!.text).toBe(DEFAULTS.primer.text) // fallback primer
    expect(sys[1]!.text).toContain("dispatch-policy config problems:")
    expect(sys[1]!.text).toContain("primer.mode")
  })
})
