// tests/dispatch-policy.test.ts — bun test port of the wave3-a2 logic probe suite.
// Basis: tests/probe-original.ts (probe generations 26+24+24 checks; final ext-3 form).
// Probe semantics preserved 1:1: same events, same session IDs, same state-mutation
// order (bun runs tests in declaration order within a file). Structural changes only:
// bun:test harness instead of the linear check() script, and os.homedir() instead of
// the hardcoded "/home/whoami" (tilde-expansion parity with the plugin's own expansion).
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import plugin, { _djb2, _testStat } from "../src/dispatch-policy.ts"

const hooks: Record<string, (event: any) => any> = {}
let transformed: Record<string, { description: string }> | null = null

const ctx: any = {
  tool: {
    hook: async (name: string, cb: (e: any) => any) => {
      hooks[`tool.${name}`] = cb
    },
    transform: async (cb: (editor: any) => void) => {
      const tools: Record<string, { description: string }> = { subagent: { description: "ORIG" } }
      cb({ update: (id: string, fn: (t: any) => void) => { if (tools[id]) fn(tools[id]) } })
      transformed = tools
    },
  },
  session: { hook: async (name: string, cb: (e: any) => any) => { hooks[`session.${name}`] = cb } },
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
const S = "sess-ext3"

// ext 5 fixtures — briefs that satisfy the prompt-structure profiles. Since ext 6.1 a
// compliant fresh brief ALSO mandates reading global memory (the GOOD_PROMPT carries the
// owner's canonical sentence; without it the memory-mandate check would deny).
const GOOD_PROMPT =
  "Role: you are a senior Go engineer. Task: fix the race in the ingest loop. " +
  "Context: the worker pool drops events under load; repro in tests/race_test.go. " +
  "Constraints: no new dependencies; the public API must stay stable; all tests must pass. " +
  "Output format: root-cause summary, the diff, and test results. " +
  "Before starting, read ~/.config/opencode/MEMORY.md and memory/topics/workflow.md; list what you read in your report."
const GOOD_STITCH_PROMPT =
  "Task: generate a mobile analytics dashboard screen. Context: SaaS fitness app, dark-first " +
  "brand, existing sidebar navigation. Constraints: WCAG AA contrast, 8pt spacing grid, no " +
  "external images. Output format: one screen with KPI cards, a weekly chart, and a bottom tab bar."

beforeAll(async () => {
  await plugin.setup(ctx)
})

describe("dispatch-policy — port of the wave3-a2 probe suite (gate extensions 3-4)", () => {
  // --- Phase 0: hook registration ---
  test("execute.before registered", () => {
    expect(typeof hooks["tool.execute.before"]).toBe("function")
  })

  test("execute.after registered", () => {
    expect(typeof hooks["tool.execute.after"]).toBe("function")
  })

  test("session.context registered", () => {
    expect(typeof hooks["session.context"]).toBe("function")
  })

  // --- Zero state ---
  test("shell DENIED at zero; lists 3 skills + MEMORY.md; no orchestrator items", async () => {
    const msg = await denyMsg({ tool: "shell", sessionID: S, input: {} })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "brainstorming"')
    expect(msg!).toContain('skill "grilling"')
    expect(msg!).toContain('skill "build-with-exa"')
    expect(msg!).toContain("read of ~/.config/opencode/MEMORY.md")
    expect(msg!).not.toContain("subagent-driven-development")
    expect(msg!).not.toContain("prompt-engineering-patterns")
    expect(msg!).not.toContain("workflow.md")
    expect(msg!).toContain("COMPLIANCE WARNING") // ext 4: every deny carries the deterrent trailer
  })

  test("subagent DENIED at zero; lists base + orchestrator items", async () => {
    const msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "brainstorming"')
    expect(msg!).toContain('skill "subagent-driven-development"')
    expect(msg!).toContain('skill "dispatching-parallel-agents"')
    expect(msg!).toContain('skill "prompt-engineering-patterns"')
    expect(msg!).toContain("workflow.md")
    expect(msg!).toContain("workflow-git-pr.md")
  })

  // --- skills loaded, memory unread → deny lists ONLY the memory read ---
  test("3/3 skills but memory unread → deny lists exactly the MEMORY.md read", async () => {
    loadSkill(S, "brainstorming")
    loadSkill(S, "grilling")
    loadSkill(S, "build-with-exa")
    const msg = await denyMsg({ tool: "edit", sessionID: S, input: {} })
    expect(msg).not.toBeNull()
    expect(msg!).toContain("read of ~/.config/opencode/MEMORY.md")
    expect(msg!).not.toContain('skill "brainstorming"')
    expect(msg!).not.toContain("workflow")
  })

  // --- memory read via ~ form + a wrong file → still deny ---
  test("unrelated ~/ read + failed workflow read do not count", async () => {
    loadRead(S, "~/some/other/file.ts")
    loadRead(S, "~/.config/opencode/memory/topics/workflow.md", "error") // failed read never counts
    const msg = await denyMsg({ tool: "edit", sessionID: S, input: {} })
    expect(msg).not.toBeNull()
    expect(msg!).toContain("read of ~/.config/opencode/MEMORY.md")
  })

  // --- memory read, absolute path → base satisfied; non-dispatch gated tools PASS ---
  test("base-complete (skills + memory) lifts non-dispatch gates", async () => {
    loadRead(S, `${HOME}/.config/opencode/MEMORY.md`)
    let pass = true
    for (const ev of [
      { tool: "edit", input: {} },
      { tool: "write", input: {} },
      { tool: "shell", input: { command: "ls" } },
      { tool: "webfetch", input: {} },
      { tool: "websearch", input: {} },
      { tool: "execute", input: { code: "return 1" } },
      { tool: "exa_web_search_exa", input: {} },
    ]) {
      const m = await denyMsg({ ...ev, sessionID: S })
      if (m !== null) {
        pass = false
        console.log("   unexpected deny:", ev.tool, m.slice(0, 80))
      }
    }
    expect(pass).toBeTrue()
  })

  // --- subagent still DENIED at base-complete; lists ONLY orchestrator items ---
  test("subagent at base-complete → deny lists exactly 3 skills + 2 workflow reads", async () => {
    const msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "subagent-driven-development"')
    expect(msg!).toContain('skill "dispatching-parallel-agents"')
    expect(msg!).toContain('skill "prompt-engineering-patterns"')
    expect(msg!).toContain("read of ~/.config/opencode/memory/topics/workflow.md")
    expect(msg!).toContain("read of ~/.config/opencode/memory/topics/workflow-git-pr.md")
    expect(msg!).not.toContain('skill "brainstorming"')
    expect(msg!).not.toContain("MEMORY.md")
  })

  // --- tilde form of a workflow file counts too ---
  test("1 orchestrator skill + 1 workflow read → remaining list shrinks", async () => {
    loadRead(S, "~/.config/opencode/memory/topics/workflow.md")
    const msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).not.toContain("topics/workflow.md;")
    expect(msg!).toContain("workflow-git-pr.md")
    expect(msg!).toContain('skill "subagent-driven-development"')
    expect(msg!).toContain('skill "prompt-engineering-patterns"')
  })

  // --- partial: second orchestrator skill loaded, but second workflow read still missing ---
  test("partial orchestrator (1/2 workflow reads) → deny lists missing skills + missing read only", async () => {
    loadSkill(S, "dispatching-parallel-agents")
    const msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "subagent-driven-development"')
    expect(msg!).not.toContain('skill "dispatching-parallel-agents"')
    expect(msg!).toContain('skill "prompt-engineering-patterns"')
    expect(msg!).toContain("workflow-git-pr.md")
    expect(msg!).not.toContain("topics/workflow.md;")
    expect(msg!).not.toContain("MEMORY.md")
  })

  // --- full compliance → subagent passes (workflow-git-pr via absolute path) ---
  test("full compliance (6 skills + 3 reads) lifts the dispatch gate", async () => {
    loadSkill(S, "subagent-driven-development")
    loadSkill(S, "prompt-engineering-patterns")
    loadRead(S, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
    const m2 = await denyMsg({
      tool: "subagent",
      sessionID: S,
      input: { agent: "code-reviewer", background: true, prompt: GOOD_PROMPT },
    })
    expect(m2).toBeNull()
  })

  // --- whitelist at zero state (second session): read/grep/glob/skill/question never gated ---
  test("whitelist (incl. read) never gated, other session at zero state", async () => {
    let wl = true
    for (const ev of [
      { tool: "read", input: { path: "/etc/hostname" } },
      { tool: "grep", input: {} },
      { tool: "glob", input: {} },
      { tool: "todowrite", input: {} },
      { tool: "question", input: {} },
      { tool: "skill", input: { id: "brainstorming" } },
      { tool: "read_mcp_resource", input: {} },
    ]) {
      const m = await denyMsg({ ...ev, sessionID: "sess-other" })
      if (m !== null) {
        wl = false
        console.log("   whitelist deny:", ev.tool, m.slice(0, 80))
      }
    }
    expect(wl).toBeTrue()
  })

  // --- per-session isolation of reads: sess-other has no skills → its deny lists skills again ---
  test("second session still fully gated (reads are per-session)", async () => {
    const msg = await denyMsg({ tool: "shell", sessionID: "sess-other", input: {} })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "brainstorming"')
    expect(msg!).toContain("read of ~/.config/opencode/MEMORY.md")
  })

  // --- general/background still win on subagent at zero state (third session) ---
  test("general ban message still wins at zero state", async () => {
    const msg = await denyMsg({ tool: "subagent", sessionID: "sess-3", input: { agent: "general", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain("FORBIDDEN")
    expect(msg!).toContain("COMPLIANCE WARNING")
  })

  test("background message still wins (before gate)", async () => {
    const msg = await denyMsg({ tool: "subagent", sessionID: "sess-3", input: { agent: "code-reviewer", background: false } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain("background:true")
    expect(msg!).toContain("COMPLIANCE WARNING")
  })

  // --- execute (Code Mode) gated at zero state — ext-2 probe semantics (bypass surface) ---
  test("execute DENIED at zero state (bypass-surface gate)", async () => {
    const msg = await denyMsg({ tool: "execute", sessionID: "sess-execute", input: { code: "return 1" } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "brainstorming"')
    expect(msg!).toContain("read of ~/.config/opencode/MEMORY.md")
  })

  // --- kill switch ---
  test("kill switch disables everything", async () => {
    process.env.OPENCODE_ENFORCE_OFF = "1"
    let pass = true
    try {
      await hooks["tool.execute.before"]({ tool: "shell", sessionID: "sess-x", input: {} })
    } catch {
      pass = false
    }
    delete process.env.OPENCODE_ENFORCE_OFF
    expect(pass).toBeTrue()
  })

  // --- layer 4 intact ---
  test("subagent description still extended", () => {
    expect(transformed!.subagent.description).toContain("FORBIDDEN")
    expect(transformed!.subagent.description).toContain("background:true")
  })

  // --- primer: 12 bullets, both gate lines ---
  test("primer carries both gate lines (incl. memory + orchestrator line)", async () => {
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    const primer = sys[0]?.text ?? ""
    expect(primer).toContain("a `read` of ~/.config/opencode/MEMORY.md")
    expect(primer).toContain("subagent-driven-development")
    expect(primer).toContain("prompt-engineering-patterns")
    expect(primer).toContain("workflow-git-pr.md")
  })

  test("primer bullet count = 12", async () => {
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    const primer = sys[0]?.text ?? ""
    expect((primer.match(/^- /gm) ?? []).length).toBe(12)
  })
})

// --- ext 5: deterministic prompt-structure gate (subagent + stitch free-text prompts) ---
describe("dispatch-policy — ext 5 prompt-structure gate", () => {
  const PE = "sess-pe" // fully compliant session for structure tests
  const complyAll = (sid: string) => {
    for (const s of [
      "brainstorming",
      "grilling",
      "build-with-exa",
      "subagent-driven-development",
      "dispatching-parallel-agents",
      "prompt-engineering-patterns",
    ])
      loadSkill(sid, s)
    loadRead(sid, `${HOME}/.config/opencode/MEMORY.md`)
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow.md`)
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
  }

  test("structured subagent brief passes bans + gate + structure", async () => {
    complyAll(PE)
    const m = await denyMsg({
      tool: "subagent",
      sessionID: PE,
      input: { agent: "code-reviewer", background: true, prompt: GOOD_PROMPT },
    })
    expect(m).toBeNull()
  })

  test("brief missing Context and Output → deny lists exactly those two", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: PE,
      input: {
        agent: "code-reviewer",
        background: true,
        prompt: "You are a Go engineer. Task: fix the race. Constraints: no new deps; tests must pass.",
      },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("Missing required block(s): Context; Output format.")
    expect(m!).toContain("prompt-structure check")
    expect(m!).toContain("COMPLIANCE WARNING")
  })

  test("missing/empty prompt → deny (all blocks listed)", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: PE,
      input: { agent: "code-reviewer", background: true },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("The dispatch prompt is missing or empty.")
    expect(m!).toContain("Missing required block(s): Role; Task; Context; Constraints; Output format.")
  })

  test("continuation dispatch (sessionID present) is exempt from the structure check", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: PE,
      input: { agent: "code-reviewer", background: true, prompt: "please continue", sessionID: "ses_cont" },
    })
    expect(m).toBeNull()
  })

  test("stitch long unstructured prompt → deny lists the 4-block profile", async () => {
    const weak = "make the app look better overall with nicer colors everywhere and modern typography ".repeat(3)
    const m = await denyMsg({ tool: "stitch_generate_screen_from_text", sessionID: PE, input: { prompt: weak } })
    expect(m).not.toBeNull()
    expect(m!).toContain('MCP tool "stitch_generate_screen_from_text"')
    expect(m!).toContain("Missing required block(s): Task; Context; Constraints; Output format.")
  })

  test("stitch long structured prompt passes", async () => {
    const m = await denyMsg({
      tool: "stitch_edit_screens",
      sessionID: PE,
      input: { prompt: GOOD_STITCH_PROMPT, projectId: "4044680601076201931" },
    })
    expect(m).toBeNull()
  })

  test("stitch short follow-up suggestion passes (length floor)", async () => {
    const m = await denyMsg({
      tool: "stitch_generate_variants",
      sessionID: PE,
      input: { prompt: "Yes, make them all" },
    })
    expect(m).toBeNull()
  })

  test("stitch tools are not skill-gated (zero-state session, short prompt)", async () => {
    const m = await denyMsg({
      tool: "stitch_generate_screen_from_text",
      sessionID: "sess-stitch0",
      input: { prompt: "make it dark" },
    })
    expect(m).toBeNull()
  })

  test("structure check runs AFTER the skill gate (zero-state subagent → gate message wins)", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: "sess-order",
      input: { agent: "code-reviewer", background: true, prompt: "fix stuff" },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain('skill "brainstorming"')
    expect(m!).not.toContain("prompt-structure check")
  })
})

// --- ext 6 wave 1: memory-mandate keyword (6.1), memory whole-file overwrite guard
// (6.6), actionable agent-missing deny (6.7). Fixtures mirror the ext 5 style.
describe("dispatch-policy — ext 6 wave 1 (memory mandate, memory-overwrite guard, agent-missing deny)", () => {
  const E6 = "sess-ext6" // fully compliant session for the ext 6 checks
  const complyAll = (sid: string) => {
    for (const s of [
      "brainstorming",
      "grilling",
      "build-with-exa",
      "subagent-driven-development",
      "dispatching-parallel-agents",
      "prompt-engineering-patterns",
    ])
      loadSkill(sid, s)
    loadRead(sid, `${HOME}/.config/opencode/MEMORY.md`)
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow.md`)
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
  }

  // ext-6 fix round 1 (finding 6): compliance is a beforeEach fixture so single-test
  // runs (`bun test -t …`) reach the intended policy assertions instead of dying at the
  // skill gate. The dedicated zero-state sessions used by ordering/ban tests stay zero-state.
  beforeEach(() => {
    complyAll(E6)
  })

  // Structured brief with NO memory-mandate keyword anywhere (all five blocks present,
  // so the structure check passes and the memory-mandate check is what must fire).
  const STRUCTURED_NO_MEMORY =
    "Role: you are a senior Go engineer. Task: fix the race in the ingest loop. " +
    "Context: the worker pool drops events under load. " +
    "Constraints: no new dependencies; all tests must pass. " +
    "Output format: root-cause summary and the diff."

  // Russian-language brief: the memory mandate arrives as «обязательно прочти глобальную
  // память…» — pins the RU alternation of the memory-mandate regex.
  const RU_BRIEF =
    "Role: ты старший Go-инженер. Task: починить гонку в ingest-цикле. " +
    "Context: пул воркеров теряет события под нагрузкой. " +
    "Constraints: без новых зависимостей; все тесты должны проходить. " +
    "Output format: резюме причины и дифф. " +
    "Перед началом: обязательно прочти глобальную память и перечисли прочитанное в отчёте."

  // --- ext 6.1: memory-mandate keyword on fresh dispatch briefs ---
  test("fresh structured brief WITHOUT a memory mandate → deny names the missing mandate", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: E6,
      input: { agent: "code-reviewer", background: true, prompt: STRUCTURED_NO_MEMORY },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("does not mandate reading global memory")
    expect(m!).toContain("COMPLIANCE WARNING")
  })

  test("fresh RU brief mandating «глобальную память» passes the memory-mandate check", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: E6,
      input: { agent: "code-reviewer", background: true, prompt: RU_BRIEF },
    })
    expect(m).toBeNull()
  })

  test("continuation dispatch (sessionID present) is exempt from the memory-mandate check", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: E6,
      input: { agent: "code-reviewer", background: true, prompt: "please continue", sessionID: "ses_cont61" },
    })
    expect(m).toBeNull()
  })

  test("memory-mandate check runs AFTER the skill gate (zero-state brief → gate message wins)", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: "sess-ext6-order",
      input: { agent: "code-reviewer", background: true, prompt: STRUCTURED_NO_MEMORY },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain('skill "brainstorming"')
    expect(m!).not.toContain("does not mandate reading global memory")
  })

  // --- ext 6.6: whole-file `write` over an EXISTING global memory file — HERMETIC
  // (fix round 1, finding 2). Existence is decided exclusively by the _testStat seam
  // stub: no test creates, writes, or deletes anything under ~/.config/opencode/, and
  // the suite passes on a machine where the real memory files do not exist.
  const MEM_INDEX = path.resolve(os.homedir(), ".config", "opencode", "MEMORY.md")
  const MEM_WORKFLOW = path.resolve(os.homedir(), ".config", "opencode", "memory", "topics", "workflow.md")
  let defaultStat: (p: string) => boolean
  beforeEach(() => {
    defaultStat = _testStat.fn
  })
  afterEach(() => {
    _testStat.fn = defaultStat
  })

  test("write over the root MEMORY.md (canonical ~ form, stubbed existing) → memory-overwrite deny", async () => {
    _testStat.fn = (p) => p === MEM_INDEX
    const m = await denyMsg({ tool: "write", sessionID: E6, input: { path: "~/.config/opencode/MEMORY.md" } })
    expect(m).not.toBeNull()
    expect(m!).toContain("whole-file write over an EXISTING global memory file")
    expect(m!).toContain("COMPLIANCE WARNING")
  })

  test("write over MEMORY.md via an absolute dot-segment path → deny (normalize closes the bypass)", async () => {
    _testStat.fn = (p) => p === MEM_INDEX
    const m = await denyMsg({
      tool: "write",
      sessionID: E6,
      input: { path: `${HOME}/.config/opencode/./MEMORY.md` },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("whole-file write over an EXISTING global memory file")
  })

  test("write over MEMORY.md via a ..-segment path → deny (same normalize class)", async () => {
    _testStat.fn = (p) => p === MEM_INDEX
    const m = await denyMsg({
      tool: "write",
      sessionID: E6,
      input: { path: `${HOME}/.config/opencode/memory/../MEMORY.md` },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("whole-file write over an EXISTING global memory file")
  })

  test("write under /tmp/.config/opencode/memory/ is NOT global memory → passes (no false positive)", async () => {
    _testStat.fn = () => true // even "existing", it is not a global-memory target
    const m = await denyMsg({ tool: "write", sessionID: E6, input: { path: "/tmp/.config/opencode/memory/x.md" } })
    expect(m).toBeNull()
  })

  test("write to a dot-named file INSIDE the memory tree is guarded (no allow false negative)", async () => {
    _testStat.fn = () => true
    const m = await denyMsg({
      tool: "write",
      sessionID: E6,
      input: { path: "~/.config/opencode/memory/..notes.md" },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("whole-file write over an EXISTING global memory file")
  })

  test("write to a non-memory path passes", async () => {
    _testStat.fn = () => true
    const m = await denyMsg({
      tool: "write",
      sessionID: E6,
      input: { path: "/tmp/opencode/mandator-ext6/ext6-scratch.txt" },
    })
    expect(m).toBeNull()
  })

  test("write creating a NEW file under memory/topics/ passes (seam: missing → false)", async () => {
    _testStat.fn = () => false
    const m = await denyMsg({
      tool: "write",
      sessionID: E6,
      input: { path: "~/.config/opencode/memory/topics/zzz-ext6-nonexistent-topic.md" },
    })
    expect(m).toBeNull()
  })

  test("legacy `filePath` input key with an existing memory path → deny (both keys checked)", async () => {
    _testStat.fn = (p) => p === MEM_WORKFLOW
    const m = await denyMsg({
      tool: "write",
      sessionID: E6,
      input: { filePath: "~/.config/opencode/memory/topics/workflow.md" },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("whole-file write over an EXISTING global memory file")
  })

  test("`path` wins over legacy `filePath` when both are present", async () => {
    _testStat.fn = () => true // everything "exists"; only `path` may be inspected
    const m = await denyMsg({
      tool: "write",
      sessionID: E6,
      input: {
        path: "/tmp/opencode/mandator-ext6/ext6-scratch.txt",
        filePath: `${HOME}/.config/opencode/MEMORY.md`,
      },
    })
    expect(m).toBeNull()
  })

  test("seam throwing → allow (documented fail-open hygiene backstop)", async () => {
    _testStat.fn = () => {
      throw new Error("stat exploded")
    }
    const m = await denyMsg({ tool: "write", sessionID: E6, input: { path: "~/.config/opencode/MEMORY.md" } })
    expect(m).toBeNull()
  })

  test("memory-overwrite check runs AFTER the skill gate (zero-state write → gate message wins)", async () => {
    const m = await denyMsg({
      tool: "write",
      sessionID: "sess-ext6-write0",
      input: { path: "~/.config/opencode/MEMORY.md" },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain('skill "brainstorming"')
    expect(m!).not.toContain("whole-file write")
  })

  // --- ext 6.7: actionable deny for missing/empty agent (bans run before the gate) ---
  test("dispatch with `agent` missing → actionable deny, not the generic schema error", async () => {
    const m = await denyMsg({ tool: "subagent", sessionID: "sess-ext6-bans", input: { background: true } })
    expect(m).not.toBeNull()
    expect(m!).toContain("missing a specialized agent type")
    expect(m!).toContain("COMPLIANCE WARNING")
  })

  test("dispatch with `agent: \"\"` → same actionable deny", async () => {
    const m = await denyMsg({ tool: "subagent", sessionID: "sess-ext6-bans", input: { agent: "", background: true } })
    expect(m).not.toBeNull()
    expect(m!).toContain("missing a specialized agent type")
  })

  test("dispatch with whitespace-only `agent` → same actionable deny (empty after trim)", async () => {
    const m = await denyMsg({ tool: "subagent", sessionID: "sess-ext6-bans", input: { agent: "   ", background: true } })
    expect(m).not.toBeNull()
    expect(m!).toContain("missing a specialized agent type")
  })

  test("agent: \"general\" still gets the FORBIDDEN ban message (ban wins over the missing check)", async () => {
    const m = await denyMsg({
      tool: "subagent",
      sessionID: "sess-ext6-bans",
      input: { agent: "general", background: true },
    })
    expect(m).not.toBeNull()
    expect(m!).toContain("FORBIDDEN")
    expect(m!).not.toContain("missing a specialized agent type")
  })
})

// --- ext 6.4: identical-dispatch circuit breaker (wave 2, owner approved 2026-10-25).
// Per-session counters bucketed by djb2(agent + NUL + prompt), with exact (agent, prompt)
// comparison inside each bucket (fix round 1: 32-bit djb2 collisions are real — a
// colliding pair keeps its own counter); fresh dispatches only (continuations exempt —
// governed by the backlogged ext-6.3 depth cap); increment-then-check; deny when the
// per-session count reaches 4 (3 identical executions pass). Check site: LAST on the
// fresh path — after the structure and memory-mandate checks.
//
// The breaker state lives at module scope (beside the gate Maps) and bun runs tests
// in declaration order, so EVERY test below uses its own fresh session ID: counters
// always start from zero within a test and never leak across tests.
describe("dispatch-policy — ext 6.4 identical-dispatch circuit breaker", () => {
  const complyAll = (sid: string) => {
    for (const s of [
      "brainstorming",
      "grilling",
      "build-with-exa",
      "subagent-driven-development",
      "dispatching-parallel-agents",
      "prompt-engineering-patterns",
    ])
      loadSkill(sid, s)
    loadRead(sid, `${HOME}/.config/opencode/MEMORY.md`)
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow.md`)
    loadRead(sid, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
  }

  const dispatch = (sid: string, agent: string, prompt: string, contSessionID?: string) =>
    denyMsg({
      tool: "subagent",
      sessionID: sid,
      input: contSessionID === undefined
        ? { agent, background: true, prompt }
        : { agent, background: true, prompt, sessionID: contSessionID },
    })

  test("same (agent, prompt) dispatched 3x → all pass (threshold is 4)", async () => {
    const sid = "sess-ext64-3x"
    complyAll(sid)
    for (let i = 0; i < 3; i++) {
      const m = await dispatch(sid, "code-reviewer", GOOD_PROMPT)
      expect(m).toBeNull()
    }
  })

  test("4th identical dispatch → deny contains 'runaway-loop guard' and the count '4'", async () => {
    const sid = "sess-ext64-4x"
    complyAll(sid)
    for (let i = 0; i < 3; i++) {
      const m = await dispatch(sid, "code-reviewer", GOOD_PROMPT)
      expect(m).toBeNull()
    }
    const m4 = await dispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m4).not.toBeNull()
    expect(m4!).toContain("runaway-loop guard")
    expect(m4!).toContain("4")
  })

  test("same number of dispatches with different prompts → all pass (no shared counter)", async () => {
    const sid = "sess-ext64-diff-prompts"
    complyAll(sid)
    for (const perspective of ["performance", "security", "API stability", "error handling"]) {
      const m = await dispatch(sid, "code-reviewer", `${GOOD_PROMPT} Review perspective: ${perspective}.`)
      expect(m).toBeNull()
    }
  })

  test("same prompt, different agent → different hash (both pass)", async () => {
    const sid = "sess-ext64-diff-agents"
    complyAll(sid)
    const m1 = await dispatch(sid, "code-reviewer", GOOD_PROMPT)
    const m2 = await dispatch(sid, "backend-architect", GOOD_PROMPT)
    expect(m1).toBeNull()
    expect(m2).toBeNull()
  })

  test("continuation dispatches with an identical short prompt are never counted, always pass", async () => {
    const sid = "sess-ext64-cont"
    complyAll(sid)
    for (let i = 0; i < 6; i++) {
      const m = await dispatch(sid, "code-reviewer", "please continue", "ses_child_ext64")
      expect(m).toBeNull()
    }
  })

  test("per-session isolation: the same hash in a second session starts from zero", async () => {
    const sidA = "sess-ext64-iso-a"
    complyAll(sidA)
    for (let i = 0; i < 3; i++) await dispatch(sidA, "code-reviewer", GOOD_PROMPT)
    // sidA is now one dispatch away from the breaker; a second session starts at zero.
    const sidB = "sess-ext64-iso-b"
    complyAll(sidB)
    const m = await dispatch(sidB, "code-reviewer", GOOD_PROMPT)
    expect(m).toBeNull()
  })

  test("ordering: zero-state session → skill-gate deny wins (breaker not reached)", async () => {
    const m = await dispatch("sess-ext64-order0", "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain('skill "brainstorming"')
    expect(m!).not.toContain("runaway-loop guard")
  })

  test("ordering: malformed brief at a compliant session → structure deny wins, repeatedly (breaker not reached)", async () => {
    const sid = "sess-ext64-order-struct"
    complyAll(sid)
    const malformed = "You are a Go engineer. Task: fix the race. Constraints: no new deps; tests must pass."
    for (let i = 0; i < 5; i++) {
      const m = await dispatch(sid, "code-reviewer", malformed)
      expect(m).not.toBeNull()
      expect(m!).toContain("prompt-structure check")
      expect(m!).not.toContain("runaway-loop guard")
    }
  })

  test("breaker deny message: NO 're-run this exact call', NO 'COMPLIANCE WARNING'", async () => {
    const sid = "sess-ext64-msg"
    complyAll(sid)
    let m: string | null = null
    for (let i = 0; i < 4; i++) m = await dispatch(sid, "code-reviewer", GOOD_PROMPT)
    expect(m).not.toBeNull()
    expect(m!).toContain("runaway-loop guard")
    expect(m!).not.toContain("re-run this exact call")
    expect(m!).not.toContain("COMPLIANCE WARNING")
  })

  // --- fix round 1 (PR #5 CodeRabbit finding): the 32-bit djb2 digest is a BUCKET INDEX
  // only — a real collision would otherwise merge the counts of two different pairs. The
  // tests brute-force a REAL collision pair via the exposed _djb2 seam (deterministic
  // given the algorithm; search bounded to <=3-char suffixes over a 64-char alphabet) and
  // prove that a colliding pair B keeps its own counter: its FIRST dispatch must pass,
  // and it must not advance pair A's count toward the cap.
  const collide = (): [string, string] => {
    const ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/"
    const seen = new Map<string, string>()
    for (const len of [1, 2, 3]) {
      const total = ALPHABET.length ** len
      for (let n = 0; n < total; n++) {
        let suffix = ""
        let x = n
        for (let i = 0; i < len; i++) {
          suffix = ALPHABET[x % ALPHABET.length] + suffix
          x = Math.floor(x / ALPHABET.length)
        }
        const digest = _djb2.fn(`code-reviewer\u0000${GOOD_PROMPT}${suffix}`)
        const first = seen.get(digest)
        if (first !== undefined) return [first, suffix]
        seen.set(digest, suffix)
      }
    }
    throw new Error("bounded collision search exhausted — djb2 candidate space produced no pair")
  }

  test("collision independence: colliding pair B (different prompt) is counted separately — its first dispatch passes", async () => {
    const sid = "sess-ext64-collision"
    complyAll(sid)
    const [suffixA, suffixB] = collide()
    const promptA = `${GOOD_PROMPT}${suffixA}`
    const promptB = `${GOOD_PROMPT}${suffixB}`
    expect(promptA).not.toBe(promptB) // different pairs...
    expect(_djb2.fn(`code-reviewer\u0000${promptA}`)).toBe(_djb2.fn(`code-reviewer\u0000${promptB}`)) // ...same bucket
    // Pair A dispatched 3x → all pass.
    for (let i = 0; i < 3; i++) expect(await dispatch(sid, "code-reviewer", promptA)).toBeNull()
    // Pair B, colliding digest, different prompt, 1x → must PASS: pre-fix, the shared
    // 32-bit bucket counter made this exact dispatch pair A's "identical #4" (deny).
    expect(await dispatch(sid, "code-reviewer", promptB)).toBeNull()
  })

  test("collision independence: pair B does not advance pair A's count — 4th identical A denies with count 4", async () => {
    const sid = "sess-ext64-collision-cap"
    complyAll(sid)
    const [suffixA, suffixB] = collide()
    const promptA = `${GOOD_PROMPT}${suffixA}`
    const promptB = `${GOOD_PROMPT}${suffixB}`
    for (let i = 0; i < 3; i++) expect(await dispatch(sid, "code-reviewer", promptA)).toBeNull()
    expect(await dispatch(sid, "code-reviewer", promptB)).toBeNull()
    // Pair A's counter is still at 3 (untouched by pair B): the 4th identical A denies
    // with count 4 — not 5 (which a shared/merged count would report).
    const m4 = await dispatch(sid, "code-reviewer", promptA)
    expect(m4).not.toBeNull()
    expect(m4!).toContain("runaway-loop guard")
    expect(m4!).toContain("4")
  })
})
