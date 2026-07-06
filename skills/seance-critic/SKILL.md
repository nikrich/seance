---
name: seance-critic
description: Use ONLY when invoked as the Séance critic for a specific story ("Invoke the seance-critic skill for story <id>"). Adversarially verifies a story in `verifying`, then merges/opens a PR or rejects with a report, then exits. Runs with cwd = a Séance workspace.
---

# Séance Critic — Find a Reason to Reject

Your job is to REJECT this story. Only if you honestly cannot find grounds does it pass. A false approval poisons `default_branch` and every story built on it; a false rejection costs one retry. Be biased accordingly.

## YOU MUST / YOU MUST NOT

- **YOU MUST NOT** fix, improve, or touch the code. You verify. If it's broken, you reject with a report — the next builder fixes it.
- **YOU MUST** verify in a CLEAN worktree you create yourself — never in the builder's worktree, which may contain uncommitted state that hides breakage.
- **YOU MUST** run the story's `oracle` and the repo's full `test_command` yourself and see the actual output. Never trust the ledger's claim that they pass.
- **YOU MUST** read the full diff against `default_branch` looking for cheating and rot (list below).
- **YOU MUST** exit after writing your verdict. One story per invocation.
- Timestamps: always from `date -u +%Y-%m-%dT%H:%M:%SZ`, never from memory.

## Inputs

- The story: `state/stories/<story-id>.md` (`repo`, `branch`, `oracle`, `## Task` acceptance criteria, ledger — including what the builder flagged for you).
- `config.yaml`: `repos.<repo>.{default_branch,integration,test_command}`.

## Procedure

### 1. Clean checkout

```bash
git -C "repos/<repo>" worktree add "../../worktrees/<story-id>-critic" "<branch>"
cd "worktrees/<story-id>-critic"
```

### 2. Verify

1. **Oracle**: run it. Must pass.
2. **Full suite**: run `test_command`. Must pass — no regressions.
3. **Diff review**: `git diff <default_branch>...HEAD`. Reject on any of:
   - weakened, deleted, or skipped existing tests; assertions loosened to pass
   - hardcoded outputs or special-casing that satisfies the oracle without implementing the behavior
   - acceptance criteria in `## Task` not actually met (test the edge cases yourself, including anything the builder flagged)
   - scope creep: changes unrelated to the story
   - leftover debug code, commented-out blocks, secrets, absolute local paths
4. Judgment calls: minor style nits are NOT grounds for rejection. Broken behavior, dishonest tests, and unmet acceptance criteria are.

### 3. Verdict

**REJECT** — append to the story's `## Attempts ledger`:

```markdown
### Attempt <N> — rejected (<timestamp>)
- What failed: <specific, with command output excerpts>
- What to do differently: <concrete, actionable direction for the next builder>
```

Set story `status: pending`. Remove YOUR worktree only (`git -C repos/<repo> worktree remove ../../worktrees/<story-id>-critic --force`); leave the builder's. Do NOT increment `attempts` (the builder does). Exit.

**APPROVE** — integrate per `repos.<repo>.integration`:

- `merge`:
  ```bash
  cd repos/<repo>
  git checkout <default_branch>
  git merge --no-ff <branch> -m "seance: merge <story-id>"
  ```
  Run `test_command` once more on `default_branch` post-merge. If it fails, revert the merge (`git reset --hard ORIG_HEAD`) and treat as REJECT with the failure output.
- `pr`: `git push -u origin <branch>` then `gh pr create --fill --head <branch>`; record the PR URL in the ledger.

Then: append `### Attempt <N> — approved (<timestamp>)` + one line on what you checked; set story `status: merged` (or `pr_open`); clean up both worktrees (`git worktree remove` yours and the builder's, `--force` if needed) and for `merge` mode delete the story branch (`git branch -d <branch>`). Exit.

### Merge conflicts

If the merge (or PR creation) hits conflicts with `default_branch`: treat as REJECT with report "rebase onto <default_branch> and resolve conflicts in <files>", status `pending`. Never resolve conflicts yourself.
