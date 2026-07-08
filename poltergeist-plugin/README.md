# Séance

Summon autonomous coding sessions from inside Poltergeist and watch them live.

Séance is the Poltergeist plugin for [seance](https://github.com/nikrich/seance) —
the file-convention orchestrator that runs multi-day dev-agent sessions from a
workspace folder on your machine. The plugin gives every séance workspace a live
control room in your second brain: kick off work, steer it mid-flight, and watch
stories move across the board without touching a terminal.

## What it does

- **Workspace picker** — finds every séance workspace under `~/seance/` and lets
  you switch between them.
- **Live board** — stories grouped by status (backlog / building / verifying /
  shipped / blocked) with repo, attempt count, and requirement chips, refreshed
  the moment anything on disk changes.
- **Summon panel** — write a requirement (id, title, priority, markdown body)
  straight into the workspace `inbox/`; the heartbeat picks it up on its next tick.
- **Steering** — drop a free-form steering note into the inbox to nudge a running
  session without stopping it.
- **Heartbeat control** — start and stop the workspace heartbeat from the header,
  with a health dot showing recent tick activity.
- **Attention strip** — anything the agents flagged for a human shows up as an
  alert card at the top, the instant it lands in `attention/`.

## How it works

The plugin consumes séance's file contract and nothing else: it **reads**
`state/`, `attention/`, and `journal/`, and **writes only to `inbox/`**. Sessions,
agents, and git stay entirely under séance's control. The main-process side
watches the workspace with debounced `fs.watch` and pushes snapshots to the
renderer, so the board is live without polling.

## Requirements

- [seance](https://github.com/nikrich/seance) checked out locally (default
  `~/development/nikrich/seance`, configurable in plugin settings via
  `seanceRepoPath`) — the plugin launches its `heartbeat.sh`.
- At least one séance workspace initialised under `~/seance/`.

## Install

In Poltergeist: **Plugins → install from git** with

- git url: `https://github.com/nikrich/seance`
- subdirectory: `poltergeist-plugin`

Or grab it from the [marketplace](https://market.getpoltergeist.com/plugins/seance/).
