---
name: seance-manager
description: Use ONLY when invoked as the Séance manager tick ("run exactly one manager tick"). Coordinates one tick — drain inbox, reap agents, spawn planner/builders/critics — then exits. Runs with cwd = a Séance workspace.
---

# Séance Manager — One-Tick Runbook

## YOU MUST / YOU MUST NOT

- **YOU MUST** run exactly one tick, in the order below, then exit. Never loop. Never wait for a spawned process.
- **YOU MUST NOT** edit, write, or read files inside `repos/` or `worktrees/` — you orchestrate; you never touch code. You may only write under `state/`, `inbox/processed/`, `attention/`, `journal/`, `logs/`, `questions/`, and `next-sleep`.
- **YOU MUST NOT** explore beyond the workspace (cwd). No `find ~`, no reading other skills.
- **YOU MUST NOT** do the planner's, builder's, or critic's job "quickly yourself" — spawn them.
- Each step is mechanical. Do not deliberate; execute.
- **YOU MUST** obtain every timestamp by actually running `date -u +%Y-%m-%dT%H:%M:%SZ` in Bash. NEVER write a timestamp from memory — fabricated timestamps corrupt stuck-agent detection. Compare `started_at` ages with `date` arithmetic in Bash, not mental math.

## State you work with

- Requirement (`state/requirements/<id>.md`) frontmatter: `id, title, status: inbox|speccing|spec_review|planning|planned|done, priority: low|normal|high`, optional `paused: true`, optional `blocked_reason`.
- Story (`state/stories/<id>.md`) frontmatter: `id, requirement, repo, status: pending|building|verifying|approved|merged|pr_open|blocked, deps: [], oracle, branch, attempts, model_hint`.
- Agent registry (`state/agents/<agent-id>.md`) frontmatter: `id, role: planner|builder|critic, pid, story, requirement, started_at (ISO8601 UTC), model`.
- Question (`questions/*.md`) frontmatter: `id, story, requirement, status, asked_at` — written by planners/builders/critics per "The knowledge chain", resolved by the human in Poltergeist.
- `config.yaml`: `repos.<name>.*`, `max_builders`, `max_critics`, `max_planner`, `max_agent_minutes`, `attempt_cap`, `models.*`, `sleep.active`, `sleep.idle`. Optional `paused_repos: [..]` maintained by you from steering notes.

## Tick order

```
0. Init  →  1. Drain inbox  →  2. Reap  →  3. Kill stuck  →  4. Terminal states
→ 4b. Process answered questions  →  5. Spawn planner  →  6. Spawn-fill builders
→ 7. Spawn critics  →  8. Journal + digest  →  9. next-sleep  →  exit
```

### 0. Init

```bash
mkdir -p inbox/processed state/requirements state/stories state/agents attention journal journal/agents repos worktrees logs
```

If `config.yaml` is missing: write `attention/no-config.md` ("workspace has no config.yaml; copy templates/config.yaml"), write `next-sleep` = 600, append a journal line, exit.

### 1. Drain inbox

For each `inbox/*.md` (skip directories):

- **Has `id:` frontmatter** → it's a requirement: create `state/requirements/<id>.md` with the same frontmatter plus `status: speccing` (keep the body verbatim). If a requirement with that id already exists, append the body to it as an `## Update <timestamp>` section instead, and clear `blocked_reason` from its frontmatter so it becomes spawnable again.
- **No `id:` frontmatter** → it's a steering note. Apply it now:
  - "pause repo X" / "resume repo X" → add/remove X in `paused_repos` in `config.yaml`.
  - "priority <req-id> ..." / "<req-id> first" → set that requirement's `priority: high`.
  - "kill <story-id>" → find its agent in `state/agents/`, `kill <pid>`, treat as reaped in step 2.
  - Anything you cannot confidently map to one of the above → move it to `attention/` with a note that you didn't understand it. Never guess destructive actions.
- Move the processed file to `inbox/processed/`.

### 2. Reap

For each `state/agents/<agent-id>.md`, check liveness:

```bash
kill -0 <pid> 2>/dev/null && echo alive || echo dead
```

If **dead**: move the registry file to `journal/agents/`. Then reconcile its work:

- role `planner`, requirement still `planning` and no new stories exist for it → leave it at `planning` (it died mid-decompose; the next tick respawns Phase B for it). If it's still `speccing` with no `## Spec` section written, no action is needed — it stays `speccing` and is retried automatically.
- role `builder`, story still `building` → set story `pending`, increment `attempts`, append to the story's `## Attempts ledger`: `### Attempt N — agent died (<timestamp>)` + "Builder process exited without handing off. Check logs/<agent-id>.log if this repeats."
- role `critic`, story still `verifying` → leave status `verifying` (a new critic will be spawned in step 7).

