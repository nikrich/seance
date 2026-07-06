# Séance Observability — Under-the-Hood Log + Chat

**Date:** 2026-07-06
**Status:** Approved design
**Repo:** everything lands in `seance` (`poltergeist-plugin/` + one concierge-skill edit). Zero Poltergeist/ghost-brain changes — the plugin system carries it.

## Goal

Two additions to the Séance plugin screen, as tabs (**board | under the hood | chat**):

1. **Under the hood** — a live, human-readable activity feed of what the orchestrator is doing, with click-through to any agent's full stdout, tailing live while it runs.
2. **Chat** — converse with "the séance": a concierge agent with full access to the workspace files and logs. It answers "what's happening / why did X fail", and on explicit request injects guidance for future attempts or steers the run.

Honest framing baked into the design: role agents are ephemeral one-shot processes — there is no live process to converse with mid-build. Chat therefore talks to the **concierge** (which can read a running agent's log in real time), and "feedback to agents" happens by writing guidance into the story's attempts ledger — the first thing the next attempt reads.

## Data sources (all already exist)

- `journal/ticks.ndjson` — spawns/reaps/kills, human actions (`{human: true}`)
- Story files' `## Attempts ledger` — timestamped `handed off | rejected | approved | blocked | agent died | killed` entries with reasons
- `state/agents/` (live) + `journal/agents/` (reaped) — agent registry
- `logs/<agent-id>.log` — full stdout of every agent; `logs/manager.log`, `logs/heartbeat-plugin.log`
- `attention/*.md` — human queue

## Under the hood

### Activity lib (`poltergeist-plugin/src/lib/activity.cjs`, pure, node --test)

`buildActivity(wsPath, limit) → Event[]` — merged, newest-first:

```js
{ ts, kind, text, storyId?, agentId? }
// kinds: tick-spawn | tick-reap | tick-kill | human | handoff | rejected |
//        approved | blocked | agent-died | attention
```

Sources: parse `ticks.ndjson` lines into per-kind events (a line with `spawned.builder: 1` yields one `tick-spawn` event; correlate agent ids via registry files where possible, else generic text); parse ledger headings (`### Attempt N — <verdict> (<ts>)`) plus their first `What failed:`/`What was done:` line into verdict events; list `attention/` files (fs mtime as ts). Malformed lines are skipped, never thrown.

### Plugin IPC (main.cjs)

- `activity(wsPath, limit=100)` → `Event[]`
- `agents:list(wsPath)` → `{id, role, story, startedAt, alive, source: 'live'|'reaped'}[]` from `state/agents/` + `journal/agents/`, plus pseudo-agents `manager` and `heartbeat` (always listed when their logs exist)
- `log:read(wsPath, agentId, fromByte=0)` → `{chunk, nextByte, size}` — incremental read of `logs/<agentId>.log` (pseudo-agents map to `manager.log` / `heartbeat-plugin.log`); missing file → `{chunk: '', nextByte: 0, size: 0}`. `agentId` validated `^[\w.-]+$` (no path tricks).

### UI

Left: the feed (kind icon + text + relative time), refreshed on the existing `changed` watch event + 15s poll fallback. Click an event with an `agentId` (or an agent in a "recent agents" strip) → right pane: monospace log tail, auto-scroll unless the user scrolled up, polls `log:read` with `fromByte` every 2s while open. No new fs watchers — logs churn constantly while agents write.

## Chat

### Plugin IPC (main.cjs)

- `chat:send(wsPath, text)` → `{answer}` — spawns the `claude` CLI, cwd = workspace:
  - First message: `claude -p "<preamble + text>" --output-format json --dangerously-skip-permissions --model <chatModel>`; parse `session_id` and `result` from the JSON.
  - Later messages: same but `--resume <session_id>` — conversational memory lives in the session, not the plugin.
  - Preamble (first message only): "Invoke the seance-concierge skill. You are being used as a chat interface inside Poltergeist." + the user text.
  - `chatModel` plugin setting, default `sonnet`. Timeout 120s (kill + error bubble). Non-zero exit → error with stderr tail (rate limits surface honestly).
  - Session ids per workspace in `dataDir/chat-sessions.json`; display transcript (user/assistant/error messages, ts) in `dataDir/chat/<workspace-slug>.json` so the tab survives app restarts.
- `chat:history(wsPath)` → stored transcript
- `chat:reset(wsPath)` → clears session id + transcript
- Concurrency: one in-flight message per workspace; a second `chat:send` while pending → error "the spirits are still deliberating".

### Concierge skill edit (`skills/seance-concierge/SKILL.md`)

Add a "Headless / chat invocation" section: you may be running non-interactively behind a chat UI — answer in concise markdown; never use interactive prompts or ask the user to run commands they can't; when asked about a running agent, read the tail of its `logs/<agent-id>.log` and summarize what it is doing right now; end status answers with the single most useful next action. Existing steering rules unchanged (guidance → ledger notes, mutations mirrored to the journal, destructive-action refusals).

### UI

Chat tab: transcript bubbles (markdown-lite rendering: paragraphs, code spans, lists), input + send on Enter, "consulting the spirits…" pending state, error bubbles inline, "new séance" (reset) button, starter chips when empty: *what's happening right now?* · *why was the last story rejected?* · *what needs me?*

## Error handling

- Missing/unauthenticated `claude` CLI → chat error bubble with remedy text.
- Activity/log reads never throw on malformed or missing files; they degrade to fewer events / empty chunks.
- All new handlers keep the assertWorkspace guard (workspace must live under `~/seance/`).

## Testing

- `node --test`: activity lib against fixture ticks/ledgers (verdict extraction, ordering, malformed-line tolerance); chat session bookkeeping with a fake `claude` shim on PATH (asserts first-call vs `--resume` args, session persistence, timeout path).
- Rebuild `dist/`, commit, reinstall-from-folder in Poltergeist; live checks: REQ-3 history renders in the feed; drill into the critic log; chat: "why did REQ-2-s2 take two attempts?" must cite the merge conflict from the ledger.

## Out of scope (v1)

- Streaming chat tokens (layer on later via `--output-format stream-json`)
- Talking to in-flight agents / pause-point protocol
- Feed filtering/search; log download; multi-workspace simultaneous tails
