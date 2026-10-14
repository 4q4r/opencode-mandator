// Logic probe for dispatch-policy.ts (gate extension 3) — real module + mock ctx.
import plugin from "./dispatch-policy.ts"

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

let failures = 0
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  :: " + detail : ""}`)
  if (!ok) failures++
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

await plugin.setup(ctx)

check("execute.before registered", typeof hooks["tool.execute.before"] === "function")
check("execute.after registered", typeof hooks["tool.execute.after"] === "function")
check("session.context registered", typeof hooks["session.context"] === "function")

const S = "sess-ext3"
const HOME = "/home/whoami"

// --- Phase 0: zero state ---
let msg = await denyMsg({ tool: "shell", sessionID: S, input: {} })
check(
  "shell DENIED at zero; lists 3 skills + MEMORY.md; no orchestrator items",
  msg !== null &&
    msg.includes('skill "brainstorming"') &&
    msg.includes('skill "grilling"') &&
    msg.includes('skill "build-with-exa"') &&
    msg.includes("read of ~/.config/opencode/MEMORY.md") &&
    !msg.includes("subagent-driven-development") &&
    !msg.includes("workflow.md"),
  msg?.slice(0, 140) ?? "no deny",
)

msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
check(
  "subagent DENIED at zero; lists base + orchestrator items",
  msg !== null &&
    msg.includes('skill "brainstorming"') &&
    msg.includes('skill "subagent-driven-development"') &&
    msg.includes('skill "dispatching-parallel-agents"') &&
    msg.includes("workflow.md") &&
    msg.includes("workflow-git-pr.md"),
  msg?.slice(0, 140) ?? "no deny",
)

// skills loaded, memory unread → deny lists ONLY the memory read
loadSkill(S, "brainstorming")
loadSkill(S, "grilling")
loadSkill(S, "build-with-exa")
msg = await denyMsg({ tool: "edit", sessionID: S, input: {} })
check(
  "3/3 skills but memory unread → deny lists exactly the MEMORY.md read",
  msg !== null &&
    msg.includes("read of ~/.config/opencode/MEMORY.md") &&
    !msg.includes('skill "brainstorming"') &&
    !msg.includes("workflow"),
  msg?.slice(0, 140) ?? "no deny",
)

// memory read via ~ form + a wrong file → still deny
loadRead(S, "~/some/other/file.ts")
loadRead(S, "~/.config/opencode/memory/topics/workflow.md", "error") // failed read never counts
msg = await denyMsg({ tool: "edit", sessionID: S, input: {} })
check(
  "unrelated ~/ read + failed workflow read do not count",
  msg !== null && msg.includes("read of ~/.config/opencode/MEMORY.md"),
)

// memory read, absolute path → base satisfied; non-dispatch gated tools PASS
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
check("base-complete (skills + memory) lifts non-dispatch gates", pass)

// subagent still DENIED at base-complete; lists ONLY orchestrator items
msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
check(
  "subagent at base-complete → deny lists exactly 2 skills + 2 workflow reads",
  msg !== null &&
    msg.includes('skill "subagent-driven-development"') &&
    msg.includes('skill "dispatching-parallel-agents"') &&
    msg.includes("read of ~/.config/opencode/memory/topics/workflow.md") &&
    msg.includes("read of ~/.config/opencode/memory/topics/workflow-git-pr.md") &&
    !msg.includes('skill "brainstorming"') &&
    !msg.includes("MEMORY.md"),
  msg?.slice(0, 160) ?? "no deny",
)

// tilde form of a workflow file counts too
loadRead(S, "~/.config/opencode/memory/topics/workflow.md")
msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
check(
  "1 orchestrator skill + 1 workflow read → remaining list shrinks",
  msg !== null &&
    !msg.includes("topics/workflow.md;") &&
    msg.includes("workflow-git-pr.md") &&
    msg.includes('skill "subagent-driven-development"'),
  msg?.slice(0, 160) ?? "no deny",
)

// partial: second orchestrator skill loaded, but second workflow read still missing
loadSkill(S, "dispatching-parallel-agents")
msg = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
check(
  "partial orchestrator (1/2 workflow reads) → deny lists missing skill + missing read only",
  msg !== null &&
    msg.includes('skill "subagent-driven-development"') &&
    !msg.includes('skill "dispatching-parallel-agents"') &&
    msg.includes("workflow-git-pr.md") &&
    !msg.includes("topics/workflow.md;") &&
    !msg.includes("MEMORY.md"),
  msg?.slice(0, 160) ?? "no deny",
)

// full compliance → subagent passes (workflow-git-pr via absolute path)
loadSkill(S, "subagent-driven-development")
loadRead(S, `${HOME}/.config/opencode/memory/topics/workflow-git-pr.md`)
pass = true
const m2 = await denyMsg({ tool: "subagent", sessionID: S, input: { agent: "code-reviewer", background: true } })
if (m2 !== null) {
  pass = false
  console.log("   unexpected deny at full compliance:", m2.slice(0, 120))
}
check("full compliance (5 skills + 3 reads) lifts the dispatch gate", pass)

// whitelist at zero state (second session): read/grep/glob/skill/question never gated
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
check("whitelist (incl. read) never gated, other session at zero state", wl)

// per-session isolation of reads: sess-other has skills? no — check its deny lists skills again
msg = await denyMsg({ tool: "shell", sessionID: "sess-other", input: {} })
check(
  "second session still fully gated (reads are per-session)",
  msg !== null && msg.includes('skill "brainstorming"') && msg.includes("read of ~/.config/opencode/MEMORY.md"),
)

// general/background still win on subagent at zero state (third session)
msg = await denyMsg({ tool: "subagent", sessionID: "sess-3", input: { agent: "general", background: true } })
check("general ban message still wins at zero state", msg !== null && msg.includes("FORBIDDEN"))
msg = await denyMsg({ tool: "subagent", sessionID: "sess-3", input: { agent: "code-reviewer", background: false } })
check("background message still wins (before gate)", msg !== null && msg.includes("background:true"))

// kill switch
process.env.OPENCODE_ENFORCE_OFF = "1"
pass = true
try {
  await hooks["tool.execute.before"]({ tool: "shell", sessionID: "sess-x", input: {} })
} catch {
  pass = false
}
check("kill switch disables everything", pass)
delete process.env.OPENCODE_ENFORCE_OFF

// layer 4 intact
check(
  "subagent description still extended",
  transformed!.subagent.description.includes("FORBIDDEN") && transformed!.subagent.description.includes("background:true"),
)

// primer: 12 bullets, both gate lines
const sys: any[] = []
await hooks["session.context"]({ system: sys, messages: [] })
const primer = sys[0]?.text ?? ""
check(
  "primer carries both gate lines (incl. memory + orchestrator line)",
  primer.includes("read of ~/.config/opencode/MEMORY.md".replace("read of ", "a `read` of ")) &&
    primer.includes("subagent-driven-development") &&
    primer.includes("workflow-git-pr.md"),
)
check("primer bullet count = 12", (primer.match(/^- /gm) ?? []).length === 12)

console.log(failures === 0 ? "\nALL EXT3 PROBES PASS" : `\n${failures} PROBE(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
