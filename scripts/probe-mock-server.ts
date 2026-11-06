// scripts/probe-mock-server.ts — local OpenAI-compatible mock provider for
// scripts/probe-options.sh (Flexibility Phase 1 live probe). Zero network beyond
// 127.0.0.1: the standalone opencode process under the fixture HOME calls THIS server
// as its provider, so the probe is deterministic (no geo/queue/quota dependencies).
//
// Protocol (chat completions, SSE streaming — the @opencode/ai/providers/
// openai-compatible adapter streams and requires finish_reason in the final chunk):
//   GET  /v1/models            → one model "probe-model"
//   POST /v1/chat/completions  → 1st call: tool_call shell "echo probe-options-ok"
//                                any later call: assistant text quoting the last tool
//                                message verbatim — that message carries the plugin's
//                                CONFIG-ERROR deny when the option reached the plugin,
//                                which is exactly what the probe asserts on.
// Every request line is logged to the file given in MOCK_LOG (debugging aid).
const logFile = process.env.MOCK_LOG ?? ""

const sse = (chunks: Array<Record<string, unknown>>): Response => {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })
  return new Response(stream, { headers: { "content-type": "text/event-stream" } })
}

const chunk = (delta: Record<string, unknown>, finishReason: string | null) => ({
  id: "probe",
  object: "chat.completion.chunk",
  model: "probe-model",
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

const server = Bun.serve({
  port: Number(process.env.MOCK_PORT ?? 0), // 0 = ephemeral; actual port printed below
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url)
    if (logFile) {
      try {
        await Bun.write(
          Bun.file(logFile),
          `${new Date().toISOString()} ${req.method} ${url.pathname}\n`,
          { append: true },
        )
      } catch {}
    }
    if (url.pathname.endsWith("/models")) {
      return Response.json({
        object: "list",
        data: [{ id: "probe-model", object: "model", owned_by: "probe-mock" }],
      })
    }
    if (url.pathname.endsWith("/chat/completions")) {
      let messages: Array<Record<string, unknown>> = []
      try {
        const body = (await req.json()) as { messages?: Array<Record<string, unknown>> }
        messages = body.messages ?? []
      } catch {}
      const toolMsg = [...messages].reverse().find((m) => m.role === "tool")
      if (toolMsg !== undefined) {
        // Second round: quote the tool result verbatim (it carries the plugin deny).
        const content = typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content)
        return sse([chunk({ role: "assistant", content: `TOOL RESULT: ${content}` }, null), chunk({}, "stop")])
      }
      // First round: call the shell tool.
      return sse([
        chunk(
          {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_probe_1",
                type: "function",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({ command: "echo probe-options-ok" }),
                },
              },
            ],
          },
          null,
        ),
        chunk({}, "tool_calls"),
      ])
    }
    return new Response(JSON.stringify({ error: { message: `probe-mock: unhandled ${req.method} ${url.pathname}` } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  },
})

// The parent script reads the ACTUAL bound port from this line on stdout.
console.log(`PROBE_MOCK_PORT=${server.port}`)
