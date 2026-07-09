---
name: seance-builder
description: Use ONLY when invoked as the Séance builder for a specific story ("Invoke the seance-builder skill for story <id>"). Implements one story TDD-style in its git worktree, hands off to verification, then exits. Runs with cwd = a Séance workspace.
---

# Séance Builder — One Story, One Worktree

## YOU MUST / YOU MUST NOT

- **YOU MUST read the story's `## Attempts ledger` FIRST** and never retry an approach a previous attempt ruled out. The ledger is your memory across attempts; ignoring it is the one unforgivable failure.
- **YOU MUST** work ONLY inside `worktrees/<story-id>/`. Never edit files in `repos/<name>/` directly, never touch other worktrees, never touch workspace state except the story file's frontmatter + ledger as specified below.
- **YOU MUST** do TDD: write the failing test, see it fail, implement, see it pass.
- **YOU MUST** run the story's `oracle` AND the repo's full `test_command` inside your worktree and see both pass before handing off. Never hand off red.
- **YOU MUST NOT** merge, force-push, use `--no-verify`, amend published commits, weaken or delete existing tests, or widen the story's scope. If the oracle cannot pass for a reason outside this story's scope (broken main, missing dep story), record it in the ledger, set status back to `pending`, and exit — do not fix the world.
- **YOU MUST** exit after handoff. No waiting, no polling, no starting other stories.

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

- The story: `state/stories/<story-id>.md` — your entire brief. `repo`, `branch`, `oracle`, `## Task`, `## Attempts ledger`.
- The story's requirement: `state/requirements/<requirement>.md` — check for `feature_branch` (feature-pr mode; see step 1).
- Dependency stories: `state/stories/<dep-id>.md` for every id in your story's `deps` — you need each one's `status` and `branch` (see step 1b).
- `config.yaml`: `repos.<repo>.{default_branch,test_command}`.
- Timestamps: always from `date -u +%Y-%m-%dT%H:%M:%SZ`, never from memory.

## Procedure

### 1. Set up the worktree (idempotent — retries reuse it)

If your story's requirement has `feature_branch` in its frontmatter
(feature-pr mode), use that branch as the base instead of
`<default_branch>` — everywhere `<default_branch>` appears in this step and
in retry rebases. Same-requirement deps that are `merged` are already in the
feature branch; step 1b (merging pr_open dep branches) then applies only to
cross-requirement deps.

```bash
if [ ! -d "worktrees/<story-id>" ]; then
  git -C "repos/<repo>" worktree add "../../worktrees/<story-id>" -b "<branch>" "<default_branch>" \
    || git -C "repos/<repo>" worktree add "../../worktrees/<story-id>" "<branch>"
fi
cd "worktrees/<story-id>"
```

On a retry attempt, rebase your branch on the latest `default_branch` first (`git fetch` if the repo has a remote; local repos: `git rebase <default_branch>`). If the rebase conflicts, resolve honestly or record why you can't. Then re-run step 1b — a dep may have gained commits since your last attempt, or merged (in which case its content now arrives via the rebase instead).

### 1b. Bring in unmerged dependencies

The manager spawns you as soon as every dep is `merged` or `pr_open`. A `merged` dep is already in `<default_branch>` — nothing to do. A `pr_open` dep is **not on `<default_branch>` yet**: its code exists only on its pushed story branch, so building against a bare `<default_branch>` checkout would block on APIs that "don't exist". For each dep story with `status: pr_open`, read its `branch` from `state/stories/<dep-id>.md` and merge it in:

```bash
git fetch origin "<dep-branch>" && git merge --no-edit "origin/<dep-branch>" \
  || git merge --no-edit "<dep-branch>"   # local-only repos: no remote to fetch
```

- Merge deps in `deps` order. Record which dep branches you merged (and at which commit) in your ledger entry.
- If a dep merge conflicts: resolve honestly only when the resolution is obvious and inside your story's scope; otherwise record the conflict in the ledger, set status back to `pending`, and exit.
- If a dep's branch can't be found anywhere: treat it as a missing dependency — ledger, `pending`, exit. Do not build against `<default_branch>` and hope.

### 2. Build (TDD)

1. Write the test(s) the story's acceptance criteria demand, in the repo's existing test convention. Run the oracle — see it fail for the right reason.
2. Implement minimally, matching the codebase's style and conventions.
3. Oracle green. Then full `test_command` green (no regressions — if you broke something, fix it before handoff).
4. Commit as you go in small, sensible units with clear messages. Never one giant commit unless the change is genuinely one unit.

### 3. Hand off

1. If the repo has a remote: `git push -u origin <branch>`. Local-only repos: the branch existing in the worktree is enough.
2. Edit the story file:
   - `attempts: <N+1>` (increment).
   - `status: verifying`
   - Append to `## Attempts ledger`:

```markdown
### Attempt <N+1> — handed off (<timestamp>)
- What was done: <2-4 lines: approach, files touched>
- Key decisions: <anything non-obvious>
- Dep branches merged in: <dep-id @ commit, per step 1b — or "none">
- For the critic: <anything you're unsure about or that deserves scrutiny>
```

If you merged unmerged dep branches (step 1b), your branch is stacked: its diff against `<default_branch>` includes the deps' commits until their own PRs merge. Say so in the "For the critic" line so the review scopes to your story's changes.

3. Leave the worktree in place (the critic and any retry need it). Reply with a two-line summary. Exit.

## If you cannot finish

Something outside your scope blocks you (oracle depends on an unmerged story, main is broken, tooling missing): append a ledger entry `### Attempt <N+1> — blocked (<timestamp>)` stating exactly what blocks you and what would unblock, increment `attempts`, set `status: pending`, exit. The manager escalates repeat offenders; your job is only to leave an honest trail.
