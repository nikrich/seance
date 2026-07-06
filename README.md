# Séance 👻

Summon the spirits and put them to work. Séance is an autonomous development-agent
orchestrator that runs a fleet of Claude Code agents against multiple repos for days
at a time. It is deliberately almost code-free: one bash script (`bin/heartbeat.sh`),
a workspace directory convention, and five skills. All state is markdown files;
git history is the memory. Part of the ghost ecosystem (ghost-brain / Poltergeist).

Design spec: `docs/specs/2026-07-06-seance-orchestrator-design.md`.

## Workspace layout

```
~/seance/<workspace>/
  config.yaml            # copy of templates/config.yaml, edited
  inbox/                 # drop a .md requirement or steering note; next tick consumes
  inbox/processed/       # consumed inbox items (audit trail)
  state/requirements/    # <id>.md — frontmatter: id, title, status, priority
  state/stories/         # <id>.md — status, repo, deps, oracle, attempts, branch
  state/agents/          # live agent registry: pid, role, story, started_at
  attention/             # human queue; the orchestrator routes around these
  journal/ticks.ndjson   # one line per tick
  journal/digest-YYYY-MM-DD.md
  repos/<name>/          # clone per repo ("teams")
  worktrees/<story-id>/  # builder isolation
  logs/<agent-id>.log    # full stdout of every agent
  next-sleep             # seconds; written by the tick, read by the heartbeat
  .claude/skills -> <this repo>/skills
```

## Install

```bash
git clone <this repo> ~/development/nikrich/seance
chmod +x ~/development/nikrich/seance/bin/heartbeat.sh
```

Prereqs: `claude` CLI authenticated; `gh` authenticated for repos using `integration: pr`.

## Create a workspace

```bash
WS=~/seance/my-workspace
mkdir -p $WS/{inbox/processed,state/{requirements,stories,agents},attention,journal,repos,worktrees,logs,.claude}
cp ~/development/nikrich/seance/templates/config.yaml $WS/config.yaml   # then edit
ln -s ~/development/nikrich/seance/skills $WS/.claude/skills
git clone <each repo url> $WS/repos/<name>                              # per config.yaml
```

## Run

```bash
# Foreground (a terminal you keep open):
~/development/nikrich/seance/bin/heartbeat.sh ~/seance/my-workspace

# Or as a daemon: see launchd/com.ghostbrain.seance.plist.template
```

Give it work: copy `templates/requirement.md` into `$WS/inbox/`. Steer it: drop a
plain-English note (no `id:` frontmatter) into the same inbox. Watch it:
`tail -f $WS/journal/ticks.ndjson`, check `attention/` — that's the only place a
human MUST look. Talk to it: open a Claude Code session in the workspace and ask
for the séance status (concierge skill).

## File contract (Poltergeist / external tools)

Finalized in Task 6.
