# Autonomous Feature Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two-touchpoint feature autonomy: séance drafts a spec the user approves in the plugin, builds on a per-requirement feature branch answering its own context questions (vault → mempalace → human), and ends in one PR to main.

**Architecture:** Plugin side (tasks 1–4): workspace scaffolding writes `.mcp.json`; `state-files.cjs` learns questions + spec/feature-PR fields and gains `answerQuestion`/`writeSpec`; three new IPC handlers; a "waiting on you" strip on the board. Skills side (tasks 5–7): a shared knowledge-chain section, question lifecycle + spec gate in the manager/planner, and the `feature-pr` integration mode across planner/builder/critic. Spec: `docs/superpowers/specs/2026-07-09-autonomous-feature-flow-design.md`.

**Tech Stack:** Node CJS (plugin main), React 19 (renderer, esbuild), `node --test`, markdown skills.

## Global Constraints

- Repo `~/development/nikrich/seance`, branch `feat/autonomous-feature-flow` (from up-to-date main). Plugin paths relative to `poltergeist-plugin/`.
- `npm test` and `npm run build` pass at every commit; `dist/` is rebuilt and committed ONLY in Task 4 (final plugin task).
- Question/attention file-name rule (exact): `/^[\w][\w.\- ]*$/` and no `'..'`. Requirement-id rule (exact, existing `REQ_ID_RE`): `/^[A-Z][A-Z0-9-]{1,31}$/`.
- All user actions that add work wake the heartbeat via the existing `wakeHeartbeat(ctx, ws)`.
- Renderer: theme tokens from `useTheme(api)` only; `'#0E0F12'` allowed for text-on-neon.
- Never overwrite an existing `.mcp.json`.
- Skills edits keep each skill's existing voice and section numbering style; the knowledge-chain block must be verbatim-identical in planner/builder/critic.
- Requirement statuses (exact strings): `inbox`, `speccing`, `spec_review`, `planning`, `planned`, `done`.

---

### Task 1: `.mcp.json` scaffolding

**Files:**
- Modify: `poltergeist-plugin/src/lib/workspace.cjs`
- Modify: `poltergeist-plugin/test/workspace.test.mjs`

**Interfaces:**
- Consumes: existing `scaffoldWorkspace`, `CONTRACT_DIRS`.
- Produces: `ensureMcpConfig(wsPath) -> boolean` (true if it wrote the file; exported), called inside `scaffoldWorkspace` after the config write. Task 3 calls `ensureMcpConfig` from the `workspace:config:write` handler.

- [ ] **Step 1: Write the failing tests** (append to `test/workspace.test.mjs`; `readFileSync` is already imported there):

```js
test('scaffoldWorkspace: writes .mcp.json registering the poltergeist MCP server', async () => {
  const { root, seanceRepo } = tmpSetup();
  const { runGit } = fakeGit();
  const { wsPath } = await scaffoldWorkspace({ root, name: 'proj', config: MODEL(), seanceRepo, runGit });
  const mcp = JSON.parse(readFileSync(join(wsPath, '.mcp.json'), 'utf-8'));
  assert.equal(mcp.mcpServers.poltergeist.command, 'ghostbrain-mcp');
});

test('ensureMcpConfig: never overwrites an existing .mcp.json', async () => {
  const { root, seanceRepo } = tmpSetup();
  const { runGit } = fakeGit();
  const { wsPath } = await scaffoldWorkspace({ root, name: 'proj', config: MODEL(), seanceRepo, runGit });
  writeFileSync(join(wsPath, '.mcp.json'), '{"custom":true}');
  assert.equal(ensureMcpConfig(wsPath), false);
  assert.equal(readFileSync(join(wsPath, '.mcp.json'), 'utf-8'), '{"custom":true}');
});
```

Add `ensureMcpConfig` to the require line at the top of the test file.

- [ ] **Step 2: Run to verify failure**

Run: `cd poltergeist-plugin && npm test` — Expected: FAIL, `ensureMcpConfig is not a function`.

- [ ] **Step 3: Implement** (in `workspace.cjs`, before `scaffoldWorkspace`; add to `module.exports`):

