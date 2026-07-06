# Foreman — Autonomous Development Agent Orchestrator

**Date:** 2026-07-06
**Status:** Approved design
**Working name:** Foreman (rename freely; nothing hardcodes the name except paths)

## What it is

An orchestrator that runs a fleet of Claude Code agents against multiple repos, autonomously, for days. It is deliberately almost code-free:

- **~20 lines of bash** (`heartbeat.sh`) — the only executable code
- **A state-directory convention** — files are the single source of truth
- **Six skills** — the entire intelligence (manager, planner, builder, critic, concierge, groom)

Everything else is Claude Code (`claude -p`) with fresh context per invocation. This is a clean-slate design; it is not based on hungry-ghost-hive v2, though it inherits the lesson that skills hold the intelligence and the supervisor should be dumb.

## Design principles (load-bearing)

1. **Progress lives in files and git history, never in context.** Every process is a fresh `claude -p` with a bounded job; it reads state, acts, writes state, exits. (Ralph principle applied at every level, including the orchestrator itself.)
2. **No story without a done-oracle.** Every story carries an executable command that must pass. Agents never self-judge completion against vibes.
3. **The writer never judges.** Builder and critic are different processes with adversarial framing.
4. **Failure is memory.** Every failed attempt appends what was tried and why it failed to the story's attempts ledger; the next attempt reads it first. Dead ends are never re-walked blind.
5. **Route around humans, don't block on them.** Anything needing a decision goes to `attention/` and the orchestrator continues on other work.

## Topology

```
heartbeat.sh (forever, optionally launchd-managed)
  └─ claude -p "tick" (manager skill, stateless, fresh context, cwd = workspace)
       ├─ drain inbox/           → new requirements + steering notes
       ├─ reap finished agents   → kill -0 on recorded PIDs; process critic verdicts
       ├─ kill stuck agents      → running > max_agent_minutes → kill, requeue with note
       ├─ spawn planner          → if requirements lack stories (max 1 concurrent)
       ├─ spawn-fill builders    → while live builders < max_builders && ready stories
       ├─ spawn critics          → for stories in `verifying` (up to max_critics)
       └─ write next-sleep + journal line, exit
```

Spawned agents are detached `claude -p` subprocesses (`nohup ... &`), each logged to `logs/<agent-id>.log`, each registered in `state/agents/<id>.md` with pid, role, story, started_at.

## Workspace layout

Central, one directory per workspace, multi-repo from day one:

```
~/foreman/<workspace>/
  config.yaml            # see below
  inbox/                 # drop .md requirement or steering note; next tick consumes
  inbox/processed/       # consumed inbox items (audit trail)
  state/requirements/    # <id>.md — frontmatter: id, status, title; body: the ask
  state/stories/         # <id>.md — see story schema
  state/agents/          # live agent registry
  attention/             # human queue; orchestrator routes around these
  journal/ticks.ndjson   # one line per tick: counts, spawns, reaps, sleep
  journal/digest-YYYY-MM-DD.md   # daily human-readable digest
  repos/<name>/          # clone per repo ("teams")
  worktrees/<story-id>/  # builder isolation, worktree off repos/<name>
  logs/<agent-id>.log    # full stdout of every claude -p
  next-sleep             # seconds; written by tick, read by heartbeat
  .claude/skills/        # the six skills
```

### config.yaml

```yaml
workspace: capstone
repos:
  bff-web:
    url: git@github.com:org/bff-web.git
    default_branch: main
    integration: pr        # pr | merge — protected repos use pr
    test_command: mvn -q verify
max_builders: 3
max_critics: 2
max_planner: 1
max_agent_minutes: 45
attempt_cap: 3
models:                    # claude CLI aliases; override per workspace
  manager: haiku           # cheap; the tick is mechanical
  planner: opus
  builder: sonnet
  critic: opus             # judgment is where quality dies
permission_mode: bypassPermissions   # acceptable: the workspace is the sandbox
sleep:
  active: 60
  idle: 600
  rate_limited_initial: 900   # doubles per consecutive rate-limited tick
```

### Story schema (`state/stories/<id>.md`)

```markdown
---
id: FOO-123-s1
requirement: FOO-123
repo: bff-web
status: pending    # pending | building | verifying | approved | merged | pr_open | blocked
deps: []           # story ids that must be merged first
oracle: "mvn -q verify && bruno run tests/claims --env local"
branch: foreman/FOO-123-s1
attempts: 0
model_hint: default
---

## Task
<what to build, acceptance criteria>

## Attempts ledger
### Attempt 1 — rejected (2026-07-06T14:12Z)
Tried X; critic rejected because Y. Do not retry X; consider Z.
```

