# BRIEFS.md — the dispatch-brief specification

Normative dispatch-brief specification. The PRIMER (src/dispatch-policy.ts) mandates it; the plugin enforces the checkable subset.

Normative ("must"). Scope: every `subagent` dispatch prompt the orchestrator writes.
The plugin (dispatch-policy) enforces the checkable subset: five labeled blocks + the
memory mandate. This spec defines the quality layer the keywords cannot check.

## 1. Contract overview

A **brief** is the complete task message an orchestrator sends to a subagent, which
reads it cold — its own context window, zero session context [S3][S4]. Exact values
live in the brief or its brief file, nowhere else. Dispatch mechanics are fixed
policy (PRIMER v2): `background: true`
always, a specialized agent type (`general` forbidden), fresh session per new task.
Violations: the plugin denies a brief missing a block or the memory mandate, naming
what is missing — comply and re-run; the controller audits and rejects unverifiable
reports (run `git status` / `git log` personally); the subagent escalates
`NEEDS_CONTEXT` or `BLOCKED` (named blocker) instead of guessing.

## 2. Per-block specification

The five block names are fixed (deny messages name them); header or inline labels
both pass. Every block is written for a cold reader — Anthropic's test: "If they'd
be confused, Claude will be too" [S2].

**Role** — the competence frame [S2].
Must: specialist identity + single duty, one sentence, consistent with the agent
type. Anti-patterns: generic persona ("helpful assistant"); duties the Task does
not fund. Example: "You are a Go implementer for hhauto; one scoped fix with tests."

**Task** — the objective [S1].
Must: ONE core objective per brief [S6]; every exact value verbatim; a
done-criterion — observable state proving completion. If "research X" fully
describes it, sharpen or split [S1]. Anti-patterns: two objectives; "improve"
without a measure; "as discussed" history references. Example: "Add MaxRetries = 3
to retryOnStatus in internal/hh/client.go; after the 3rd 401 return ErrAuthFailed.
Done = go test ./internal/hh/ green."

**Context** — what the subagent cannot know.
Must: one line of project fit; paths to read (memory files, brief file);
interfaces/decisions from earlier tasks; ambiguity resolutions. Hand off bulk
material as paths, never pastes — lightweight references minimize the
"game of telephone" [S1]. Anti-patterns: pasted prior-task summaries; "you'll find
it". Example: "Contract map: ~/.config/opencode/memory/projects/hhauto.md — read
before editing; retryOnStatus came from PR #44 (a1b2c3d) uncapped."

**Constraints** — boundaries + failure protocol.
Must: exact file/tool scope ("Touch ONLY …"); the three mandates (§3); blocking-run
rule (long commands blocking, in the same turn); scratch/report paths; memory-write
ban (facts go to the controller); escalation protocol NEEDS_CONTEXT / BLOCKED —
never silent loops [S5]. Every constraint verifiable from the diff or report.
Anti-patterns: no scope line (scope creep, same-output-path collisions); vague
caution. Example: "Touch ONLY internal/hh/client.go and client_test.go. Run tests
blocking. Do not dispatch subagents."

**Output format** — the deliverable contract.
Must: report file path (`task-N-brief.md` → `task-N-report.md`); status vocabulary;
evidence rule — raw command output, `git log --oneline`, `git status --short`,
changed paths; **a claim is not evidence**; short final message.
Anti-patterns: "report back" with no shape; prose "everything works".
Example: "Write /tmp/hhauto-scratch-T80/report-T80.md: commands + raw output, git
log, git status, files changed. Final message: status + report path + test result."

## 3. Cross-block mandates

All three, near the top of Constraints:

