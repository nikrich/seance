# Séance Observability (Log + Chat) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Pre-designated for INLINE execution (user constraint: no subagents).**

**Goal:** Add an under-the-hood activity feed with per-agent log drill-in, and a concierge-backed chat, as tabs in the Séance Poltergeist plugin — per `docs/specs/2026-07-06-observability-log-chat-design.md`.

**Architecture:** Pure parsing lib (`activity.cjs`) merges ticks.ndjson + attempts-ledger verdicts + attention into one event feed; plugin main gains `activity` / `agents:list` / `log:read` / `chat:*` IPC; chat spawns `claude -p [--resume]` per message with the concierge skill; renderer gains a tab bar and two new views. Zero ghost-brain changes.

**Tech Stack:** plain CommonJS + `node --test` (plugin repo convention), esbuild bundle, React (already bundled in renderer.jsx), `claude` CLI with `--output-format json`.

## Global Constraints

- All work in `~/development/nikrich/seance` on `main`; conventional commits with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; push at the end.
- Plugin writes ONLY to workspace `inbox/` + its own `dataDir`; every handler keeps the `assertWorkspace` guard (`~/seance/` containment).
- `agentId` for log reads validated `^[\w.-]+$`; pseudo-agents: `manager` → `logs/manager.log`, `heartbeat` → `logs/heartbeat-plugin.log`.
- Chat: one in-flight message per workspace ("the spirits are still deliberating"); 120s timeout; `chatModel` plugin setting, default `sonnet`; session ids in `dataDir/chat-sessions.json`; transcripts in `dataDir/chat/<slug>.json`.
- Activity/log reads never throw on malformed/missing files.
- Rebuild + commit `dist/` (repo has gitignore-negation? seance repo has `poltergeist-plugin/.gitignore` = `node_modules/` only — dist is tracked normally).

## File Structure

```
poltergeist-plugin/
  src/lib/activity.cjs        # buildActivity(wsPath, limit) — pure feed builder
  src/lib/chat.cjs            # createChat({dataDir, exec}) — session bookkeeping + claude arg construction (exec injected for tests)
  src/main.cjs                # + activity/agents:list/log:read/chat:send/chat:history/chat:reset handlers
  src/renderer.jsx            # + tab bar; board extracted as-is; new UnderTheHood + Chat views (same file, ~3 components)
  test/activity.test.mjs
  test/chat.test.mjs
skills/seance-concierge/SKILL.md   # + "Headless / chat invocation" section
```

---

### Task 1: activity lib

**Files:** Create `poltergeist-plugin/src/lib/activity.cjs`, `poltergeist-plugin/test/activity.test.mjs`

**Interfaces — Produces:**

```js
// buildActivity(wsPath, limit=100) → Event[] newest-first
// Event: { ts: string, kind: string, text: string, storyId?: string, agentId?: string }
// kinds: tick-spawn | tick-reap | tick-kill | human | handoff | rejected |
//        approved | blocked | agent-died | attention
```

Sources & rules:
- `journal/ticks.ndjson`: per line — `spawned.planner/builder/critic > 0` → one `tick-spawn` per role (`text: "tick: spawned 1 builder"`); `reaped > 0` → `tick-reap`; `killed > 0` → `tick-kill`; `human: true` → `human` with `action`/`target` in text. Malformed JSON lines skipped.
- Story ledgers (`state/stories/*.md`): headings `### Attempt N — <label> (<ts>)` → kind by label (`handed off`→`handoff`, `rejected`→`rejected`, `approved`→`approved`, `blocked`→`blocked`, `agent died`→`agent-died`, `killed`→`tick-kill`); text = `"<storyId> attempt N <label>"` + first `- What failed:`/`- What was done:` line (trimmed to 160 chars) when present; `storyId` set.
- `attention/*.md` → kind `attention`, ts = file mtime ISO, text = `"needs you: <filename>"`.
- Sort by ts desc (string compare works for ISO), slice to limit.

