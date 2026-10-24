# BACKLOG.md — ext-6 wave deferrals

The ext-6 analyst report (2026-10-25, §3) proposed seven enforcement layers. Wave 1 shipped
ext-6.1 (memory-mandate keyword), ext-6.6 (memory whole-file overwrite guard), and ext-6.7
(agent-missing deny) — see `docs/RULES.md` §2 "ext 6 wave". The remaining proposals live here
with their owner-decided status. Full specs: the analyst report §ext-6.2–6.5.

| # | Layer | Priority | Status |
| :-- | :-- | :-- | :-- |
| 1 | ext-6.2 structured deny/dispatch audit log | P1 | Backlogged by owner 2026-10-25 |
| 2 | ext-6.3 continuation-chain cap (>6) | P2 | BLOCKED ON DESIGN |
| 3 | ext-6.4 identical-dispatch circuit breaker (≥4) | P2 | Awaiting owner verdict |
| 4 | ext-6.5 push-to-main segment guard | P2 | Parked |

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

## ext-6.3 — Continuation-chain cap (BLOCKED ON DESIGN)

Owner requirement: the cap (proposed: >6 continuations per child session) must be adjustable —
temporarily or permanently — WITHOUT config edits and without performance overhead. Candidate
designs to evaluate before implementation:

- env-var knob read per call (no config file; but process-env semantics need verification);
- adaptive cap derived from per-session behavior (no knob at all, self-tuning);
- controller-approved one-shot override (explicit raise path, audited).

## ext-6.4 — Identical-dispatch circuit breaker (awaiting owner verdict)

Proposed: deny when the same (agent, prompt) pair is dispatched ≥4 times in one session
(fresh dispatches only; continuations governed by ext-6.3). Grounding: post-plugin repeats
already observed at ×3 (×2 sessions) and ×4 (×1); all-time real max ×6 (an adversarial-review
panel that could legitimately re-run with differentiated briefs). The controller explains the
trade-off to the owner; implementation waits for the verdict.

## ext-6.5 — Shell hard-guards (parked 2026-10-25)

The pkill/killall-by-name ban moved out of the plugin into native `opencode.json` V2
permission rules (`pkill */killall * → deny`, owner decision 2026-10-25; the V2 scanner
splits compound commands into segments). The remaining analyst slice — the direct
push-to-main/master segment guard — stays parked with it; revisit only if the native
permission rules prove insufficient for the refspec-matching class.
