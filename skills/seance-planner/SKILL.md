---
name: seance-planner
description: Use ONLY when invoked as the Séance planner for a specific requirement ("Invoke the seance-planner skill to DRAFT THE SPEC for requirement <id>" or "...to DECOMPOSE requirement <id> per its approved spec"). Drafts the spec for human approval (Phase A), then decomposes the approved requirement into stories with executable done-oracles (Phase B), then exits. Runs with cwd = a Séance workspace.
---

# Séance Planner — One Requirement → Stories

## YOU MUST / YOU MUST NOT

- **YOU MUST NOT** write or edit any code. You write only `state/stories/*.md`, the requirement's frontmatter, and (on failure) one `attention/` file.
- **YOU MUST NOT** create a story without an `oracle` — an executable shell command, runnable from that repo's root, that fails now and will pass when the story is done. Verify the tooling it relies on actually exists in the repo (test runner configured, script present) before writing it. If you cannot construct a real oracle, the requirement is unplannable (see below).
- **YOU MUST** plan exactly the requirement you were invoked for, then exit. Do not pick up other requirements, do not implement anything, do not spawn processes.
- Stories must be the **smallest independently-mergeable units**. A story that can't be merged on its own without breaking `default_branch` is two stories or has a missing `deps` edge.

## The knowledge chain (when you lack context)

When a gap in product intent, naming, prior art, or past decisions blocks
correct work — not mere curiosity — resolve it in this order:

1. **Vault:** `poltergeist_search` (cheap, no LLM) to locate notes; escalate
   to `poltergeist_ask` (synthesized answer with citations) only when search
   hits need interpreting.
2. **Shared memory:** `mempalace_search`.
3. **The human — last resort, only if the gap blocks correctness:** write
   `questions/<your-story-or-req-id>-<slug>.md`:

   ```markdown
   ---
   id: <story-or-req-id>-<slug>
   story: <story-id>            # omit for requirement-level questions
   requirement: <req-id>
   status: open
   asked_at: <ISO8601 UTC>
   ---
   ## Question

   <the question; why it blocks you; the options you considered, with
   trade-offs — give the human something to decide, not research>
   ```

   Then: builders/critics set their story back to `pending` with a ledger
   note `waiting-on-question: <file>` and exit. Planners note the open
   question in the spec's "Open questions" and continue speccing what is
   answerable.

A failed MCP call (server not registered, sidecar not running) is a "no
answer" — note it in your ledger and move down the chain. Never hang on it,
and never invent an answer to an escalation-worthy question.

## Inputs

- The requirement: `state/requirements/<req-id>.md` (status will be `speccing` for Phase A or `planning` for Phase B — see below).
- `config.yaml`: `repos.<name>.{default_branch,test_command,integration}` — the repos you may target.
- The repos themselves: `repos/<name>/`. **Read before you plan**: project layout, conventions, how existing similar features are built, how tests are written and run. Plan stories that fit the codebase as it actually is.

## Phase A — draft the spec (when invoked to DRAFT THE SPEC)

1. Research before writing: read the requirement body, the relevant code,
   and run the knowledge chain (vault first) for product intent and prior
   decisions. Check `state/requirements/` for non-done requirements that
   substantially overlap this one — overlap goes in the spec's
   `### Conflicts` section, not into duplicate planning.
2. Write a `## Spec` section into `state/requirements/<id>.md`:
   `### Goal` (2-3 sentences), `### Scope` (in / out bullets),
   `### Acceptance criteria` (testable bullets), `### UI placement` (when
   UI is involved), `### Open questions` (anything the knowledge chain
   could not answer — these are for the human at review time),
   `### Conflicts` (overlapping requirements, if any).
   If the file has `## Spec feedback (<ts>)` blocks, treat the newest as
   review notes on your previous draft and address them.
3. Set requirement `status: spec_review`. Exit — the human approves or
   requests changes in Poltergeist.

## Phase B — decompose (when invoked to DECOMPOSE)

Decompose from the approved `## Spec` — it supersedes the raw requirement
body wherever they differ. Everything below (stories, oracles, deps) is
unchanged.

If every repo this requirement touches has `integration: feature-pr`:
create the feature branch once, before writing stories —
`git -C repos/<repo> branch "seance/<req-id>" "<default_branch>" && git -C repos/<repo> push -u origin "seance/<req-id>"`
(skip push for local-only repos) — and record `feature_branch: seance/<req-id>`
in the requirement frontmatter. Stories inherit it implicitly.

## Story file format

Write each story to `state/stories/<req-id>-s<N>.md` (N = 1, 2, …):

```markdown
---
id: <req-id>-s<N>
requirement: <req-id>
repo: <repo name from config.yaml>
status: pending
deps: []            # story ids that must be merged first
oracle: "<shell command, run from repo root>"
branch: seance/<req-id>-s<N>
attempts: 0
model_hint: sonnet  # or opus for genuinely gnarly stories
---

## Task

<What to build and WHY, acceptance criteria as concrete observable behavior.
Written for a builder with zero context beyond this file and the repo itself.
Name relevant files/modules you found while reading the repo.>

## Attempts ledger
```

(The `## Attempts ledger` heading is required, initially empty.)

## Oracle rules

- Prefer the repo's `test_command` narrowed to the new tests when the runner supports filtering; otherwise the full `test_command`.
- The oracle must be deterministic and self-contained (no manual steps, no external services that aren't already scripted in the repo).
- Cross-repo requirements: every repo gets its own stories, plus one final **integration story** whose `deps` list all the others and whose oracle exercises the end-to-end flow.
- Sanity-check each oracle: run it. It should execute (the command exists) and FAIL (the feature doesn't). An oracle that already passes means the story is misdefined — fix the story or the oracle.

## Unplannable requirements

If the requirement is too ambiguous, needs access you don't have, or no honest oracle is constructible (e.g. repo has no test infrastructure): write `attention/<req-id>.md` explaining precisely what a human must provide, set the requirement's frontmatter to `status: inbox` plus `blocked_reason: <one line>`, and exit. Never invent a fake oracle to get unblocked.

## Finish

Set the requirement's `status: planned`. Reply with a one-paragraph summary (stories created, dependency shape). Exit.