```js
// Registers the Poltergeist vault MCP server for every claude agent spawned
// in this workspace (project-scoped .mcp.json). `ghostbrain-mcp` resolves
// from PATH at agent runtime; if it isn't installed the agents' knowledge
// chain treats the failed connection as "no answer" and moves on.
function ensureMcpConfig(wsPath) {
  const file = join(wsPath, '.mcp.json');
  if (existsSync(file)) return false;
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { poltergeist: { command: 'ghostbrain-mcp', args: [] } } }, null, 2) + '\n',
  );
  return true;
}
```

In `scaffoldWorkspace`, after the `config.yaml` write line, add: `ensureMcpConfig(wsPath);`

- [ ] **Step 4: Verify green**

Run: `cd poltergeist-plugin && npm test` — Expected: all pass (31).

- [ ] **Step 5: Commit**

```bash
git add poltergeist-plugin/src/lib/workspace.cjs poltergeist-plugin/test/workspace.test.mjs
git commit -m "feat(plugin): scaffold .mcp.json so workspace agents reach the vault"
```

---

### Task 2: Questions + spec state (`state-files.cjs`)

**Files:**
- Modify: `poltergeist-plugin/src/lib/state-files.cjs`
- Modify: `poltergeist-plugin/test/state-files.test.mjs`

**Interfaces:**
- Consumes: existing `parseFrontmatter`, `readWorkspaceStatus`, the name-validation idiom from `dismissAttention`.
- Produces (Task 3 depends on exact names):
  - `readWorkspaceStatus` result gains `questions: [{file, id, story, requirement, question}]` (open questions only, from `questions/*.md`, `status: open`, `question` = body text under `## Question` up to `## Answer`), and each entry in `requirements` gains `spec` (text of the `## Spec` section, `''` if absent) and `featurePr` (frontmatter `feature_pr`, `null` if absent).
  - `answerQuestion(wsPath, file, text)` — validates file name (Global Constraints rule), requires the file exists in `questions/` with `status: open`; rewrites `status: open` → `status: answered` and appends `\n## Answer\n\n<text>\n`; throws `invalid question file` / `question not found` / `question already answered`.
  - `writeSpec(wsPath, reqId, specText, opts)` — `opts = {mode: 'approve'} | {mode: 'revise', feedback}`. Validates `reqId` against `/^[A-Z][A-Z0-9-]{1,31}$/` and file existence. Replaces the `## Spec` section body with `specText` (creates the section at the end if absent). `approve`: set frontmatter `status: planning` and add `spec_approved_at: <ISO>`; `revise`: set `status: speccing` and append `\n## Spec feedback (<ISO>)\n\n<feedback>\n`.

- [ ] **Step 1: Write the failing tests** (append to `test/state-files.test.mjs`; import `answerQuestion`, `writeSpec` from the require):

