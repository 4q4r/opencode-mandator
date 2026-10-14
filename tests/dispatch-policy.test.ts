// tests/dispatch-policy.test.ts — bun test port of the wave3-a2 logic probe suite.
// Basis: tests/probe-original.ts (probe generations 26+24+24 checks; final ext-3 form).
// Probe semantics preserved 1:1: same events, same session IDs, same state-mutation
// order (bun runs tests in declaration order within a file). Structural changes only:
// bun:test harness instead of the linear check() script, and os.homedir() instead of
// the hardcoded "/home/whoami" (tilde-expansion parity with the plugin's own expansion).
import { beforeAll, describe, expect, test } from "bun:test"
import os from "node:os"
import plugin from "../src/dispatch-policy.ts"

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

beforeAll(async () => {
  await plugin.setup(ctx)
})

describe("dispatch-policy — port of the wave3-a2 probe suite (gate extension 3)", () => {
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
    expect(msg!).not.toContain("workflow.md")
  })

  test("subagent DENIED at zero; lists base + orchestrator items", async () => {
    const msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "brainstorming"')
    expect(msg!).toContain('skill "subagent-driven-development"')
    expect(msg!).toContain('skill "dispatching-parallel-agents"')
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
  test("subagent at base-complete → deny lists exactly 2 skills + 2 workflow reads", async () => {
    const msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "subagent-driven-development"')
    expect(msg!).toContain('skill "dispatching-parallel-agents"')
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
  })

  // --- partial: second orchestrator skill loaded, but second workflow read still missing ---
  test("partial orchestrator (1/2 workflow reads) → deny lists missing skill + missing read only", async () => {
    loadSkill(S, "dispatching-parallel-agents")
    const msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain('skill "subagent-driven-development"')
    expect(msg!).not.toContain('skill "dispatching-parallel-agents"')
    expect(msg!).toContain("workflow-git-pr.md")
    expect(msg!).not.toContain("topics/workflow.md;")
    expect(msg!).not.toContain("MEMORY.md")
  })

  // --- full compliance → subagent passes (workflow-git-pr via absolute path) ---
  test("full compliance (5 skills + 3 reads) lifts the dispatch gate", async () => {
    loadSkill(S, "subagent-driven-development")
    loadRead(S, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
    const m2 = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
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
  })

  test("background message still wins (before gate)", async () => {
    const msg = await denyMsg({ tool: "subagent", sessionID: "sess-3", input: { agent: "code-reviewer", background: false } })
    expect(msg).not.toBeNull()
    expect(msg!).toContain("background:true")
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
    expect(primer).toContain("workflow-git-pr.md")
  })

  test("primer bullet count = 12", async () => {
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    const primer = sys[0]?.text ?? ""
    expect((primer.match(/^- /gm) ?? []).length).toBe(12)
  })
})
