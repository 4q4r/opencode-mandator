// tests/opt-in.test.ts — the INERT suite (opt-in enforcement flip, owner decision
// 2026-11-07: "Empty defaults, setup in JSON"). Contract: with NO options the plugin is
// COMPLETELY INERT — no gates, no denies, no primer injection, no description hint, no
// config problems. Enforcement exists only via explicit configuration (canonical owner
// setup: tests/fixtures/mandator-setup.json). Every guard runs ONLY when its
// configuration makes it meaningful; the empty defaults turn every guard off.
//
// This file has its own module state (bun isolates per test file). setup() is called
// once with ctx.options undefined — the no-options path. Session IDs are unique per
// test (the per-session Maps live at module scope and outlive individual setup calls).
import { describe, expect, test, beforeAll } from "bun:test"
import plugin, { _testStat } from "../src/dispatch-policy.ts"

const hooks: Record<string, (event: any) => any> = {}
let transformed: Record<string, { description: string }> | null = null

const ctx: any = {
  options: undefined as unknown, // the whole point: NO options
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

const runTool = async (event: any): Promise<string | null> => {
  try {
    await hooks["tool.execute.before"](event)
    return null
  } catch (e: any) {
    return String(e.message)
  }
}

beforeAll(async () => {
  await plugin.setup(ctx)
})

describe("opt-in — no options: the plugin is completely inert", () => {
  test("gated tools pass at zero state (no skill/memory gate)", async () => {
    const sid = "sess-inert-gate"
    for (const ev of [
      { tool: "shell", input: {} },
      { tool: "edit", input: {} },
      { tool: "write", input: {} },
      { tool: "webfetch", input: {} },
      { tool: "websearch", input: {} },
      { tool: "execute", input: { code: "return 1" } },
      { tool: "exa_web_search_exa", input: {} },
    ]) {
      const m = await runTool({ ...ev, sessionID: sid })
      expect(m).toBeNull()
    }
  })

  test("context7 MCP tool passes (no MCP→skill gate)", async () => {
    const m = await runTool({ tool: "context7_resolve_library_id", sessionID: "sess-inert-mcp", input: {} })
    expect(m).toBeNull()
    const m2 = await runTool({ tool: "adb_mcp_connect_device", sessionID: "sess-inert-mcp-adb", input: {} })
    expect(m2).toBeNull()
  })

  test("subagent with agent 'general' PASSES (ban list empty — ban off)", async () => {
    const m = await runTool({
      tool: "subagent",
      sessionID: "sess-inert-general",
      input: { agent: "general", background: true, prompt: "anything" },
    })
    expect(m).toBeNull()
  })

  test("subagent without background:true PASSES (requireBackground false)", async () => {
    const m = await runTool({
      tool: "subagent",
      sessionID: "sess-inert-bg",
      input: { agent: "code-reviewer", background: false, prompt: "anything" },
    })
    expect(m).toBeNull()
  })

  test("subagent with agent missing PASSES (requireAgent false)", async () => {
    const m = await runTool({
      tool: "subagent",
      sessionID: "sess-inert-noagent",
      input: { background: true, prompt: "anything" },
    })
    expect(m).toBeNull()
  })

  test("continuation #100 of one child PASSES (chain cap null)", async () => {
    const sid = "sess-inert-chain"
    for (let i = 1; i <= 100; i++) {
      const m = await runTool({
        tool: "subagent",
        sessionID: sid,
        input: { agent: "code-reviewer", background: true, prompt: `step ${i}`, sessionID: "ses_child_inert" },
      })
      if (m !== null) throw new Error(`continuation #${i} denied: ${m}`)
    }
  })

  test("identical-dispatch loop never denies (breaker null)", async () => {
    const sid = "sess-inert-identical"
    for (let i = 0; i < 6; i++) {
      const m = await runTool({
        tool: "subagent",
        sessionID: sid,
        input: { agent: "code-reviewer", background: true, prompt: "same prompt every time" },
      })
      if (m !== null) throw new Error(`identical dispatch #${i + 1} denied: ${m}`)
    }
  })

  test("write over the REAL ~/.config/opencode/MEMORY.md path PASSES (paths empty — overwrite guard off; hermetic via _testStat)", async () => {
    const defaultStat = _testStat.fn
    _testStat.fn = () => true // everything "exists": only classification could deny, and it is off
    try {
      const m = await runTool({
        tool: "write",
        sessionID: "sess-inert-write",
        input: { path: "~/.config/opencode/MEMORY.md" },
      })
      expect(m).toBeNull()
      const m2 = await runTool({
        tool: "write",
        sessionID: "sess-inert-write-tree",
        input: { path: "~/.config/opencode/memory/topics/workflow.md" },
      })
      expect(m2).toBeNull()
    } finally {
      _testStat.fn = defaultStat
    }
  })

  test("stitch long unstructured prompt PASSES (stitchPromptTools empty — surface off)", async () => {
    const m = await runTool({
      tool: "stitch_generate_screen_from_text",
      sessionID: "sess-inert-stitch",
      input: { prompt: "make the app look better overall with nicer colors everywhere and modern typography ".repeat(3) },
    })
    expect(m).toBeNull()
  })

  test("session.context pushes NO primer part and NO problems part", async () => {
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(0) // no PRIMER, no config-problems text
  })

  test("tool transform leaves the subagent description UNCHANGED (no description hint)", () => {
    expect(transformed!.subagent.description).toBe("ORIG")
  })
})
