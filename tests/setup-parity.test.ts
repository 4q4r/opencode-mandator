// tests/setup-parity.test.ts — the canonical setup fixture contract (supersedes
// tests/defaults-parity.test.ts after the opt-in flip, owner decision 2026-11-07).
//
// The owner's setup is no longer encoded in src/defaults.ts (empty defaults = inert
// plugin); it lives as explicit configuration in tests/fixtures/mandator-setup.json —
// the canonical snapshot the owner will place into ~/.config/opencode/opencode.json
// (plugin object-form) after merge. Contract:
//   (a) the fixture exists, parses, and RESOLVES to the owner setup (independent
//       literal for the enforcement groups; pass-through for messages/primer) with
//       zero problems;
//   (b) the fixture's message texts are the CURRENT deny texts still emitted (proven
//       behaviorally: a fixture-configured session renders exactly fill(<fixture
//       template>) + <fixture trailer>);
//   (c) no-options = inert (a compact subset of tests/opt-in.test.ts, asserted here so
//       the parity file alone proves both halves of the flip).
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { readFileSync } from "node:fs"
import plugin from "../src/dispatch-policy.ts"
import { resolveOptions } from "../src/config.ts"
import { deepFreeze, fill } from "../src/defaults.ts"

const SETUP = JSON.parse(
  readFileSync(new URL("./fixtures/mandator-setup.json", import.meta.url), "utf8"),
) as Record<string, unknown>

// Independent literal of the owner setup's enforcement groups in RESOLVED shape (the
// drift guard: the fixture must keep meaning exactly this).
const ENFORCEMENT_SNAPSHOT = deepFreeze({
  dispatch: {
    tools: ["subagent"],
    forbiddenAgents: ["general"],
    requireBackground: true,
    requireAgent: true,
    problems: [],
  },
  skills: {
    mandatory: ["brainstorming", "grilling", "build-with-exa", "context7-mcp"],
    orchestrator: [
      "subagent-driven-development",
      "dispatching-parallel-agents",
      "prompt-engineering-patterns",
    ],
    problems: [],
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
    problems: [],
    memoryMandateProblems: [],
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
    problems: [],
    stitchProblems: [],
  },
  paths: {
    memoryIndex: "~/.config/opencode/MEMORY.md",
    memoryTree: "~/.config/opencode/memory",
    problems: [],
  },
  caps: {
    identicalMax: 4,
    chainMax: 6,
    chainOverrideMarker: "[chain-cap-override]",
    identicalProblems: [],
    chainMaxProblems: [],
    markerProblems: [],
  },
})

