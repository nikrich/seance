# Séance: autonomous feature flow — spec gate, knowledge chain, feature-branch integration

**Date:** 2026-07-09
**Status:** approved (design agreed in session; spec-gate flow added per user)

## Problem

Running séance on a real feature today is confusing and stall-prone:

- Every story ends as a PR to main that only the human can merge → PR pileups
  (8 PRs for one feature) and a pipeline that quietly waits on the human
  without saying so.
- Agents with a context gap (product intent, naming, prior decisions) either
  guess or block to `attention/` — they have no way to look anything up, and
  no way to ask.
- Ambiguity is resolved *after* building (via PR review), the most expensive
  possible time. Duplicate/vague requirements get built verbatim.

## Goal

A requirement runs like this, with exactly two human touchpoints:

1. Human summons a requirement (terse is fine — the spec gate absorbs
   ambiguity).
2. **Spec gate:** the planner researches (vault → mempalace), drafts a spec,
   and the plugin surfaces it for **approve / adjust**.
3. On approval the fleet builds autonomously: stories branch off and merge
   into a per-requirement feature branch; agents self-answer context
   questions via the knowledge chain, escalating to the human only as a
   last resort (inline answer in the plugin, no restart).
4. **Merge gate:** one PR from the feature branch to main.

## Design

### 1. Knowledge chain (vault → mempalace → human)

- Workspace scaffolding (`workspace.cjs` in the plugin) additionally writes
  `.mcp.json` into new workspaces, registering the existing `ghostbrain-mcp`
  stdio server (project scope — every `claude -p` agent in the workspace gets
  `poltergeist_ask` / `poltergeist_search`). `mempalace` is already
  user-scoped; nothing to do. Existing workspaces: the plugin's config
  editor's save writes `.mcp.json` if missing.
- New shared skill section (identical text in seance-planner, seance-builder,
  seance-critic; referenced by seance-concierge): when a context gap blocks
  correct work — product intent, naming, prior art, past decisions —
   1. `poltergeist_search` (cheap) then `poltergeist_ask` (LLM, citations);
  2. `mempalace_search`;
  3. only if still unanswered AND the gap blocks correctness: write
     `questions/<story-id>-<slug>.md` (see §2), set your story `pending`
     with a ledger note `waiting-on-question: <file>`, exit.
  A failed MCP call (sidecar not running, server missing) = "not found";
  move down the chain, never hang, and note the failure in the ledger.

### 2. Question lifecycle

- File contract, new dir `questions/`:

  ```markdown
  ---
  id: <story-id>-<slug>
  story: <story-id>          # or requirement: <req-id> for planner questions
  requirement: <req-id>
  status: open | answered
  asked_at: <ISO8601>
  ---
  ## Question
  <what, and why it blocks the story; options considered with trade-offs>
  ## Answer
  <written by the human via the plugin; empty while open>
  ```

- Manager tick additions:
  - A story referenced by an `open` question is ineligible to spawn.
  - An `answered` question: append `### Question answered (<ts>)` with the
    full Q&A to the story file's ledger, reset the story's `attempts` to 0
    and status to `pending`, move the file to `questions/answered/`.
- Plugin: `question:answer (wsPath, file, text)` IPC — validates the file
  name (same traversal rule as attention dismiss), writes the `## Answer`
  body + `status: answered`, wakes the heartbeat.

### 3. Spec gate (requirement flow v2)

- Requirement status gains two states:
  `inbox → speccing → spec_review → planning → planned → done`.