```js
test('readWorkspaceStatus: lists open questions and requirement spec/featurePr fields', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'questions'), { recursive: true });
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  writeFileSync(
    join(ws, 'questions', 'REQ-7-s2-naming.md'),
    '---\nid: REQ-7-s2-naming\nstory: REQ-7-s2\nrequirement: REQ-7\nstatus: open\nasked_at: 2026-07-09T10:00:00Z\n---\n## Question\n\nTabs or spaces for the config?\n\n## Answer\n',
  );
  writeFileSync(
    join(ws, 'questions', 'REQ-7-s1-done.md'),
    '---\nid: REQ-7-s1-done\nstory: REQ-7-s1\nrequirement: REQ-7\nstatus: answered\nasked_at: 2026-07-09T09:00:00Z\n---\n## Question\n\nx?\n\n## Answer\n\nyes\n',
  );
  writeFileSync(
    join(ws, 'state/requirements/REQ-7.md'),
    '---\nid: REQ-7\ntitle: Thing\nstatus: spec_review\npriority: normal\nfeature_pr: https://github.com/x/y/pull/9\n---\nbody\n\n## Spec\n\nGoal: do the thing.\n',
  );
  const snap = readWorkspaceStatus(ws);
  assert.equal(snap.questions.length, 1);
  assert.equal(snap.questions[0].story, 'REQ-7-s2');
  assert.match(snap.questions[0].question, /Tabs or spaces/);
  const req = snap.requirements.find((r) => r.id === 'REQ-7');
  assert.match(req.spec, /Goal: do the thing/);
  assert.equal(req.featurePr, 'https://github.com/x/y/pull/9');
  assert.equal(req.status, 'spec_review');
});

test('answerQuestion: answers exactly once, validates names', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'questions'), { recursive: true });
  const f = 'REQ-7-s2-naming.md';
  writeFileSync(join(ws, 'questions', f), '---\nid: q\nstory: REQ-7-s2\nrequirement: REQ-7\nstatus: open\n---\n## Question\n\nx?\n');
  answerQuestion(ws, f, 'spaces, always');
  const text = readFileSync(join(ws, 'questions', f), 'utf-8');
  assert.match(text, /status: answered/);
  assert.match(text, /## Answer\n\nspaces, always/);
  assert.throws(() => answerQuestion(ws, f, 'again'), /already answered/);
  assert.throws(() => answerQuestion(ws, '../evil.md', 'x'), /invalid question file/);
  assert.throws(() => answerQuestion(ws, 'nope.md', 'x'), /not found/);
});

test('writeSpec: approve and revise transitions', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-8.md'),
    '---\nid: REQ-8\ntitle: T\nstatus: spec_review\npriority: normal\n---\nbody\n\n## Spec\n\nold spec\n',
  );
  writeSpec(ws, 'REQ-8', 'new approved spec', { mode: 'approve' });
  let text = readFileSync(join(ws, 'state/requirements/REQ-8.md'), 'utf-8');
  assert.match(text, /status: planning/);
  assert.match(text, /spec_approved_at: /);
  assert.match(text, /## Spec\n\nnew approved spec/);
  assert.ok(!text.includes('old spec'));

  writeSpec(ws, 'REQ-8', 'tweaked spec', { mode: 'revise', feedback: 'tighter scope please' });
  text = readFileSync(join(ws, 'state/requirements/REQ-8.md'), 'utf-8');
  assert.match(text, /status: speccing/);
  assert.match(text, /## Spec feedback \(.*\)\n\ntighter scope please/);
  assert.throws(() => writeSpec(ws, 'bad id!', 'x', { mode: 'approve' }), /invalid requirement id/);
  assert.throws(() => writeSpec(ws, 'REQ-99', 'x', { mode: 'approve' }), /not found/);
});
```

- [ ] **Step 2: Run to verify failure** — `npm test`, Expected: FAIL on missing exports.

- [ ] **Step 3: Implement** in `state-files.cjs` (before `module.exports`; extend exports):

```js
const QUESTION_NAME_RE = /^[\w][\w.\- ]*$/;
const REQ_ID_RE = /^[A-Z][A-Z0-9-]{1,31}$/;

function specSection(body) {
  // stops at the next h2 (## Answer, ## Spec feedback, …) but not at the
  // spec's own ### subheadings
  const m = body.match(/## Spec\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1].trim() : '';
}

function readQuestions(wsPath) {
  const dir = join(wsPath, 'questions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const { attrs, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf-8'));
      const q = body.match(/## Question\n([\s\S]*?)(?=\n## Answer|$)/);
      return {
        file: f,
        id: String(attrs.id ?? f.replace(/\.md$/, '')),
        story: attrs.story == null ? null : String(attrs.story),
        requirement: attrs.requirement == null ? null : String(attrs.requirement),
        status: String(attrs.status ?? 'open'),
        question: q ? q[1].trim() : body.trim(),
      };
    })
    .filter((q) => q.status === 'open');
}

function answerQuestion(wsPath, file, text) {
  if (typeof file !== 'string' || !QUESTION_NAME_RE.test(file) || file.includes('..')) {
    throw new Error(`invalid question file: ${file}`);
  }
  const p = join(wsPath, 'questions', file);
  if (!existsSync(p)) throw new Error(`question not found: ${file}`);
  const raw = readFileSync(p, 'utf-8');
  if (!/^status: open$/m.test(raw)) throw new Error(`question already answered: ${file}`);
  const updated = raw.replace(/^status: open$/m, 'status: answered') + `\n## Answer\n\n${text.trim()}\n`;
  writeFileSync(p, updated);
}