- **Memory mandate (verbatim):** "Read global memory: ~/.config/opencode/MEMORY.md +
  memory/topics/* + memory/projects/* — all files, complete — and list what you
  read in your report." Satisfies ext-6.1 on first attempt.
- **Skill mandate (verbatim):** "Skills: invoke brainstorming + build-with-exa +
  grilling + ≥2 more relevant to this task; list them in the report."
- **Report contract:** report path, statuses `DONE / DONE_WITH_CONCERNS /
  NEEDS_CONTEXT / BLOCKED`, evidence rule (Output block). Adapt statuses per genre
  (a reviewer returns a verdict).

Implementer briefs add the **no-subagent clause** ("Do not dispatch subagents —
review arrives from the controller") and the **scratch rule** (`/tmp/<project>-wtNN`,
`/tmp/<project>-scratch-*`; nothing in `~`; the controller writes memory). If the
owner assigned a model/agent, carry it verbatim — never self-select.

## 4. Anti-pattern catalog

| Incident class | Real shape | Preventing rule |
| :-- | :-- | :-- |
| Pasted-history brief | 42k-char dispatch, 99% prior summaries | Context: paths + one line of fit, never prior-task text |
| Fabricated success | "green" with no commit; invented hash | Report contract: raw output, real SHAs, git status; controller re-verifies |
| Same-output-paths parallel | Two assemblers, last-writer-wins | Constraints: exact allowed paths; one agent per output path |
| Vague brief | "research the semiconductor shortage" [S1] | Task: one objective + exact values + done-criterion |
| Missing tool/source guidance | Web search for data that lives in a repo [S1] | Context/Task name the tools, files, sources |
| Escalation framing absent | Implementer loops without capability bump | Constraints define NEEDS_CONTEXT / BLOCKED; controller owns the bump |

## 5. Checklist — run before sending

1. Five blocks present, labeled Role / Task / Context / Constraints / Output format.
2. Task: one objective, exact values verbatim, a done-criterion.
3. Cold-reader test passes [S2].
4. Context: paths + one line of fit + ambiguity resolutions; no pasted history.
5. Constraints name exact allowed paths; no other agent shares those output paths.
6. Memory mandate verbatim (satisfies the 6.1 keyword check).
7. Skill mandate verbatim.
8. Report contract: report path + statuses + evidence rule.
9. Escalation protocol stated (NEEDS_CONTEXT / BLOCKED).
10. Scratch/report paths under /tmp or the task worktree, never `~`.
11. `background: true`, specialized agent type, fresh session for a new task.
12. Owner-assigned model/agent carried verbatim; nothing self-selected.
13. Exact values exist only in the brief (or its file).
14. Brief ≈ one page; bulk material handed off as paths.
15. Referenced paths and files exist — checked, not assumed.


### 6. Two worked examples (excluded from the word cap)

**GOOD — minimal implementer brief:**

```markdown
Role: You are a Go implementer for the hhauto repo; one scoped fix with tests,
nothing else.

Task: In internal/hh/client.go, 401 responses retry forever: retryOnStatus has no
cap. Add MaxRetries = 3; after the third 401 return ErrAuthFailed. Update the three
retry tests in client_test.go; add one cap test asserting ErrAuthFailed after 3
attempts. Done = go test ./internal/hh/ green.

Context: HH contract map (upsert-by-id, XSRF): 
~/.config/opencode/memory/projects/hhauto.md — read before editing. retryOnStatus
came from PR #44 (a1b2c3d) without a cap. Worktree /tmp/hhauto-wtT80 (branch
fix/401-retry-cap) is ready; other worktrees are not yours.

Constraints: Touch ONLY internal/hh/client.go and internal/hh/client_test.go. Run
tests blocking — no background processes. Do not dispatch subagents; do not write
memory files — send facts to the controller. Scratch in /tmp/hhauto-scratch-T80.
Read global memory: ~/.config/opencode/MEMORY.md + memory/topics/* +
memory/projects/* — list what you read. Skills: brainstorming + build-with-exa +
grilling + ≥2 relevant — list them. Missing input → NEEDS_CONTEXT; genuinely stuck
→ BLOCKED with the named blocker.

Output format: Write /tmp/hhauto-scratch-T80/report-T80.md: commands + raw output,
git log --oneline, git status --short, files changed. Final message: DONE /
DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED + report path + one-line test result
+ concerns.
```

**BAD — annotated:**

```markdown
Fix the retry bug in the client the way we discussed in T70, and while you're in
there also clean up the config parsing, it's messy. Make sure everything is green
and commit when done. Just report back.

[Paste of Tasks 68–73 outputs, ~9,000 chars of prior session history]
```

- No Role, Context, or Constraints blocks → plugin structure deny (missing: Role;
  Context; Constraints).
- Task: "the way we discussed" — cold reader has no referent; two objectives ("fix" +
  "clean up") → vague-brief and one-objective violations.
- Context = pasted history → the 42k-char incident class; violates context isolation.
- Even with the blocks present, content fails: no file scope (same-output-path
  risk), no memory mandate (separate plugin deny), no skill mandate, no blocking
  rule, no escalation protocol; "make sure everything is green" is a
  fabricated-success invitation.
- Output format: "report back" matches the plugin's keyword regex (`reports?\b`) yet
  carries no path, no statuses, no evidence rule — **keywords are a floor, not the
  bar**; the COMPLIANCE WARNING covers what the regex cannot.
- Commit instruction without branch/worktree context → workflow drift.

### 7. Enforceability split (excluded from the word cap)

| Rule | Class | Gate form |
| :-- | :-- | :-- |
| Five labeled blocks | Already enforced | ext-5 `BLOCKS` regexes (`docs/RULES.md` §2) |
| Memory mandate wording | Already enforced | ext-6.1 `MEMORY_MANDATE_RE` |
| Report-contract path in brief | Keyword-checkable candidate | single regex: `/report[^\n]{0,120}\.md/i` — low FP; a brief naming an `.md` report path is carrying the contract |
| Escalation statuses named | Keyword-checkable candidate | `/NEEDS_CONTEXT\|\bBLOCKED/i` |
| Skill mandate carried | Keyword-checkable candidate | `/brainstorming/i` — already on the owner's ext-7 shortlist (7.1) |
| No-subagent clause (implementer briefs) | Keyword-checkable candidate, FP risk | `/dispatch subagent/i` — needs scoping to implementer genre or it hits coordinator briefs |
| Evidence-required phrasing | Keyword-checkable candidate, weak | `/raw (command )?output\|command output/i` — presence of words ≠ semantics; floor only |
| One objective per Task | Judgment-level | no reliable single regex |
| Cold-reader clarity; no pasted history | Judgment-level | length heuristics exist but are FP-prone; discipline + audit |
| Exact file-scope correctness | Judgment-level | controller verifies against the diff |
| Evidence is real (SHAs exist; tests ran) | Judgment-level | controller runs `git status` / `git log` after every subagent — a keyword can never verify truth |
| Ambiguity resolutions present | Judgment-level | controller self-check |

Promotion rule for candidates: measure violation and false-positive rates against
stored briefs in the session DB first (the ext-6 grounding method — 6.1 measured at
8.5% violations pre-enforcement), then owner decision.
