# BACKLOG.md — enforcement deferrals

The ext-6 analyst report (2026-10-25, §3) proposed seven enforcement layers. Wave 1 shipped
ext-6.1 (memory-mandate keyword), ext-6.6 (memory whole-file overwrite guard), and ext-6.7
(agent-missing deny); wave 2 shipped ext-6.4 (identical-dispatch circuit breaker,
2026-10-25); wave 3 shipped ext-6.3 (continuation-chain cap, Variant A, 2026-10-25) — see
`docs/RULES.md` §2 "ext 6 wave". The remaining proposals (6.2, 6.5) live here with their
owner-decided status. Full specs: the analyst report §ext-6.2–6.5. ext-7.1 (context7-mcp in
the mandatory set + the MCP→skill gate) shipped 2026-11-07 and left one follow-up here.

| # | Layer | Priority | Status |
| :-- | :-- | :-- | :-- |
| 1 | ext-6.2 structured deny/dispatch audit log | P1 | Backlogged by owner 2026-10-25 |
| 2 | ext-6.3 continuation-chain cap (>6) | P2 | IMPLEMENTED 2026-10-25 (Variant A, owner approved) — see src/dispatch-policy.ts |
| 3 | ext-6.4 identical-dispatch circuit breaker (≥4) | P2 | IMPLEMENTED 2026-10-25 (owner approved) — see src/dispatch-policy.ts |
| 4 | ext-6.5 push-to-main segment guard | P2 | Parked |
| 5 | Author skills for the 5 skill-less MCP servers (zai-mcp-server, cloakbrowser, stitch, ssh-any, circumvention-corpus) so the MCP→skill gate (ext 7.1) can cover them | P3 | Owner decision pending (2026-11-07) |

## ext-7.1 follow-up — skills for the skill-less MCP servers (owner decision pending 2026-11-07)

The ext-7.1 MCP→skill gate maps only `context7` and `adb_mcp`. The five other MCP servers
(zai-mcp-server, cloakbrowser, stitch, ssh-any, circumvention-corpus) have no related skill
in the system, so the gate cannot cover them — authoring those skills is a separate future
task (owner informed 2026-11-07; decision pending). mcpRequirements is config-ready for
new skills — one table row each: once a skill exists, pointing a prefix at it is a
`gates.mcpRequirements` entry in `opencode.json` (Flexibility Phase 2), no code change.

## ext-6.2 — Structured deny/dispatch audit log (P1, backlogged by owner 2026-10-25)

Spec = analyst report §ext-6.2: wrap every deny throw site in a `deny()` helper that appends
one JSONL line `{ts, sessionID, tool, rule, msg}` to the daily audit file
`~/.local/state/opencode-mandator/deny-YYYYMMDD.jsonl`, plus optional completed-dispatch
metadata (`{agent, model, background, continuation}`).
Critical safety property: ONLY the logging exception is swallowed — the original deny decision
is always enforced. Fail-open applies solely to the log write itself, an owner-approved
exception for a layer that is observability, not a gate; gate paths keep their exact ordering.
Motivation: 134 deny events in 10 days are today visible only via fuzzy LIKE forensics over a
5.9 GB database.

## ext-6.3 — Continuation-chain cap (implemented 2026-10-25)

IMPLEMENTED 2026-10-25 (Variant A, owner approved): constant cap 6 + a visible one-shot
`[chain-cap-override] <reason>` escape in the continuation prompt — no config edits, no
perf overhead; the design requirement (adjustable without config involvement) is met, and
the env-knob / adaptive-cap candidates below are superseded. Per-session counter
`Map<parentSessionID, Map<childSessionID, count>>` at module scope, increment-then-check on
every continuation that REACHES the count check — denials by earlier gates (skill, memory,
structure, memory-mandate) do NOT increment the counter, while cap denials and
override-carrying continuations do (the counter tracks reality): 6 continuations of one
child pass, the 7th denies unless the prompt matches
`/\[chain-cap-override\]\s*\S/i` (marker + non-empty reason; a bare marker does not unlock).
Normative spec: `docs/RULES.md` §2 row 10 and §3 row 9.

## ext-6.4 — Identical-dispatch circuit breaker (implemented 2026-10-25)

Proposed: deny when the same (agent, prompt) pair is dispatched ≥4 times in one session
(fresh dispatches only; continuations governed by ext-6.3). Grounding: post-plugin repeats
already observed at ×3 (×2 sessions) and ×4 (×1); all-time real max ×6 (an adversarial-review
panel that could legitimately re-run with differentiated briefs). IMPLEMENTED 2026-10-25
(owner approved): threshold 4 (increment-then-check — 3 identical executions pass), djb2
digest over agent + NUL + prompt, per-session counter at module scope, check runs LAST on
the fresh path, and the deny carries no compliance trailer and no re-run instruction
(deliberate deltas vs the sketch — the deny is final for identical resends). Normative
spec: `docs/RULES.md` §2 row 9 and §3 row 8.

## ext-6.5 — Shell hard-guards (parked 2026-10-25)

The pkill/killall-by-name ban moved out of the plugin into native `opencode.json` V2
permission rules (`pkill */killall * → deny`, owner decision 2026-10-25; the V2 scanner
splits compound commands into segments). The remaining analyst slice — the direct
push-to-main/master segment guard — stays parked with it; revisit only if the native
permission rules prove insufficient for the refspec-matching class.