function writeSpec(wsPath, reqId, specText, opts) {
  if (typeof reqId !== 'string' || !REQ_ID_RE.test(reqId)) {
    throw new Error(`invalid requirement id: ${reqId}`);
  }
  const p = join(wsPath, 'state', 'requirements', `${reqId}.md`);
  if (!existsSync(p)) throw new Error(`requirement not found: ${reqId}`);
  let raw = readFileSync(p, 'utf-8');
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const spec = `## Spec\n\n${specText.trim()}\n`;
  raw = /## Spec\n/.test(raw)
    ? raw.replace(/## Spec\n[\s\S]*?(?=\n## |$)/, spec)
    : `${raw.trimEnd()}\n\n${spec}`;
  if (opts.mode === 'approve') {
    raw = raw.replace(/^status: .*$/m, 'status: planning');
    if (!/^spec_approved_at: /m.test(raw)) {
      raw = raw.replace(/^status: planning$/m, `status: planning\nspec_approved_at: ${ts}`);
    }
  } else {
    raw = raw.replace(/^status: .*$/m, 'status: speccing');
    raw = `${raw.trimEnd()}\n\n## Spec feedback (${ts})\n\n${String(opts.feedback ?? '').trim()}\n`;
  }
  writeFileSync(p, raw);
}
```

In `readWorkspaceStatus`: extend the `requirements` mapper to also read the raw body — change `readMdDir(...)` mapping to include `spec: specSection(body)` and `featurePr: attrs.feature_pr == null ? null : String(attrs.feature_pr)` (the mapper already receives `{ attrs }`; change its destructuring to `({ attrs, body })`). Add `questions: readQuestions(wsPath)` to the returned object. Export `answerQuestion`, `writeSpec`.

- [ ] **Step 4: Verify green** — `npm test`, all pass.

- [ ] **Step 5: Commit**

```bash
git add poltergeist-plugin/src/lib/state-files.cjs poltergeist-plugin/test/state-files.test.mjs
git commit -m "feat(plugin): questions + spec/feature-pr fields in workspace state"
```

---

### Task 3: IPC handlers

**Files:**
- Modify: `poltergeist-plugin/src/main.cjs`

**Interfaces:**
- Consumes: Task 1's `ensureMcpConfig`, Task 2's `answerQuestion`/`writeSpec`, existing `assertWorkspace`, `wakeHeartbeat`, `REQ_ID_RE`.
- Produces IPC (Task 4 depends on exact names): `question:answer (ws, file, text) -> {ok}`, `spec:approve (ws, reqId, specText) -> {ok}`, `spec:revise (ws, reqId, specText, feedback) -> {ok}`. `workspace:config:write` additionally calls `ensureMcpConfig(ws)`.

- [ ] **Step 1: Implement.** Extend the state-files require in `main.cjs` with `answerQuestion, writeSpec`; extend the workspace require with `ensureMcpConfig`. Add next to `attention:dismiss`:

```js
  ctx.ipc.handle('question:answer', (wsPath, file, text) => {
    const ws = assertWorkspace(wsPath);
    if (typeof text !== 'string' || !text.trim()) throw new Error('answer required');
    answerQuestion(ws, file, text);
    wakeHeartbeat(ctx, ws);
    return { ok: true };
  });

  ctx.ipc.handle('spec:approve', (wsPath, reqId, specText) => {
    const ws = assertWorkspace(wsPath);
    if (typeof specText !== 'string' || !specText.trim()) throw new Error('spec text required');
    writeSpec(ws, reqId, specText, { mode: 'approve' });
    wakeHeartbeat(ctx, ws);
    return { ok: true };
  });

  ctx.ipc.handle('spec:revise', (wsPath, reqId, specText, feedback) => {
    const ws = assertWorkspace(wsPath);
    if (typeof feedback !== 'string' || !feedback.trim()) throw new Error('feedback required');
    writeSpec(ws, reqId, String(specText ?? ''), { mode: 'revise', feedback });
    wakeHeartbeat(ctx, ws);
    return { ok: true };
  });
```

In the `workspace:config:write` handler, after the `writeFileSync(... configToYaml ...)` line, add: `ensureMcpConfig(ws);`

- [ ] **Step 2: Verify** — `cd poltergeist-plugin && npm test && npm run build`, both clean.

- [ ] **Step 3: Commit**

```bash
git add poltergeist-plugin/src/main.cjs
git commit -m "feat(plugin): question:answer + spec:approve/revise IPC; ensure .mcp.json on save"
```

---

### Task 4: Renderer — "waiting on you" strip (+ 0.4.0 dist)

**Files:**
- Modify: `poltergeist-plugin/src/renderer.jsx`
- Modify: `poltergeist-plugin/manifest.json` (→ `0.4.0`)
- Modify: `poltergeist-plugin/dist/*` (rebuild, committed here)
- Test: harness at `<scratchpad>/seance-verify/` (mock + screenshot)

**Interfaces:**
- Consumes: Task 3 IPC; `snap.questions`, `requirements[].{status,spec,featurePr,title}` from Task 2; existing `Panel`, `Btn`, `Eyebrow`, `Pill`, `act`, `wakeHeartbeat` semantics; lucide icons already imported (`Check`, `X`, `Sparkles`, `MessageSquare`, `GitBranch`, `AlertTriangle`).
- Produces: UI only.

- [ ] **Step 1: Add the strip component** (after `HeartbeatBanner` in `renderer.jsx`):

```jsx
// ---- waiting on you: spec reviews, questions, feature PRs ----------------

function SpecReviewCard({ theme, api, ws, act, req }) {
  const [text, setText] = useState(req.spec);
  const [feedback, setFeedback] = useState('');
  useEffect(() => setText(req.spec), [req.id, req.spec]);
  const field = {
    fontFamily: theme.fontMono, fontSize: 12, lineHeight: 1.55, color: theme.ink0,
    background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
    padding: '9px 11px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  return (
    <Panel theme={theme} title={`spec review — ${req.id}`} subtitle={req.title}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <textarea rows={10} style={{ ...field, resize: 'vertical', minHeight: 140 }}
          value={text} onChange={(e) => setText(e.target.value)} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center' }}>
          <input style={{ ...field, fontFamily: 'inherit', fontSize: 12.5 }}
            placeholder="feedback for the planner (required to request changes)"
            value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <Btn theme={theme} variant="ghost" disabled={!feedback.trim()}
            onClick={() => act(() => api.ipc.invoke('spec:revise', ws, req.id, text, feedback))}>
            request changes
          </Btn>
          <Btn theme={theme} variant="primary" icon={<Check size={13} />} disabled={!text.trim()}
            onClick={() => act(() => api.ipc.invoke('spec:approve', ws, req.id, text))}>
            approve spec
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

function QuestionCard({ theme, api, ws, act, q }) {
  const [answer, setAnswer] = useState('');
  return (
    <Panel theme={theme} title={`the séance asks — ${q.story ?? q.requirement}`} subtitle={q.file}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, color: theme.ink1, maxHeight: 180, overflowY: 'auto' }}>{q.question}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            style={{
              flex: 1, fontFamily: 'inherit', fontSize: 12.5, color: theme.ink0,
              background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
              padding: '9px 11px', outline: 'none',
            }}
            placeholder="your answer — unblocks the story on the next tick"
            value={answer} onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && answer.trim()) {
                void act(() => api.ipc.invoke('question:answer', ws, q.file, answer));
              }
            }}
          />
          <Btn theme={theme} variant="primary" disabled={!answer.trim()}
            onClick={() => act(() => api.ipc.invoke('question:answer', ws, q.file, answer))}>
            answer
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

function WaitingOnYou({ theme, api, ws, act, snap }) {
  const specs = (snap?.requirements ?? []).filter((r) => r.status === 'spec_review');
  const questions = snap?.questions ?? [];
  const prs = (snap?.requirements ?? []).filter((r) => r.featurePr && r.status === 'done');
  const count = specs.length + questions.length + prs.length;
  if (count === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={12} color={theme.neon} />
        <Eyebrow theme={theme}>waiting on you · {count}</Eyebrow>
      </div>
      {specs.map((r) => <SpecReviewCard key={r.id} theme={theme} api={api} ws={ws} act={act} req={r} />)}
      {questions.map((q) => <QuestionCard key={q.file} theme={theme} api={api} ws={ws} act={act} q={q} />)}
      {prs.map((r) => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: theme.neonMist, border: `1px solid ${theme.neon}`,
          borderRadius: theme.rMd, padding: '10px 13px', fontSize: 12.5,
        }}>
          <GitBranch size={14} color={theme.neonInk} />
          <span style={{ color: theme.ink0, fontWeight: 600 }}>{r.id}</span>
          <span style={{ color: theme.ink1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title} — feature complete, one PR awaits your merge</span>
          <Btn theme={theme} variant="ghost" onClick={() => api.openExternal(r.featurePr)}>open PR</Btn>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Mount it in `Board`** — directly under the `HeartbeatBanner` block (before the attention strip):

```jsx
      <WaitingOnYou theme={theme} api={api} ws={ws} act={act} snap={snap} />
```

- [ ] **Step 3: Build + harness.** `npm test && npm run build`. In the harness (`<scratchpad>/seance-verify/harness.html`): add to the live-state snap — `questions: [{ file: 'REQ-53-s1-api.md', id: 'q1', story: 'REQ-53-s1', requirement: 'REQ-53', question: 'The registry exposes both name and id — which should the install key be?' }]` and `requirements: [{ id: 'REQ-53', title: 'in-app marketplace', status: 'spec_review', spec: 'Goal: marketplace tab.\n\nScope: search, install, update.\n\nAcceptance: install from registry works offline-tolerant.', featurePr: null }, { id: 'REQ-50', title: 'observability pass', status: 'done', spec: '', featurePr: 'https://github.com/nikrich/poltergeist/pull/99' }]`; add mock cases `'question:answer'`, `'spec:approve'`, `'spec:revise'` → `null`. Copy fresh `renderer.mjs`, run `node shoot.mjs` and `node lifecycle.mjs` — both must end clean. Read `1-board-live.png` and eyeball: three card types render, styled, nothing clipped.

- [ ] **Step 4: Bump + final build + commit**

```bash
# manifest.json: "version": "0.3.3" -> "0.4.0"
cd poltergeist-plugin && npm test && npm run build && cd ..
git add poltergeist-plugin/src/renderer.jsx poltergeist-plugin/manifest.json poltergeist-plugin/dist
git commit -m "feat(plugin): waiting-on-you strip — spec review, questions, feature PRs (0.4.0)"
```

---

### Task 5: Skills — knowledge chain + question lifecycle

**Files:**
- Modify: `skills/seance-planner/SKILL.md`, `skills/seance-builder/SKILL.md`, `skills/seance-critic/SKILL.md` (identical new section)
- Modify: `skills/seance-manager/SKILL.md` (question lifecycle)

**Interfaces:**
- Consumes: the `questions/` file contract from the spec (§2) — must match Task 2's parser exactly (frontmatter keys `id, story, requirement, status, asked_at`; `## Question` / `## Answer` sections).
- Produces: the escalation contract Task 6/7 skills reference by name ("the knowledge chain").

- [ ] **Step 1: Add the shared section** — verbatim, to planner, builder, and critic SKILL.md files (after their "Iron rules"/constraints section):

```markdown
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
```

- [ ] **Step 2: Manager — question lifecycle.** In `skills/seance-manager/SKILL.md`: add to the state-files list (§ Inputs): `questions/*.md` with the frontmatter above. Insert a new tick step between "reap" and "terminal states" (renumber nothing — use "### 4b. Process answered questions"):

```markdown
### 4b. Process answered questions

For each `questions/*.md` with `status: answered`:

- If it names a `story`: append to that story's `## Attempts ledger`:
  `### Question answered (<ts>)` followed by the full question and answer
  text. If the story's status is `pending` (it exited waiting on this
  question), also reset `attempts: 0` so it spawns immediately; a `building`
  story just gets the ledger entry — its current attempt finishes first.
- Move the file to `questions/answered/` (create the dir if needed).

A story referenced by any `status: open` question is NOT eligible to spawn
(add this to the builder-eligibility rule in step 6).
```

And in the builder-eligibility bullet (step "Spawn builders"), extend the eligibility line: `…, and no questions/*.md with status: open names the story.`

- [ ] **Step 3: Verify + commit.** Skills are prose — verify by grep that the chain section appears identically 3× and the manager bullets exist:

```bash
grep -c "The knowledge chain" skills/seance-planner/SKILL.md skills/seance-builder/SKILL.md skills/seance-critic/SKILL.md   # 1 each
grep -n "Process answered questions" skills/seance-manager/SKILL.md
git add skills && git commit -m "feat(skills): vault→mempalace→human knowledge chain + question lifecycle"
```

---

### Task 6: Skills — spec gate

**Files:**
- Modify: `skills/seance-manager/SKILL.md`
- Modify: `skills/seance-planner/SKILL.md`

**Interfaces:**
- Consumes: requirement statuses (Global Constraints), `writeSpec`-compatible file shape (`## Spec` section, `## Spec feedback (<ts>)` blocks), the knowledge chain (Task 5).
- Produces: two planner phases the manager routes by status.

- [ ] **Step 1: Manager routing.** In `skills/seance-manager/SKILL.md`:
  - Requirement frontmatter doc line: extend status enum to `inbox|speccing|spec_review|planning|planned|done`.
  - Inbox-drain step: draining a requirement now sets `status: speccing` (was `planning` via spawn step) — update the text.
  - Spawn-planner step: replace the trigger with:

```markdown
If live planners < `max_planner`, spawn for the highest-priority eligible
requirement, choosing the prompt by status:

- `status: speccing` (and no `blocked_reason`) → prompt
  `"Invoke the seance-planner skill to DRAFT THE SPEC for requirement <id>."`
- `status: planning` (spec approved by the human) → prompt
  `"Invoke the seance-planner skill to DECOMPOSE requirement <id> per its approved spec."`

`spec_review` requirements are waiting on the human — never spawn for them.
```

- [ ] **Step 2: Planner phases.** In `skills/seance-planner/SKILL.md`, add before the existing decomposition procedure:

```markdown
## Phase A — draft the spec (when invoked to DRAFT THE SPEC)

1. Research before writing: read the requirement body, the relevant code,
   and run the knowledge chain (vault first) for product intent and prior
   decisions. Check `state/requirements/` for non-done requirements that
   substantially overlap this one — overlap goes in the spec's
   `### Conflicts` section, not into duplicate planning.
2. Write a `## Spec` section into `state/requirements/<id>.md`:
   `### Goal` (2-3 sentences), `### Scope` (in / out bullets),
   `### Acceptance criteria` (testable bullets), `### UI placement` (when
   UI is involved), `### Open questions` (anything the knowledge chain
   could not answer — these are for the human at review time),
   `### Conflicts` (overlapping requirements, if any).
   If the file has `## Spec feedback (<ts>)` blocks, treat the newest as
   review notes on your previous draft and address them.
3. Set requirement `status: spec_review`. Exit — the human approves or
   requests changes in Poltergeist.

## Phase B — decompose (when invoked to DECOMPOSE)

Decompose from the approved `## Spec` — it supersedes the raw requirement
body wherever they differ. Everything below (stories, oracles, deps) is
unchanged.
```

- [ ] **Step 3: Verify + commit**

```bash
grep -n "Phase A — draft the spec" skills/seance-planner/SKILL.md
grep -n "DRAFT THE SPEC" skills/seance-manager/SKILL.md
git add skills && git commit -m "feat(skills): spec gate — planner drafts, human approves in Poltergeist"
```

---

### Task 7: Skills — `feature-pr` integration mode

**Files:**
- Modify: `skills/seance-planner/SKILL.md`, `skills/seance-builder/SKILL.md`, `skills/seance-critic/SKILL.md`, `skills/seance-manager/SKILL.md`
- Modify: `templates/config.yaml`

**Interfaces:**
- Consumes: requirement frontmatter `feature_branch` / `feature_pr`; existing `integration: merge|pr` docs; Task 6 phases.
- Produces: the complete `feature-pr` lifecycle.

- [ ] **Step 1: templates/config.yaml** — extend the integration comment:

```yaml
    # integration: how approved stories land.
    #   merge      — critic merges --no-ff into default_branch (local/unprotected repos)
    #   pr         — critic opens a PR per story (protected repos, max human control)
    #   feature-pr — RECOMMENDED for feature autonomy: stories merge automatically
    #                into a per-requirement branch (seance/<req-id>); ONE PR to
    #                default_branch when the whole requirement is done.
```

- [ ] **Step 2: Planner (Phase B, feature-pr repos).** Append to Phase B:

```markdown
If every repo this requirement touches has `integration: feature-pr`:
create the feature branch once, before writing stories —
`git -C repos/<repo> branch "seance/<req-id>" "<default_branch>" && git -C repos/<repo> push -u origin "seance/<req-id>"`
(skip push for local-only repos) — and record `feature_branch: seance/<req-id>`
in the requirement frontmatter. Stories inherit it implicitly.
```

- [ ] **Step 3: Builder.** In the worktree-setup step, before the existing `worktree add`:

```markdown
If your story's requirement has `feature_branch` in its frontmatter
(feature-pr mode), use that branch as the base instead of
`<default_branch>` — everywhere `<default_branch>` appears in this step and
in retry rebases. Same-requirement deps that are `merged` are already in the
feature branch; step 1b (merging pr_open dep branches) then applies only to
cross-requirement deps.
```

- [ ] **Step 4: Critic.** In the APPROVE integration list, add:

```markdown
- `feature-pr`: merge `--no-ff` into the requirement's `feature_branch` and
  push it; story `status: merged` (merged-to-feature). Then, if EVERY story
  of the requirement now has `status: merged`:
  `gh pr create --fill --base <default_branch> --head <feature_branch>`,
  record the URL as `feature_pr:` in the requirement frontmatter, and set
  the requirement `status: done` (the human merges the PR).
  Conflicts merging into the feature branch: REJECT with report
  "rebase onto <feature_branch> and resolve conflicts in <files>", exactly
  like the default_branch conflict rule.
```

- [ ] **Step 5: Manager.** Requirement-done rule (tick step 4/terminal states): qualify it —

```markdown
- (integration `merge`/`pr` repos) Any requirement whose stories all have
  status `merged` or `pr_open` → set requirement `done`.
- (feature-pr repos) the critic sets the requirement `done` when it opens
  the feature PR — do not mark it done on story statuses alone.
```

- [ ] **Step 6: Verify + commit**

```bash
grep -n "feature-pr" templates/config.yaml skills/seance-planner/SKILL.md skills/seance-builder/SKILL.md skills/seance-critic/SKILL.md skills/seance-manager/SKILL.md | wc -l   # >= 5
git add skills templates && git commit -m "feat(skills): feature-pr mode — autonomous story merges, one PR per feature"
```

---

### Task 8: Ship

**Files:** none new (PR + marketplace).

- [ ] **Step 1:** Final full check: `cd poltergeist-plugin && npm test && npm run build` (clean), harness `shoot.mjs` + `lifecycle.mjs` (clean).
- [ ] **Step 2:** Push branch; `gh pr create` (summary per repo convention: what/why + test plan + Claude Code footer); `gh pr merge --squash --delete-branch`; sync local main.
- [ ] **Step 3:** Marketplace: `npm run build && npx wrangler deploy` in poltergeist-plugins; verify live registry shows 0.4.0.
- [ ] **Step 4:** Report the rollout step that stays manual: dry-run a toy requirement in the sandbox workspace (spec → approve → feature branch → one PR) before flipping the poltergeist workspace repo to `integration: feature-pr`.
