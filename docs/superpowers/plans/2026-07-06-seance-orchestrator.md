# Séance Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **This plan is pre-designated for INLINE execution (user constraint: no subagents).**

**Goal:** A multi-day autonomous dev-agent orchestrator that is one bash script + a file convention + five skills, per `docs/specs/2026-07-06-seance-orchestrator-design.md`.

**Architecture:** A dumb `heartbeat.sh` loop re-invokes a stateless manager tick (`claude -p`, fresh context) that drains an inbox, reaps/kills agents, and spawns detached `claude -p` role agents (planner/builder/critic) working in git worktrees across multiple repos. All state is markdown files with frontmatter; git history is the memory.

**Tech Stack:** bash, Claude Code CLI (`claude -p`), Claude Code skills (markdown), git worktrees, `gh` for PR mode, launchd for daemonization.

## Global Constraints

- Only executable code allowed: `bin/heartbeat.sh` (+ launchd plist template). Everything else is markdown.
- Workspaces live at `~/seance/<workspace>/`; the workspace directory is the public API (Poltergeist contract): external tools write ONLY to `inbox/`, read everything else.
- No story without an executable `oracle` command. Planner must refuse otherwise.
- Builder and critic are always separate processes. Builder never merges; critic never implements.
- Every role: fresh context, one bounded job, exit. No role loops or waits for another process.
- Git hygiene in every role prompt: small commits, never force-push, never `--no-verify`, builders confined to their worktree.
- Role model defaults: manager=haiku, planner=opus, builder=sonnet, critic=opus.
- Story statuses (exact enum): `pending | building | verifying | approved | merged | pr_open | blocked`.
- Agent spawn form: `nohup claude -p "<invocation>" --dangerously-skip-permissions --model <m> > logs/<agent-id>.log 2>&1 &` with cwd = workspace root; pid recorded in `state/agents/<agent-id>.md`.
- Skills are distributed from the seance repo and appear in a workspace via symlink: `~/seance/<ws>/.claude/skills -> ~/development/nikrich/seance/skills`.
- Testing uses a sandbox workspace `~/seance/sandbox` and a throwaway local git repo; heartbeat mechanics are tested with a fake `claude` shim (no tokens).

## File Structure

```
~/development/nikrich/seance/
  README.md                          # the contract: layout, lifecycle, install, run
  bin/heartbeat.sh                   # the only code
  launchd/com.ghostbrain.seance.plist.template
  skills/
    seance-manager/SKILL.md
    seance-planner/SKILL.md
    seance-builder/SKILL.md
    seance-critic/SKILL.md
    seance-concierge/SKILL.md
  templates/
    config.yaml                      # annotated workspace config template
    requirement.md                   # example inbox requirement
  docs/specs/2026-07-06-seance-orchestrator-design.md
  docs/superpowers/plans/2026-07-06-seance-orchestrator.md
```

---

### Task 1: Repo scaffold, heartbeat, templates

**Files:**
- Create: `bin/heartbeat.sh`, `templates/config.yaml`, `templates/requirement.md`, `launchd/com.ghostbrain.seance.plist.template`, `README.md` (skeleton: layout + install + run; contract section finalized in Task 6)

**Interfaces:**
- Produces: `heartbeat.sh <workspace-dir>` — loops forever; reads `next-sleep` (seconds, default 60); rate-limit detection via last 5 lines of `logs/manager.log`; doubling backoff from 900s.
- Produces: `templates/config.yaml` keys consumed by all skills: `workspace, repos.<name>.{url,default_branch,integration,test_command}, max_builders, max_critics, max_planner, max_agent_minutes, attempt_cap, models.{manager,planner,builder,critic}, sleep.{active,idle}`.

- [ ] **Step 1: Write `bin/heartbeat.sh`**