- [ ] **Step 1: Write `test/activity.test.mjs`** — build a temp workspace fixture in the test (mkdtemp): a `ticks.ndjson` with a spawn line, a human line, and one garbage line; one story file with a rejected attempt (`- What failed: merge conflict in lib/calc.sh …`) and an approved attempt; one attention file. Assert: garbage skipped; rejected event has `storyId` + reason substring `merge conflict`; newest-first ordering; `limit` respected; missing dirs → `[]` (point at an empty mkdtemp).
- [ ] **Step 2:** `node --test test/activity.test.mjs` → FAIL (module missing).
- [ ] **Step 3:** Implement (reuse `parseFrontmatter` from `state-files.cjs` for ledger files; regex `^### Attempt (\d+) — ([a-z ]+) \(([^)]+)\)$` per line, multiline scan of body).
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(plugin): activity feed builder`.

### Task 2: chat session lib

**Files:** Create `poltergeist-plugin/src/lib/chat.cjs`, `poltergeist-plugin/test/chat.test.mjs`

**Interfaces — Produces:**

```js
// createChat({ dataDir, runClaude }) where
//   runClaude(args: string[], cwd: string, timeoutMs: number) → Promise<{code, stdout, stderr}>
// returns {
//   send(wsPath, text, model) → Promise<{answer: string}>   // throws Error with useful message on failure
//   history(wsPath) → Message[]        // {role: 'user'|'assistant'|'error', text, ts}
//   reset(wsPath) → void
// }
```

Behavior:
- Slug for storage: wsPath basename sanitized `[^a-z0-9-]` → `-`.
- `send`: reject if a send is already in-flight for this wsPath (`the spirits are still deliberating`). Build args: `['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions', '--model', model]`; if a session id exists for wsPath add `['--resume', sessionId]`. First-message prompt = `'Invoke the seance-concierge skill. You are being used as a chat interface inside Poltergeist. ' + text`; later messages = text verbatim.
- On `code === 0`: parse stdout JSON → `{session_id, result}`; store session id (`dataDir/chat-sessions.json`), append user+assistant messages to transcript (`dataDir/chat/<slug>.json`), return `{answer: result}`. Unparseable stdout → treat as error.
- On non-zero code / timeout: append user + error message (stderr tail, 300 chars) to transcript, throw.
- Timestamps via `new Date().toISOString()`.

- [ ] **Step 1: Write `test/chat.test.mjs`** with a fake `runClaude` capturing args: first send has no `--resume` and prompt starts with `Invoke the seance-concierge skill`; fake returns `{code:0, stdout: JSON.stringify({session_id:'s1', result:'hello'})}` → answer `hello`, second send includes `['--resume','s1']` and prompt is the raw text; history has 4 messages in order; `reset` then send → no `--resume`; failure path (`code:1, stderr:'rate limit'`) → throws with `rate limit`, history gains an `error` message; concurrent send while first unresolved → rejects with `deliberating`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(plugin): chat session lib (claude -p --resume bookkeeping)`.

### Task 3: wire IPC handlers in main.cjs

**Files:** Modify `poltergeist-plugin/src/main.cjs`

**Interfaces — Produces (channels, all behind `assertWorkspace`):**
- `activity(wsPath, limit?)` → `buildActivity(ws, limit ?? 100)`
- `agents:list(wsPath)` → registry entries from `state/agents/` (source `live`, `alive` via `pidAlive`) + `journal/agents/` (source `reaped`, `alive: false`), newest `startedAt` first, plus pseudo-agents `{id:'manager'}` / `{id:'heartbeat'}` when their log files exist.
- `log:read(wsPath, agentId, fromByte?)` → validate `^[\w.-]+$`; map `manager`→`logs/manager.log`, `heartbeat`→`logs/heartbeat-plugin.log`, else `logs/<agentId>.log`; open + read from `fromByte` (default 0), return `{chunk, nextByte: fromByte+bytesRead, size}`; missing → `{chunk:'', nextByte:0, size:0}`. Cap single chunk at 256 KiB (tail: if `size - fromByte > cap` and `fromByte === 0`, start at `size - cap`).
- `chat:send(wsPath, text)` → `chatApi.send(ws, text, ctx.settings.get('chatModel') ?? 'sonnet')`
- `chat:history(wsPath)` / `chat:reset(wsPath)`
- `runClaude` real impl: `execFile('claude', args, {cwd, timeout, maxBuffer: 10*1024*1024})` wrapped to resolve (never reject) with `{code, stdout, stderr}`.

