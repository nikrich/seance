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

- The story: `state/stories/<story-id>.md` (`repo`, `branch`, `oracle`, `## Task` acceptance criteria, ledger — including what the builder flagged for you).
- The story's requirement: `state/requirements/<requirement>.md` — `feature-pr` mode reads/writes `feature_branch` and `feature_pr` here, and needs every sibling story's `status` from `state/stories/`.
- `config.yaml`: `repos.<repo>.{default_branch,integration,test_command}`.

## Procedure

If the story's requirement has `feature_branch` in its frontmatter
(feature-pr mode), use that branch wherever `<default_branch>` appears in
this skill as a diff or merge base (the feature-pr PR command's `--base
<default_branch>` stays as-is) — the diff under review is story-branch vs `feature_branch`, so
previously merged sibling stories are NOT part of this story's diff and must
not be judged as scope creep.

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
- `pr`: `git push -u origin <branch>` then compose the PR body explicitly (never `--fill`) and write it to a body file — inline `--body` is unsafe, the ledger summary is unsanitized text that a shell may expand:
  ```bash
  cat > .seance-pr-body.md <<'EOF'
  <summary of what changed and why, from the ledger>

  ---
  🔮 Summoned by [Séance](https://github.com/nikrich/seance) · powered by [Poltergeist](https://getpoltergeist.com)
  EOF
  gh pr create --title "<type>: <subject>" --body-file .seance-pr-body.md --head <branch>
  rm .seance-pr-body.md
  ```
  The heredoc delimiter (`'EOF'`) is quoted so `$(…)`/backtick sequences in the summary are never expanded. Titles go on the command line — strip any double quotes from the title text first; everything else belongs in the body file.

  **Title format — strict conventional commit, or CI title checks reject it:**
  `<type>: <subject>` where `<type>` maps from the work's category
  (`bug`/`production-issue` → `fix`, `feature` → `feat`, `chore` → `chore`;
  no category → `fix` for bug-shaped stories, else `feat`), and `<subject>`
  **starts with a lowercase letter** (semantic-PR checks commonly enforce
  `^(?![A-Z])`), keeps any ticket ids (e.g. `(DIGISURE-5552)`), and contains
  no emoji — the 🔮 branding lives ONLY in the body footer. Applies to the
  feature-pr title below too.
  record the PR URL in the ledger.
- `feature-pr`: if the requirement's frontmatter has no `feature_branch`,
  fall back to the `pr` bullet above instead. Otherwise: merge `--no-ff`
  into the requirement's `feature_branch`. Run `test_command` once more on
  `feature_branch` post-merge. If it fails, revert the merge
  (`git reset --hard ORIG_HEAD`) and treat as REJECT with the failure
  output. Then push it; if the push is rejected as non-fast-forward, a
  sibling critic just pushed to `feature_branch` first — `git pull --rebase`
  the feature branch and retry the merge once. Set story `status: merged`
  (merged-to-feature). Then, if EVERY story
  of the requirement now has `status: merged`: compose the PR body explicitly
  (never `--fill`) and write it to a body file — inline `--body` is unsafe, the
  ledger summary is unsanitized text that a shell may expand:
  ```bash
  cat > .seance-pr-body.md <<'EOF'
  <summary of what changed and why, from the ledger>

  ---
  🔮 Summoned by [Séance](https://github.com/nikrich/seance) · powered by [Poltergeist](https://getpoltergeist.com)
  EOF
  gh pr create --title "<type>: <subject>" --body-file .seance-pr-body.md --base <default_branch> --head <feature_branch>
  rm .seance-pr-body.md
  ```
  The heredoc delimiter (`'EOF'`) is quoted so `$(…)`/backtick sequences in the summary are never expanded. Titles go on the command line — strip any double quotes from the title text first; everything else belongs in the body file.
  record the URL as `feature_pr:` in the requirement frontmatter, and set
  the requirement `status: done` (the human merges the PR). If `gh pr
  create` fails because a PR for `feature_branch` already exists, fetch its
  URL instead (`gh pr view <feature_branch> --json url`), record that as
  `feature_pr`, and treat as success.
  Conflicts merging into the feature branch: REJECT with report
  "rebase onto <feature_branch> and resolve conflicts in <files>", exactly
  like the default_branch conflict rule.

Then: append `### Attempt <N> — approved (<timestamp>)` + one line on what you checked; set story `status: merged` (or `pr_open`); clean up both worktrees (`git worktree remove` yours and the builder's, `--force` if needed) and for `merge` mode delete the story branch (`git branch -d <branch>`). Exit.

### Merge conflicts

If the merge (or PR creation) hits conflicts with `default_branch`: treat as REJECT with report "rebase onto <default_branch> and resolve conflicts in <files>", status `pending`. Never resolve conflicts yourself.