```bash
#!/usr/bin/env bash
# Séance heartbeat — the only code in the system.
# usage: heartbeat.sh <workspace-dir>
set -u
WS="${1:?usage: heartbeat.sh <workspace-dir>}"
cd "$WS" || exit 1
mkdir -p logs
RL_SLEEP=0
while true; do
  claude -p "Invoke the seance-manager skill and run exactly one manager tick." \
    --dangerously-skip-permissions \
    --model "$(grep -E '^\s*manager:' config.yaml | awk '{print $2}' | head -1)" \
    >> logs/manager.log 2>&1
  if tail -5 logs/manager.log | grep -qiE "rate.?limit|usage limit|overloaded"; then
    RL_SLEEP=$(( RL_SLEEP == 0 ? 900 : RL_SLEEP * 2 ))
    echo "[heartbeat] rate-limited, sleeping ${RL_SLEEP}s" >> logs/heartbeat.log
    sleep "$RL_SLEEP"
    continue
  fi
  RL_SLEEP=0
  SLEEP="$(cat next-sleep 2>/dev/null || echo 60)"
  case "$SLEEP" in (*[!0-9]*|"") SLEEP=60;; esac
  sleep "$SLEEP"
done
```

- [ ] **Step 2: Test heartbeat mechanics with a fake `claude` shim (no tokens)**

Create `/private/tmp/.../scratchpad/hb-test/` with a `claude` shim on PATH that appends its args to `calls.log` and exits 0; a minimal `config.yaml` (`models:\n  manager: haiku`); `next-sleep` containing `1`. Run `timeout 5 heartbeat.sh <dir>` with `PATH=<shim>:$PATH`. Expected: ≥3 lines in `calls.log` (loop iterates), no crash. Then write `rate limit reached` into `logs/manager.log` via a shim variant and confirm `heartbeat.log` records `sleeping 900s`.

- [ ] **Step 3: Write `templates/config.yaml`** (annotated, all keys from Interfaces above, with spec defaults: max_builders 3, max_critics 2, max_planner 1, max_agent_minutes 45, attempt_cap 3, sleep active 60 / idle 600)

- [ ] **Step 4: Write `templates/requirement.md`** — frontmatter `id, title, priority` + body describing the ask, with a worked example.

- [ ] **Step 5: Write `launchd/com.ghostbrain.seance.plist.template`** — ProgramArguments `[bash, <SEANCE_REPO>/bin/heartbeat.sh, <WORKSPACE>]`, KeepAlive true, RunAtLoad true, StandardOut/ErrPath into `<WORKSPACE>/logs/launchd.log`.

- [ ] **Step 6: Write `README.md` skeleton** — what Séance is (3 sentences), workspace layout block (verbatim from spec), install (clone repo, `chmod +x bin/heartbeat.sh`), create-a-workspace steps (mkdir layout, copy config template, symlink `.claude/skills`), run (`bin/heartbeat.sh ~/seance/<ws>` or launchd).

- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: heartbeat, workspace templates, launchd, README skeleton"`

### Task 2: seance-manager skill

**Files:**
- Create: `skills/seance-manager/SKILL.md`

**Interfaces:**
- Consumes: `config.yaml`, `inbox/*.md`, `state/**`, `logs/`, story schema below.
- Produces: requirement files `state/requirements/<id>.md` (frontmatter: `id, title, status: inbox|planning|planned|done, priority`); agent registry entries `state/agents/<agent-id>.md` (frontmatter: `id, role, pid, story, requirement, started_at, model`); `journal/ticks.ndjson`; `next-sleep`; spawns planner/builder/critic via the Global-Constraints spawn form.