Lifecycle: `pending → building → verifying → (rejected → pending, attempts+1) | approved → merged | pr_open`. At `attempts == attempt_cap`: `blocked` + file dropped in `attention/`.

## Roles

### manager (per tick, cheap model)
One tick, exits. Never edits code — no Edit/Write on repo files, only state files. Order: drain inbox → reap → kill stuck → process verdicts → spawn planner → spawn-fill builders (dependency-aware: only stories whose deps are merged) → spawn critics → journal + next-sleep → exit. Steering notes in the inbox (plain English: "pause repo X", "FOO-124 first") are applied to state frontmatter.

### planner (per requirement, top model)
Reads one requirement + the relevant repos (structure, conventions, existing tests). Emits stories. **Hard rule: refuses to emit a story without an executable oracle.** Assigns repo, dependency edges, model hint. Cross-repo requirements get an explicit final integration story that depends on all others and whose oracle exercises the full flow.

### builder (per story attempt)
One story, one worktree (`worktrees/<story-id>`, branched off the repo's default branch). Reads the attempts ledger FIRST. TDD: failing test → implement → oracle green locally. Small commits; never force-push; never `--no-verify`; never touches files outside its worktree. Pushes branch, appends its attempt entry, flips status to `verifying`, exits.

### critic (per story in verifying, top model)
Adversarial framing: its job is to find a reason to reject. Fresh worktree of the branch. Runs the oracle AND the repo's full test command. Reviews the diff for cheating: weakened/deleted tests, skipped checks, hardcoded oracle-pleasing, scope creep. Verdict:
- **approve** → integrate per repo config (merge to default branch, or open PR via `gh`), status → `merged`/`pr_open`
- **reject** → concrete failure report appended to the attempts ledger, status → `pending`, attempts+1

### concierge (interactive, for the human)
Invoked in a normal Claude Code session in the workspace. Status queries, reprioritization, kill/requeue, unblocking `attention/` items. Reads/writes the same files; no daemon coordination needed.

### groom (stretch — not in v1)
When the backlog is dry, proposes follow-up work (bug sweeps, refactor passes) into `attention/` for human approval — it never self-feeds the backlog directly.

## Multi-day survival mechanics

- **Fresh context everywhere.** Nothing accumulates.
- **Backoff:** tick writes `next-sleep` (active 60s / idle 600s). Heartbeat detects rate-limit exits and sleeps 15 min, doubling while it persists. Survives limit windows.
- **Crash/reboot:** heartbeat under launchd; state is files, so any tick can resume from anything.
- **Stuck agents:** killed past `max_agent_minutes`, story requeued with a note in the ledger.
- **Orphan hygiene:** reap uses `kill -0` + agent registry; registry entries for dead pids are archived to the journal.
- **Blast radius:** builders confined to worktrees; integration gated on critic approval; protected repos use PR mode; `dangerously-skip-permissions` is acceptable because the workspace is the sandbox.

## Reporting

- `journal/ticks.ndjson` — machine-readable heartbeat of the whole system.
- Daily digest (manager writes/updates on first tick after midnight): shipped stories, blocked items, attempts burned, backlog depth.
- `attention/` is the only place a human MUST look.

## Heartbeat (`bin/heartbeat.sh`, the only code)

```bash
#!/usr/bin/env bash
# usage: heartbeat.sh <workspace-dir>
WS="$1"; cd "$WS"
RL_SLEEP=0
while true; do
  claude -p "Run one foreman manager tick." \
    --permission-mode bypassPermissions \
    >> logs/manager.log 2>&1
  status=$?
  if grep -q "rate.limit\|usage limit" <(tail -5 logs/manager.log); then
    RL_SLEEP=$(( RL_SLEEP == 0 ? 900 : RL_SLEEP * 2 ))
    sleep "$RL_SLEEP"; continue
  fi
  RL_SLEEP=0
  sleep "$(cat next-sleep 2>/dev/null || echo 60)"
done
```

(Exact flags — model selection, skill invocation form — finalized during implementation; this is the shape.)

## Build order

1. Scaffold: repo layout, `config.yaml` schema, `heartbeat.sh`, `foreman init` doc (a README, not a CLI).
2. `manager` + `planner` skills; verify a tick runs end-to-end with a fake requirement (no builders yet).
3. `builder` + `critic`; end-to-end on a toy requirement against a throwaway repo — watch a story go pending → merged unattended.
4. `concierge` + daily digest; then a real multi-hour soak run.

Built inline (no subagents). Repo: `~/development/nikrich/foreman`.

## Out of scope (v1)

- Semantic memory / mempalace integration
- hive-ide UI integration (the file-based state makes a read-only viewer trivial later)
- Jira intake (a later inbox adapter; intake is files-only in v1)
- groom role
