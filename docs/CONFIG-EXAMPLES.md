# CONFIG-EXAMPLES.md — dispatch-policy configuration examples

Worked `options` examples for the **object form** of the `plugins` array entry in the
global `~/.config/opencode/opencode.json(c)` (the only configurable loading mode —
file-discovered plugins carry no options; see [`RULES.md` §6](RULES.md) for the
normative spec: option table, guard on/off conditions, failure semantics, loading
modes, restart rule).

**Opt-in enforcement (owner decision 2026-11-07):** with NO `options` — or with every
option empty — the plugin is completely INERT (no gates, no denies, no primer, no
description hint, no config problems). Enforcement exists only via explicit
configuration. Applying any option change = `opencode service restart` (reload does
not replace the ES module). The `messages.*` templates substitute `{var}` placeholders
1:1 with what the deny builders interpolate; an unknown `{var}` or an empty template
(empty renders the hardcoded generic deny line) is handled per [`RULES.md` §6.3](RULES.md).

## 1. The mandator setup (the owner's full enforcement config)

This is THE canonical setup — the owner's enforcement policy as explicit options. The
verbatim, machine-readable copy lives in
[`tests/fixtures/mandator-setup.json`](../tests/fixtures/mandator-setup.json) (the
single source to paste into `opencode.json`; the JSON snippet below shows the same
content with the long strings elided for readability). It re-creates the full
pre-flip enforcement: the 4-skill + 3-orchestrator-skill gate with memory-read
prerequisites, the nine gated tools, the exa substring rule, the MCP→skill prefix
table, the five-block structure gate (fresh + Stitch), the memory-mandate keyword,
both circuit breakers with the `[chain-cap-override]` escape, the memory-overwrite
guard, the full deny-wording set with the COMPLIANCE WARNING trailer, and the
13-bullet PRIMER injection.

```jsonc
// ~/.config/opencode/opencode.jsonc — canonical copy: tests/fixtures/mandator-setup.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/.local/share/opencode-mandator/plugin-package",
      "options": {
        "dispatch": {
          "tools": ["subagent"],
          "forbiddenAgents": ["general"],
          "requireBackground": true,
          "requireAgent": true
        },
        "skills": {
          "mandatory": ["brainstorming", "grilling", "build-with-exa", "context7-mcp"],
          "orchestrator": ["subagent-driven-development", "dispatching-parallel-agents", "prompt-engineering-patterns"]
        },
        "gates": {
          "tools": ["edit", "write", "shell", "bash", "apply_patch", "subagent", "webfetch", "websearch", "execute"],
          "exaSubstring": "exa",
          "mcpRequirements": [
            { "prefix": "context7", "skill": "context7-mcp" },
            { "prefix": "adb_mcp",  "skill": "adb-mcp" }
          ],
          "readTargets": [
            { "key": "memory", "suffix": ".config/opencode/MEMORY.md" },
            { "key": "workflow", "suffix": ".config/opencode/memory/topics/workflow.md" },
            { "key": "workflow-git-pr", "suffix": ".config/opencode/memory/topics/workflow-git-pr.md" }
          ],
          "memoryMandatePattern": "(MEMORY\\.md|memory/(topics|projects)|глобальн\\p{L}*\\s+пам(ять|яти)|global memory)"
        },
        "structure": {
          "blocks": { "…five {name, pattern} blocks (Role/Task/Context/Constraints/Output format) — verbatim in the fixture…" : "…" },
          "subagentProfile": ["role", "task", "context", "constraints", "output"],
          "stitchProfile": ["task", "context", "constraints", "output"],
          "stitchPromptTools": ["stitch_generate_screen_from_text", "stitch_edit_screens", "stitch_generate_variants"],
          "stitchMinPrompt": 120
        },
        "caps": { "identicalMax": 4, "chainMax": 6, "chainOverrideMarker": "[chain-cap-override]" },
        "paths": {
          "memoryIndex": "~/.config/opencode/MEMORY.md",
          "memoryTree": "~/.config/opencode/memory"
        },
        "messages": { "…13 deny/description templates incl. the COMPLIANCE WARNING trailer — verbatim in the fixture…" : "…" },
        "primer": { "mode": "default", "text": "…the 13-bullet PRIMER v2 — verbatim in the fixture…" }
      }
    }
  ]
}
```

Notes:

- Do NOT hand-transcribe the elided strings — copy the canonical fixture file's
  `messages`, `structure.blocks`, and `primer.text` values verbatim (they are
  behavior-tested: `tests/setup-parity.test.ts` proves the fixture resolves to
  exactly these enforcement semantics and renders these exact deny texts).
- `primer.mode: "default"` + a configured `primer.text` is effective post-flip: the
  default mode injects the configured text (there is no shipped primer anymore).
- Every unspecified key would stay at its built-in default — which is OFF; that is
  why the canonical setup spells out all 36 values.
- Invalid entries degrade per [`RULES.md` §6.3](RULES.md): enforcement options fail
  that guard closed with a CONFIG-ERROR where the guard is reachable; every problem
  (enforcement pools included) surfaces via the config-problems system part.

## 2. Minimal override (the mandator setup, two tweaks)

**What changes:** only two knobs — a tighter identical-dispatch breaker and a custom
chain-cap escape marker; everything else stays at the canonical setup's values (paste
the fixture and apply this delta; unspecified keys would be OFF, not canonical).

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/.local/share/opencode-mandator/plugin-package",
      "options": {
        // … the canonical setup (fixture) with these overrides:
        "caps": {
          "identicalMax": 3,                   // 2 identical executions pass, the 3rd denies
          "chainOverrideMarker": "[go-ahead]"  // bare marker still does not unlock — reason required
        }
      }
    }
  ]
}
```

## 3. Primer append (canonical rules + install addendum)

**What changes:** the injected system text becomes the configured primer followed by
an install-specific addendum (`"append"` mode concatenates with a blank line on top of
the BUILT-IN default — which is empty, so post-flip append resolves to just the given
text; to append onto the canonical PRIMER, set the fixture text as `primer.text` with
`"append"`).

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/.local/share/opencode-mandator/plugin-package",
      "options": {
        // … the canonical setup (fixture) with this primer override:
        "primer": {
          "mode": "append",
          "text": "- Extra house rule for this install: deploy actions require an explicit owner word in the task brief."
        }
      }
    }
  ]
}
```

The same shape covers `mode: "default"` (inject exactly the configured `primer.text`)
and `mode: "replace"` (identical outcome, explicit form).