**Skill content checklist (the SKILL.md must contain ALL of these, in this tick order):**
1. Frontmatter: `name: seance-manager`, description "Use ONLY when invoked as the Séance manager tick..." + YOU MUST block: exactly one tick then exit; never Edit/Write repo files (state files only); never wait on spawned processes; do not explore beyond the workspace.
2. **Init**: `mkdir -p` all workspace dirs (idempotent); if `config.yaml` missing → write `attention/no-config.md` and exit.
3. **Drain inbox**: each `inbox/*.md` → requirement file (status `inbox`) or steering note (no `id:` frontmatter → apply instruction to state frontmatter: pause/resume/priority/kill); move original to `inbox/processed/`.
4. **Reap**: for each `state/agents/*.md`: `kill -0 <pid>` → dead: archive entry to `journal/agents/`, then reconcile — if its story is still `building`/`verifying` and no verdict/handoff happened, flip story back to `pending` and append an "agent died" line to the attempts ledger.
5. **Kill stuck**: `started_at` older than `max_agent_minutes` → `kill <pid>`, requeue as in reap.
6. **Handle terminal stories**: `attempts >= attempt_cap` → status `blocked` + write `attention/<story-id>.md`. All stories of a requirement `merged|pr_open` → requirement `done`.
7. **Spawn planner**: if any requirement status `inbox` and live planners < `max_planner` → spawn planner for the highest-priority one, set requirement `planning`.
8. **Spawn-fill builders**: while live builders < `max_builders` and a `pending` story exists whose `deps` are all `merged|pr_open` and whose repo isn't paused → spawn builder, set story `building`.
9. **Spawn critics**: for each story `verifying` with no live critic, while live critics < `max_critics` → spawn critic.
10. **Journal + digest**: append tick line to `journal/ticks.ndjson` (`{ts, reaped, killed, spawned:{planner,builder,critic}, backlog, in_flight, blocked}`); on first tick of a calendar day also write/refresh `journal/digest-YYYY-MM-DD.md` (yesterday's merged stories, current blocked/attention, backlog depth).
11. **next-sleep**: any spawn/reap/inbox activity → `sleep.active`, else `sleep.idle`. Write file, exit.
12. Spawn snippets shown concretely in the skill (nohup form with `$RANDOM`-suffixed agent id, log redirect, `echo $!` → registry file).

- [ ] **Step 1: Write the SKILL.md** implementing every checklist item with concrete bash snippets inline (the manager is mechanical — the skill should read like a runbook, not advice).
- [ ] **Step 2: Smoke test — empty workspace.** Create `~/seance/sandbox` per README steps (symlink skills). Run one real tick: `cd ~/seance/sandbox && claude -p "Invoke the seance-manager skill and run exactly one manager tick." --dangerously-skip-permissions --model haiku`. Expected: dirs created, `journal/ticks.ndjson` has 1 line, `next-sleep` contains `600`, no agents spawned, process exits.
- [ ] **Step 3: Smoke test — steering note.** Drop `inbox/note.md` ("pause repo toy"). Tick. Expected: note moved to `inbox/processed/`, pause recorded (config-adjacent state file or requirement frontmatter per skill's documented mechanism).
- [ ] **Step 4: Commit.**

### Task 3: seance-planner skill

**Files:**
- Create: `skills/seance-planner/SKILL.md`

**Interfaces:**
- Consumes: one requirement id (in invocation prompt), `config.yaml`, `repos/<name>/` checkouts.
- Produces: `state/stories/<req-id>-s<N>.md` in the exact story schema from the spec (frontmatter: `id, requirement, repo, status: pending, deps, oracle, branch: seance/<story-id>, attempts: 0, model_hint`; body: `## Task` with acceptance criteria + empty `## Attempts ledger`); requirement status → `planned`.

**Skill content checklist:**
1. Frontmatter + YOU MUST block: never write code; never create a story without an executable `oracle` that currently CAN run in that repo (verify the command exists — e.g. the test runner is configured — before writing it); one requirement per invocation; exit when stories are written.
2. Read requirement, explore only the repos it touches (conventions, test setup, existing similar features).
3. Decompose into the smallest independently-mergeable stories; assign `repo`, `deps` (story ids), `model_hint` (sonnet default, opus for gnarly).
4. Oracle rules: must be a shell command runnable from repo root; prefer `test_command` + a targeted new-test filter; for cross-repo requirements add a final integration story depending on all others whose oracle exercises the end-to-end flow.
5. If the requirement is unplannable (ambiguous, missing access, no test infra for an oracle) → write `attention/<req-id>.md` explaining what's needed, set requirement status back to `inbox` with a `blocked_reason`, exit.
6. Set requirement `planned`, exit.

- [ ] **Step 1: Write the SKILL.md.**
- [ ] **Step 2: Create the toy fixture repo.** `~/seance/sandbox/repos/toy`: `git init`, a bash project — `lib/calc.sh` (empty stub file), `test/run.sh` (executable; runs any `test/*_test.sh`, exits non-zero on failure), one passing sanity test, initial commit on `main`. Register in sandbox `config.yaml` (`integration: merge`, `test_command: ./test/run.sh`).
- [ ] **Step 3: End-to-end planner test.** Drop `inbox/REQ-1.md` ("Add a `sum` function to lib/calc.sh that sums integer args; validate non-integer input with a clear error"). Run one manager tick (haiku). Expected: requirement filed + planner spawned (registry entry, pid alive or already exited). Wait for planner exit. Expected: ≥1 story in `state/stories/` with a runnable oracle referencing `./test/run.sh`, requirement `planned`.
- [ ] **Step 4: Verify oracle actually executes** (and fails, since nothing is implemented): `cd repos/toy && <oracle from story>` → non-zero exit.
- [ ] **Step 5: Commit** (skill + any README corrections discovered).

### Task 4: seance-builder skill

**Files:**
- Create: `skills/seance-builder/SKILL.md`

**Interfaces:**
- Consumes: one story id; story file; `worktrees/`; repo clone.
- Produces: branch `seance/<story-id>` pushed/available in the repo (local-only repos: branch exists locally); story status → `verifying`; attempt entry appended to `## Attempts ledger`; worktree left in place at `worktrees/<story-id>` for the critic.

**Skill content checklist:**
1. Frontmatter + YOU MUST block: read the attempts ledger FIRST and never retry an approach it rules out; work ONLY inside `worktrees/<story-id>`; TDD (failing test before implementation); run the oracle yourself before handing off; small commits; never force-push; never `--no-verify`; never merge; if the oracle cannot pass for reasons outside the story's scope, log it in the ledger, set status `pending`, and exit rather than widening scope.
2. Setup: `git -C repos/<repo> worktree add ../../worktrees/<story-id> -b seance/<story-id> <default_branch>` (idempotent: reuse existing worktree/branch on retry attempts).
3. TDD loop, then full `test_command` (no regressions), then oracle green.
4. Handoff: commit all, increment `attempts`, append attempt entry (what was done, key decisions, anything the critic should scrutinize), status → `verifying`, exit.

- [ ] **Step 1: Write the SKILL.md.**
- [ ] **Step 2: End-to-end builder test.** Run manager ticks until a builder spawns for the `sum` story (or invoke the builder directly with the story id to save a tick). Wait for exit. Expected: `worktrees/<story-id>` exists on branch `seance/<story-id>`, contains a new `test/sum_test.sh` + implementation, oracle passes inside the worktree, story `verifying`, ledger has attempt 1.
- [ ] **Step 3: Commit.**

### Task 5: seance-critic skill

**Files:**
- Create: `skills/seance-critic/SKILL.md`

**Interfaces:**
- Consumes: one story id; the `verifying` story + its branch; repo config (`integration`, `test_command`).
- Produces: verdict — approve: merge to `default_branch` (`integration: merge`) or `gh pr create` (`integration: pr`), story → `merged`/`pr_open`, worktree removed; reject: failure report appended to ledger, story → `pending`, worktree left for the next builder.

**Skill content checklist:**
1. Frontmatter + YOU MUST block: your job is to find a reason to reject; never fix code yourself; verify in a CLEAN checkout (fresh temp worktree of the branch — not the builder's worktree); run the oracle AND the full `test_command` yourself; check the diff against `default_branch` for weakened/deleted tests, hardcoded oracle-pleasing, scope creep, leftover debug code.
2. Reject path: concrete, actionable failure report into the ledger (what failed, command output excerpts, what to do differently), `attempts` unchanged (builder increments), status `pending`, remove only the critic's temp worktree.
3. Approve path: merge with `--no-ff` into `default_branch` (or `gh pr create --fill`), delete story branch + both worktrees (`git worktree remove`), status `merged`/`pr_open`.
4. Merge-conflict on approve: treat as reject with a "rebase onto <default_branch>" report.

- [ ] **Step 1: Write the SKILL.md.**
- [ ] **Step 2: End-to-end critic test.** Tick until critic spawns (or invoke directly). Expected: story → `merged`, `repos/toy` `main` contains sum implementation + test, `./test/run.sh` passes on `main`, worktrees cleaned up, `state/agents/` empty after a final reap tick.
- [ ] **Step 3: Adversarial check (manual seed).** Create a second story whose ledger/branch contains a deliberately weakened test (e.g. builder-committed test that always passes) by committing it directly; invoke critic. Expected: reject with a report naming the weakened test. (This validates the cheat-detection prompt actually bites.)
- [ ] **Step 4: Commit.**

### Task 6: seance-concierge, contract README, unattended soak

**Files:**
- Create: `skills/seance-concierge/SKILL.md`
- Modify: `README.md` (finalize the Poltergeist file contract section: external tools write only `inbox/`, read-only everywhere else; document every state file schema verbatim)

**Interfaces:**
- Consumes: everything in the workspace.
- Produces: human-facing status summaries; state mutations on explicit user request (requeue blocked story, adjust priority, kill agent by pid, unblock attention item).

**Skill content checklist:**
1. Frontmatter: invoked interactively in a workspace ("Use when the user asks about Séance status or wants to steer a running workspace").
2. Status: synthesize backlog / in-flight (with pid liveness) / blocked / attention / yesterday-today digest from files — never guess, always read.
3. Steering actions it may take on request, each mirrored into `journal/ticks.ndjson` as a `{human: true}` event: requeue, reprioritize, pause/resume repo, kill agent, mark attention item resolved.
4. It must never edit repo code or spawn role agents (tell the user the next tick will).

- [ ] **Step 1: Write the SKILL.md.**
- [ ] **Step 2: Finalize README contract section.**
- [ ] **Step 3: Unattended soak test.** Reset toy repo state; drop `inbox/REQ-2.md` (a two-story requirement: "add `multiply` function" + "add `average` that uses sum — depends on sum being merged"; sum already merged so use multiply+average with a dep edge). Start `bin/heartbeat.sh ~/seance/sandbox` in the background. Walk away (monitor via `journal/ticks.ndjson`). Expected within ~30 min unattended: both stories `merged`, `main` green, heartbeat idling at 600s. Kill heartbeat.
- [ ] **Step 4: Concierge test.** In a session in the sandbox: "what's the séance status?" → correct synthesis of the soak run.
- [ ] **Step 5: Commit; tag `v0.1.0`.**

---

## Self-review notes

- Spec coverage: heartbeat (T1), manager+journal+digest+steering (T2), planner+oracle rule+attention path (T3), builder+ledger+worktrees (T4), critic+adversarial+integration modes (T5), concierge+contract+soak (T6). Launchd (T1). Groom/Jira/Poltergeist UI: out of scope per spec.
- Model policy is enforced at spawn time by manager reading `config.yaml` `models:` (checklist item 12 spawn snippets must include `--model`).
- Rate-limit handling covers spawned agents implicitly: a rate-limited builder dies, reap requeues it, heartbeat backoff throttles ticks.