### 3. Kill stuck

For each **alive** agent: if `started_at` is older than `max_agent_minutes`, `kill <pid>`, then apply the dead-agent reconciliation from step 2 with ledger note `### Attempt N — killed (stuck > max_agent_minutes)`.

### 4. Terminal states

- Any story with `attempts >= attempt_cap` and status `pending`, unless a `questions/*.md` with `status: open` names it (it's waiting on the human, not failing) → set `blocked`; write `attention/<story-id>.md` containing the story title and its full attempts ledger.
- (integration `merge`/`pr` repos) Any requirement whose stories all have
  status `merged` or `pr_open` → set requirement `done`.
- (feature-pr repos) the critic sets the requirement `done` when it opens
  the feature PR — do not mark it done on story statuses alone.

### 4b. Process answered questions

For each `questions/*.md` with `status: answered`:

- If it names a `story`: append to that story's `## Attempts ledger`:
  `### Question answered (<ts>)` followed by the full question and answer
  text. If the story's status is `pending` (it exited waiting on this
  question), also reset `attempts: 0` so it spawns immediately; a `building`
  story just gets the ledger entry — its current attempt finishes first.
- Move the file to `questions/answered/` (create the dir if needed).

A story referenced by any `status: open` question is NOT eligible to spawn.

### 5. Spawn planner

If live planners < `max_planner`, spawn for the highest-priority eligible
requirement, choosing the prompt by status:

- `status: speccing` (and no `blocked_reason`) → prompt
  `"Invoke the seance-planner skill to DRAFT THE SPEC for requirement <id>."`
- `status: planning` (spec approved by the human; and no `blocked_reason`) → prompt
  `"Invoke the seance-planner skill to DECOMPOSE requirement <id> per its approved spec."`

`spec_review` requirements are waiting on the human — never spawn for them.

```bash
AGENT_ID="planner-<req-id>-$RANDOM"
nohup claude -p "<the DRAFT THE SPEC or DECOMPOSE prompt above, for <req-id>>" \
  --dangerously-skip-permissions --model <models.planner> \
  > "logs/$AGENT_ID.log" 2>&1 &
PID=$!
```

Then write `state/agents/$AGENT_ID.md`:

```markdown
---
id: <AGENT_ID>
role: planner
pid: <PID>
story: null
requirement: <req-id>
started_at: <ISO8601 UTC now>
model: <models.planner>
---
```

### 6. Spawn-fill builders

While live builders < `max_builders`:

- Eligible story: `status: pending`, every id in `deps` has status `merged` or `pr_open`, its `repo` not in `paused_repos`, its requirement not paused, and no `questions/*.md` with `status: open` names the story.
- Pick highest requirement priority, then fewest `attempts`, then oldest.
- If none eligible, stop filling.
- Set story `building`; spawn (same nohup pattern) with prompt `"Invoke the seance-builder skill for story <story-id>."`, model = story `model_hint` if set else `models.builder`; registry entry with `role: builder`, `story: <story-id>`.

### 7. Spawn critics

For each story with `status: verifying` that has NO live agent referencing it, while live critics < `max_critics`: spawn with prompt `"Invoke the seance-critic skill for story <story-id>."`, model `models.critic`, registry `role: critic`.

### 8. Journal + digest

Append one line to `journal/ticks.ndjson`:

```json
{"ts":"<ISO8601>","reaped":N,"killed":N,"spawned":{"planner":N,"builder":N,"critic":N},"backlog":<pending stories>,"in_flight":<live agents>,"blocked":<blocked stories>,"inbox":<items drained>}
```

If `journal/digest-<today YYYY-MM-DD>.md` does not exist, create it: stories merged yesterday (scan `state/stories/` + git-less heuristic: status merged/pr_open), currently blocked stories and open `attention/` items, backlog depth, requirements in flight. Keep it under a page.

### 9. next-sleep

If this tick drained inbox items, reaped, killed, or spawned anything → write `sleep.active` (default 60) to `next-sleep`. Otherwise write `sleep.idle` (default 600). Exit.

## Frontmatter editing

Edit state files surgically: change only the frontmatter key in question (e.g. `status:`), never rewrite bodies or ledgers except where a step explicitly says to append.