- **Planner phase A (spec):** when the manager drains a requirement from
  inbox it sets `speccing` and spawns the planner with a "draft the spec"
  prompt. The planner researches the codebase + knowledge chain (§1), checks
  for overlap with existing non-done requirements (overlap → say so in the
  spec's "Conflicts" section rather than planning a duplicate), and writes a
  `## Spec` section into the requirement file: goal, scope in/out, acceptance
  criteria, UI placement, open questions. Sets `spec_review`, exits.
- **Human gate:** the plugin shows spec-review cards (see §5). Approve →
  status `planning` (+ `spec_approved_at`). Adjust → the human edits the
  spec text directly in the plugin (written back verbatim) and/or leaves
  feedback; feedback sets status `speccing` again with the feedback appended
  under `## Spec feedback` for the next planner pass.
- **Planner phase B (decompose):** for a `planning` requirement with an
  approved spec, decompose into stories exactly as today, but *from the
  spec*, not the raw requirement body.
- Requirements already `planned`/`done` (pre-existing workspaces) are
  untouched — the manager only routes `inbox` requirements through the gate.

### 4. Feature-branch integration (`integration: feature-pr`)

New per-repo mode alongside `merge` and `pr`:

- Planner phase B creates `seance/<req-id>` off `default_branch` (records it
  in the requirement frontmatter as `feature_branch`).
- Builders base story worktrees on the feature branch (not `default_branch`).
  Step 1b (pr_open dep merging) applies only to cross-requirement deps;
  same-requirement deps are already in the feature branch once merged.
- Critic on APPROVE merges the story branch `--no-ff` into the feature
  branch and pushes it; story status `merged` (meaning: merged to feature).
  Oracle + full suite run against the feature branch → continuous
  integration inside the feature.
- When every story of the requirement is `merged`, the critic that lands the
  last story opens ONE PR `seance/<req-id>` → `default_branch`
  (`gh pr create`), records the URL in the requirement frontmatter
  (`feature_pr`), requirement status `done` (human merges the PR).
- Conflicts merging a story into the feature branch = REJECT with a rebase
  report, exactly like today's `default_branch` conflict rule.

### 5. Plugin: "waiting on you" strip + spec review

- `readWorkspaceStatus` additions: `questions` (open question files, parsed
  frontmatter + body) and requirements now include `status`, `spec` (the
  `## Spec` section text when present), and `feature_pr`.
- Board gets a **waiting-on-you strip** (neutral tone, above the inbox
  strip) with three card types:
  - **Spec review:** requirement title + rendered spec text in an editable
    textarea; buttons *approve* (`spec:approve`) and *request changes*
    (`spec:revise`, with a feedback field). Edited text is saved back on
    either action.
  - **Question:** the question body + inline answer input →
    `question:answer`.
  - **Feature PR ready:** link to `feature_pr` for requirements awaiting the
    main merge.
- All three actions wake the heartbeat (existing `wakeHeartbeat`).
- New IPC: `spec:approve (ws, reqId, specText)`,
  `spec:revise (ws, reqId, specText, feedback)`, `question:answer` (§2).
  Req-id validation: same pattern as `summon`.

### 6. Error handling & edge cases

- Sidecar down → `poltergeist_*` tools error → treated as no-answer (§1).
- `.mcp.json` already exists in a workspace → scaffold/save leaves it alone
  (never overwrite a hand-edited one).
- A question answered while its story is mid-build (race): manager only
  requeues stories in `pending`; a `building` story finishes its attempt
  first — the answer lands in the ledger for its next attempt if rejected.
- `integration: pr` and `merge` keep working exactly as today; `feature-pr`
  is opt-in per repo in config.yaml (and offered in the plugin's config-tab
  integration control).
- Spec gate applies per requirement, not per repo — a workspace mixing modes
  still specs every inbox requirement.

### 7. Testing

- Plugin (node --test): question file parse/answer/validation;
  `readWorkspaceStatus` questions + spec fields; `.mcp.json` scaffolding
  (present, valid JSON, not overwritten); IPC-adjacent logic in lib modules
  as usual. Harness screenshots: waiting-on-you strip with a spec card,
  a question card, and a feature-PR card.
- Skills are prose: validated by a live workspace dry-run (summon a toy
  requirement in the sandbox workspace, watch it spec → approve → build on
  a feature branch → single PR).

## Out of scope

- Automatic dedup/merge of overlapping requirements (the spec's "Conflicts"
  section surfaces overlap; the human decides at the spec gate).
- Poltergeist-side changes: `ghostbrain-mcp` is used as-is.
- Answering questions from chat/concierge (the strip is the answer surface;
  chat can still *read* everything).

## Rollout

1. Plugin 0.4.0: scaffolding (.mcp.json), status/IPC additions, waiting-on-
   you strip.
2. Séance skills: knowledge-chain section, question lifecycle (manager),
   spec gate (manager + planner), feature-pr mode (planner/builder/critic).
3. Template config.yaml documents `integration: feature-pr` as recommended.
4. Dry-run in the sandbox workspace before flipping the poltergeist
   workspace's repo to `feature-pr`.