// --- harness for the behavioral half ((b) and (c)) ---
const hooks: Record<string, (event: any) => any> = {}
const ctx: any = {
  options: undefined as unknown,
  tool: {
    hook: async (name: string, cb: (e: any) => any) => {
      hooks[`tool.${name}`] = cb
    },
    transform: async () => {},
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

describe("setup parity — the canonical fixture resolves to the owner setup", () => {
  test("(a) fixture exists, parses, and carries all 8 groups (36 option values)", () => {
    expect(Object.keys(SETUP).sort()).toEqual(["caps", "dispatch", "gates", "messages", "paths", "primer", "skills", "structure"])
    expect(SETUP.primer).toHaveProperty("mode", "default")
    expect(typeof (SETUP.primer as { text: string }).text).toBe("string")
  })

  test("(a) resolved enforcement groups deep-equal the owner-setup snapshot", () => {
    const { resolved, problems } = resolveOptions(SETUP)
    expect(problems).toEqual([])
    expect(resolved.dispatch).toEqual(ENFORCEMENT_SNAPSHOT.dispatch)
    expect(resolved.skills).toEqual(ENFORCEMENT_SNAPSHOT.skills)
    expect(resolved.gates).toEqual(ENFORCEMENT_SNAPSHOT.gates)
    expect(resolved.structure).toEqual(ENFORCEMENT_SNAPSHOT.structure)
    expect(resolved.paths).toEqual(ENFORCEMENT_SNAPSHOT.paths)
    expect(resolved.caps).toEqual(ENFORCEMENT_SNAPSHOT.caps)
  })

  test("(a) resolved messages pass the fixture texts through verbatim; primer resolves to the fixture PRIMER", () => {
    const { resolved, problems } = resolveOptions(SETUP)
    expect(problems).toEqual([])
    expect(resolved.messages).toEqual({ ...(SETUP.messages as object), problems: [] })
    expect(resolved.primer).toEqual({ text: (SETUP.primer as { text: string }).text, problems: [] })
    expect(resolved.primer.text.startsWith("[auto-injected operating rules — non-negotiable]")).toBeTrue()
    expect(resolved.primer.text).toContain("OWNER-LOCKED")
  })

  test("(b) fixture message texts are the CURRENT deny texts (the historical markers are present)", () => {
    const messages = SETUP.messages as Record<string, string>
    expect(messages.complianceWarning).toContain("COMPLIANCE WARNING: all output is audited")
    expect(messages.generalBan).toContain("DENIED by dispatch-policy plugin: agent type \"{agent}\" is FORBIDDEN")
    expect(messages.gateMissing).toContain("Owner mandate: this action requires, in this session first: {missing}")
    expect(messages.identicalLoopFail).toContain("runaway-loop guard on identical (agent, prompt) pairs")
    expect(messages.chainCapFail).toContain("[chain-cap-override] <reason>")
    expect(messages.mcpSkillFail).toContain("requires its skill first")
    expect(messages.memoryOverwriteFail).toContain("whole-file write over an EXISTING global memory file")
    expect(messages.descriptionHint).toContain("POLICY (enforced by the dispatch-policy plugin)")
    // the identical-loop deny is the only trailer-less body: the trailer text must NOT
    // be embedded in any template (composed mechanically by the plugin)
    for (const [key, template] of Object.entries(messages)) {
      if (key === "complianceWarning" || key === "mcpSkillHints") continue
      if (key === "identicalLoopFail") {
        expect(template).not.toContain("COMPLIANCE WARNING")
        continue
      }
      expect(template).not.toContain("COMPLIANCE WARNING")
    }
  })
})

describe("setup parity — fixture-configured sessions render the fixture texts", () => {
  let savedOptions: unknown
  beforeAll(async () => {
    savedOptions = ctx.options
    ctx.options = SETUP
    await plugin.setup(ctx)
  })
  afterAll(() => {
    ctx.options = savedOptions
  })

  test("(b) zero-state gated deny renders exactly fill(fixture.gateMissing) + fixture trailer", async () => {
    const { resolved } = resolveOptions(SETUP)
    const missing = [
      ...resolved.skills.mandatory.map((s) => `skill "${s}"`),
      `read of ~/${resolved.gates.readTargets.find((t) => t.key === "memory")!.suffix}`,
    ].join("; ")
    const expected =
      fill((SETUP.messages as Record<string, string>).gateMissing, { missing }) +
      (SETUP.messages as Record<string, string>).complianceWarning
    const m = await denyMsg({ tool: "shell", sessionID: "sess-setupparity-gate", input: {} })
    expect(m).toBe(expected)
  })

  test("(b) general ban renders exactly fill(fixture.generalBan) + fixture trailer", async () => {
    const messages = SETUP.messages as Record<string, string>
    const expected =
      fill(messages.generalBan, { agent: "general" }) + messages.complianceWarning
    const m = await denyMsg({
      tool: "subagent",
      sessionID: "sess-setupparity-ban",
      input: { agent: "general", background: true },
    })
    expect(m).toBe(expected)
  })

  test("(b) the injected primer IS the fixture PRIMER text", async () => {
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(1) // primer only — fixture config has zero problems
    expect(sys[0]!.text).toBe((SETUP.primer as { text: string }).text)
  })
})

describe("setup parity — no options = inert (compact opt-in subset)", () => {
  beforeAll(async () => {
    ctx.options = undefined
    await plugin.setup(ctx)
  })

  test("(c) shell passes at zero state; general-dispatch passes; no primer part", async () => {
    expect(await denyMsg({ tool: "shell", sessionID: "sess-setupparity-inert", input: {} })).toBeNull()
    expect(
      await denyMsg({
        tool: "subagent",
        sessionID: "sess-setupparity-inert2",
        input: { agent: "general", background: false, prompt: "x" },
      }),
    ).toBeNull()
    const sys: any[] = []
    await hooks["session.context"]({ system: sys, messages: [] })
    expect(sys.length).toBe(0)
  })
})
