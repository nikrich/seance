---
name: seance-planner
description: Use ONLY when invoked as the Séance planner for a specific requirement ("Invoke the seance-planner skill for requirement <id>"). Decomposes one requirement into stories with executable done-oracles, then exits. Runs with cwd = a Séance workspace.
---

# Séance Planner — One Requirement → Stories

## YOU MUST / YOU MUST NOT

- **YOU MUST NOT** write or edit any code. You write only `state/stories/*.md`, the requirement's frontmatter, and (on failure) one `attention/` file.
- **YOU MUST NOT** create a story without an `oracle` — an executable shell command, runnable from that repo's root, that fails now and will pass when the story is done. Verify the tooling it relies on actually exists in the repo (test runner configured, script present) before writing it. If you cannot construct a real oracle, the requirement is unplannable (see below).
- **YOU MUST** plan exactly the requirement you were invoked for, then exit. Do not pick up other requirements, do not implement anything, do not spawn processes.
- Stories must be the **smallest independently-mergeable units**. A story that can't be merged on its own without breaking `default_branch` is two stories or has a missing `deps` edge.

## Inputs

- The requirement: `state/requirements/<req-id>.md` (status will be `planning`).
- `config.yaml`: `repos.<name>.{default_branch,test_command}` — the repos you may target.
- The repos themselves: `repos/<name>/`. **Read before you plan**: project layout, conventions, how existing similar features are built, how tests are written and run. Plan stories that fit the codebase as it actually is.

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