- [ ] **Step 1:** Implement all handlers (`createChat` instantiated in `activate` with `ctx.dataDir`).
- [ ] **Step 2: Smoke without Poltergeist** (fakeCtx as in the Task-7 smoke of the plugin-system plan): `activity` on `~/seance/sandbox` returns events including REQ-3 verdicts; `agents:list` includes `manager` pseudo-agent; `log:read(ws,'manager',0)` returns a non-empty chunk and sane `nextByte`; `log:read` with `agentId: '../x'` throws.
- [ ] **Step 3:** Commit `feat(plugin): activity, agent log, and chat IPC`.

### Task 4: renderer tabs + views

**Files:** Modify `poltergeist-plugin/src/renderer.jsx`

- Tab bar under the header: `board | under the hood | chat` (state `tab`). Board = existing JSX unchanged.
- **UnderTheHood view:** left column = feed from `api.ipc.invoke('activity', ws)` (icon per kind: reuse text glyphs — `⚡ spawn`, `✓ approved`, `✗ rejected`, `☠ died`, `⚠ attention`, `☺ human`), relative time, refreshed on the existing `changed` subscription + 15s interval; clicking an event with `agentId`, or an entry in a top strip of agents from `agents:list` (name, role, alive dot), selects it. Right pane: `<pre>` log tail — on select, `log:read(ws, id, 0)` then every 2s `log:read(ws, id, nextByte)` appending; auto-scroll to bottom unless the user scrolled up (track via onScroll: `atBottom = scrollHeight - scrollTop - clientHeight < 40`); stop polling on deselect/unmount/tab switch.
- **Chat view:** load `chat:history` on mount; bubbles (user right-aligned vellum, assistant left fog, error oxblood-tinted) rendering paragraphs + `` `code` `` spans + `- ` lists (tiny renderer, no dependency); input row (Enter sends, shift-enter newline); pending state disables input and shows "consulting the spirits…"; starter chips when transcript empty: `what's happening right now?` / `why was the last story rejected?` / `what needs me?` (click = send); "new séance" button → `chat:reset` + clear.
- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `node build.mjs` → dist builds; `node -e "import('./dist/renderer.mjs').then(m=>console.log(typeof m.mount))"` → `function`.
- [ ] **Step 3:** Commit `feat(plugin): under-the-hood and chat tabs`.

### Task 5: concierge skill edit + live verification + ship

**Files:** Modify `skills/seance-concierge/SKILL.md`; rebuilt `poltergeist-plugin/dist/*`

- [ ] **Step 1:** Append section to the concierge skill:

```markdown
## Headless / chat invocation

You may be invoked non-interactively behind a chat UI (the Poltergeist Séance
plugin). In that mode:
- Answer in concise markdown; short paragraphs and lists, no tables.
- Never use interactive prompts or tell the user to run commands in this chat.
- Asked about a running agent: read the tail of `logs/<agent-id>.log` and
  summarize what it is doing right now.
- End every status answer with the single most useful next action.
```

- [ ] **Step 2:** `node --test test/` all green; `node build.mjs`; commit `feat: concierge headless chat mode + rebuilt plugin dist`.
- [ ] **Step 3: Live verification** (Poltergeist dev app already running, or relaunch `npm run dev` in ghost-brain/desktop): Plugins → uninstall séance → install from folder `~/development/nikrich/seance/poltergeist-plugin`. Checks: (a) under-the-hood feed shows REQ-3's rejected/approved history with reasons; (b) drill into the critic agent log renders stdout; (c) chat "why did REQ-2-s2 take two attempts?" → answer cites the merge conflict from the ledger; (d) follow-up "and what merged after that?" → proves `--resume` continuity. Fix inline anything that breaks; rebuild + amend the dist commit if needed.
- [ ] **Step 4:** Push seance `main`.

## Self-review notes

- Spec coverage: activity lib (T1), chat lib + sessions + errors (T2), IPC incl. log tail cap + validation (T3), tabs/feed/drill-in/chat UI + chips + reset (T4), skill edit + live checks + push (T5). Out-of-scope items untouched.
- Type consistency: `Event`, `Message`, `runClaude` signatures defined once (T1/T2) and consumed by name in T3/T4.
- Log-tail cap detail: first read of a huge log starts at `size - 256KiB` — documented in T3 so the UI never freezes on a megabyte log.
