# CONFIG-EXAMPLES.md — dispatch-policy configuration examples

Worked `options` examples for the **object form** of the `plugins` array entry in the
global `~/.config/opencode/opencode.json(c)` (the only configurable loading mode —
file-discovered plugins carry no options; see [`RULES.md` §6](RULES.md) for the
normative spec: option table, failure semantics, loading modes, restart rule).

Applying any option change = `opencode service restart` (reload does not replace the
ES module). With NO `options` the plugin behaves byte-identically to the pre-migration
hardcodes. The `messages.*` templates substitute `{var}` placeholders 1:1 with what the
deny builders interpolate; an unknown `{var}` falls back to the default template with a
recorded problem (presentation semantics — wording problems never brick enforcement).

## 1. Complete alternative setup (a different owner's install)

**What changes:** everything that is install-specific — no superpowers skills on disk,
no exa/adb/context7 MCP servers, no Stitch, Cyrillic-free patterns and deny wording,
looser caps, an own primer loaded from a file; the enforcement core (background, agent
ban, memory-overwrite guard, both caps with the override marker) stays intact.

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/home/alina/.local/share/opencode-mandator/plugin-package",
      "options": {
        "dispatch": {
          "tools": ["subagent"],
          "forbiddenAgents": ["general"],     // kept — universal hygiene
          "requireBackground": true,          // kept
          "requireAgent": true                // kept
        },
        "skills": {
          "mandatory": [],                    // no skills in this install → base gate inert for skills (warned)
          "orchestrator": []                  // dispatch preflight inert (warned)
        },
        "gates": {
          "tools": ["edit", "write", "shell", "subagent", "webfetch"],
          "exaSubstring": null,               // no exa MCP here
          "mcpRequirements": [],              // no MCP servers with skills
          "readTargets": [
            { "key": "memory", "suffix": ".config/opencode/MEMORY.md" }
          ],
          "memoryMandatePattern": "MEMORY\\.md|memory/(topics|projects)|global memory"
        },
        "structure": {
          "stitchPromptTools": [],            // no Stitch → that surface is off
          "subagentProfile": ["role", "task", "context", "constraints", "output"],
          "blocks": {
            "role":        { "name": "Role",        "pattern": "(you are|your role|role\\s*:|acting as)" },
            "task":        { "name": "Task",        "pattern": "(tasks?\\b|objectives?\\b|goals?\\b|mission\\b)" },
            "context":     { "name": "Context",     "pattern": "(contexts?\\b|background\\b)" },
            "constraints": { "name": "Constraints","pattern": "(constraints?\\b|requirements?\\b|\\bmust\\b|do not|never|forbidden)" },
            "output":      { "name": "Output format","pattern": "(output format|deliverable|reports?\\b|formats?\\b)" }
          }
        },
        "caps": { "identicalMax": 8, "chainMax": 12, "chainOverrideMarker": "[override]" },
        "paths": {
          "memoryIndex": "~/.config/opencode/MEMORY.md",
          "memoryTree": "~/.config/opencode/memory"
        },
        "primer": {
          "mode": "replace",
          "text": "{file:~/.config/opencode/primer.txt}"
        },
        "messages": {
          "complianceWarning": " COMPLIANCE NOTICE: deviations from the loaded operating rules are audited and rejected.",
          "generalBan": "DENIED: agent type \"{agent}\" is not allowed here. Pick a specialized agent type (see: opencode debug agents).",
          "gateMissing": "Required first in this session: {missing}. Load skills with `skill`; read memory with `read`. Then re-run this exact call."
        }
      }
    }
  ]
}
```

Notes:

- `primer.text` uses OpenCode's native `{file:…}` variable substitution — the primer
  stays a readable, diffable text file instead of a JSON string.
- Every unspecified key keeps its default (both styles shown on purpose: `dispatch`
  spells out kept defaults, `paths` just repeats them).
- Invalid entries degrade per [`RULES.md` §6.3](RULES.md): enforcement options fail
  that guard closed with a CONFIG-ERROR naming the path; presentation entries
  (`messages`/`primer`) fall back to the defaults with a recorded problem surfaced
  after the PRIMER part.

## 2. Minimal override (this owner's defaults, two tweaks)

**What changes:** only two knobs — a tighter identical-dispatch breaker and a custom
chain-cap escape marker; everything else stays at the built-in defaults.

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/.local/share/opencode-mandator/plugin-package",
      "options": {
        "caps": {
          "identicalMax": 3,                   // 2 identical executions pass, the 3rd denies
          "chainOverrideMarker": "[go-ahead]"  // bare marker still does not unlock — reason required
        }
      }
    }
  ]
}
```

## 3. Primer append (default rules + install addendum)

**What changes:** the injected system text becomes the default 13-bullet PRIMER followed
by an install-specific addendum (`"append"` mode concatenates with a blank line);
enforcement options are untouched.

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "~/.local/share/opencode-mandator/plugin-package",
      "options": {
        "primer": {
          "mode": "append",
          "text": "- Extra house rule for this install: deploy actions require an explicit owner word in the task brief."
        }
      }
    }
  ]
}
```

The same shape covers `mode: "default"` (explicitly pin the 13-bullet PRIMER verbatim,
ignoring any `primer.text`) and `mode: "replace"` (inject exactly `primer.text` —
`replace` is also the effective default mode, so setting `primer.text` alone replaces
the primer).
