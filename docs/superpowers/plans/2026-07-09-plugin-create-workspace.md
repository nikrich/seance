# Plugin Create/Edit Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create and edit Séance workspaces (dirs, config.yaml, skills symlink, repo clones) entirely from the Poltergeist plugin UI.

**Architecture:** A new `src/lib/workspace.cjs` module owns config round-trip (via the `yaml` package), validation, scaffolding, and repo cloning with an injected `runGit` (mirrors `chat.cjs`'s injected `runClaude`). `main.cjs` exposes three IPC handlers. The renderer gains a `WorkspaceForm` used by a new **config** tab (edit mode) and a create view reachable from a "+ new" header button and the no-workspace CTA.

**Tech Stack:** Node (CommonJS main process), `yaml` npm package, React 19 renderer bundled by esbuild, `node --test` for tests.

## Global Constraints

- Repo: `~/development/nikrich/seance`, all paths below relative to `poltergeist-plugin/`.
- Work on branch `feat/plugin-create-workspace` (create from up-to-date `main`).
- The plugin writes ONLY to: `inbox/`, its `dataDir`, and (new) workspace scaffolding + `config.yaml`. Never write other workspace state.
- All spawns that may shell out to user-installed binaries use `env: withClaudePath()` from `src/lib/spawn-env.cjs`.
- Renderer styling: theme tokens from `useTheme(api)` only — no hardcoded colors except `#0E0F12` for text-on-neon (existing convention).
- Clone failures are non-fatal everywhere: record `{name, ok, error}`, never throw.
- `npm test` and `npm run build` must pass at every commit; committed `dist/` is rebuilt in the final task only (keeps intermediate diffs reviewable).
- Workspace/repo name pattern (exact): `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`.

---

### Task 1: Config round-trip + validation (`workspace.cjs` part 1)

**Files:**
- Create: `poltergeist-plugin/src/lib/workspace.cjs`
- Create: `poltergeist-plugin/test/workspace.test.mjs`
- Modify: `poltergeist-plugin/package.json` (add `yaml` dep)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `parseConfig(yamlText) -> model`, `configToYaml(model) -> string`, `validateConfigModel(model) -> string[]`, and exported `NAME_RE` (regex). Model shape:
  `{ workspace, repos: [{name, url, default_branch, integration, test_command}], max_builders, max_critics, max_planner, max_agent_minutes, attempt_cap, models: {manager, planner, builder, critic}, sleep: {active, idle}, extra }`

- [ ] **Step 1: Install the yaml package**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin && npm i yaml
```

(Regular dependency, not dev: it ships inside the bundled `dist/main.cjs` either way, but semantically it's runtime code.)

- [ ] **Step 2: Write the failing tests**

Create `poltergeist-plugin/test/workspace.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseConfig, configToYaml, validateConfigModel } = require('../src/lib/workspace.cjs');

const TEMPLATE = `
workspace: my-workspace
repos:
  example-repo:
    url: git@github.com:you/example-repo.git
    default_branch: main
    integration: pr
    test_command: npm test
max_builders: 3
max_critics: 2
max_planner: 1
max_agent_minutes: 45
attempt_cap: 3
models:
  manager: haiku
  planner: opus
  builder: sonnet
  critic: opus
sleep:
  active: 60
  idle: 600
`;

test('parseConfig: template maps to the form model', () => {
  const m = parseConfig(TEMPLATE);
  assert.equal(m.workspace, 'my-workspace');
  assert.deepEqual(m.repos, [{
    name: 'example-repo',
    url: 'git@github.com:you/example-repo.git',
    default_branch: 'main',
    integration: 'pr',
    test_command: 'npm test',
  }]);
  assert.equal(m.max_builders, 3);
  assert.equal(m.attempt_cap, 3);
  assert.deepEqual(m.models, { manager: 'haiku', planner: 'opus', builder: 'sonnet', critic: 'opus' });
  assert.deepEqual(m.sleep, { active: 60, idle: 600 });
});

test('parseConfig: fills defaults for missing fields', () => {
  const m = parseConfig('workspace: x\nrepos: {}\n');
  assert.deepEqual(m.repos, []);
  assert.equal(m.max_builders, 3);
  assert.deepEqual(m.sleep, { active: 60, idle: 600 });
});

test('round-trip preserves values and unknown top-level keys', () => {
  const m = parseConfig(TEMPLATE + 'custom_key: kept\n');
  assert.deepEqual(m.extra, { custom_key: 'kept' });
  const back = parseConfig(configToYaml(m));
  assert.deepEqual(back.repos, m.repos);
  assert.equal(back.max_agent_minutes, 45);
  assert.deepEqual(back.extra, { custom_key: 'kept' });
});

test('validateConfigModel: accepts a valid model', () => {
  assert.deepEqual(validateConfigModel(parseConfig(TEMPLATE)), []);
});

test('validateConfigModel: rejects broken models', () => {
  const m = parseConfig(TEMPLATE);
  m.repos = [];
  assert.ok(validateConfigModel(m).some((e) => e.includes('at least one repo')));

  const dup = parseConfig(TEMPLATE);
  dup.repos = [dup.repos[0], { ...dup.repos[0] }];
  assert.ok(validateConfigModel(dup).some((e) => e.includes('unique')));

  const bad = parseConfig(TEMPLATE);
  bad.repos[0].integration = 'yolo';
  assert.ok(validateConfigModel(bad).some((e) => e.includes('integration')));

  const neg = parseConfig(TEMPLATE);
  neg.max_builders = 0;
  assert.ok(validateConfigModel(neg).some((e) => e.includes('max_builders')));

  const sleepy = parseConfig(TEMPLATE);
  sleepy.sleep.active = 0;
  assert.ok(validateConfigModel(sleepy).some((e) => e.includes('sleep.active')));
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin && npm test
```

Expected: FAIL with `Cannot find module '../src/lib/workspace.cjs'`.

- [ ] **Step 4: Implement the config functions**

Create `poltergeist-plugin/src/lib/workspace.cjs`:

```js
'use strict';
// Workspace scaffolding + config.yaml round-trip for the Séance plugin.
// Everything effectful takes injected deps (runGit) so tests run on a tmpdir
// with a fake git — same pattern as chat.cjs's injected runClaude.

const { existsSync, mkdirSync, writeFileSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KNOWN_KEYS = [
  'workspace', 'repos', 'max_builders', 'max_critics', 'max_planner',
  'max_agent_minutes', 'attempt_cap', 'models', 'sleep',
];
const DEFAULT_MODELS = { manager: 'haiku', planner: 'opus', builder: 'sonnet', critic: 'opus' };
const DEFAULT_SLEEP = { active: 60, idle: 600 };

function parseConfig(text) {
  const doc = YAML.parse(text) ?? {};
  const repos = Object.entries(doc.repos ?? {}).map(([name, r]) => ({
    name,
    url: r?.url ?? '',
    default_branch: r?.default_branch ?? 'main',
    integration: r?.integration === 'merge' ? 'merge' : 'pr',
    test_command: r?.test_command ?? '',
  }));
  const extra = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!KNOWN_KEYS.includes(k)) extra[k] = v;
  }
  return {
    workspace: doc.workspace ?? '',
    repos,
    max_builders: doc.max_builders ?? 3,
    max_critics: doc.max_critics ?? 2,
    max_planner: doc.max_planner ?? 1,
    max_agent_minutes: doc.max_agent_minutes ?? 45,
    attempt_cap: doc.attempt_cap ?? 3,
    models: { ...DEFAULT_MODELS, ...(doc.models ?? {}) },
    sleep: { ...DEFAULT_SLEEP, ...(doc.sleep ?? {}) },
    extra,
  };
}

function configToYaml(model) {
  const repos = {};
  for (const r of model.repos ?? []) {
    repos[r.name] = {
      url: r.url,
      default_branch: r.default_branch,
      integration: r.integration,
      test_command: r.test_command,
    };
  }
  return YAML.stringify({
    workspace: model.workspace,
    repos,
    max_builders: model.max_builders,
    max_critics: model.max_critics,
    max_planner: model.max_planner,
    max_agent_minutes: model.max_agent_minutes,
    attempt_cap: model.attempt_cap,
    models: model.models,
    sleep: model.sleep,
    ...(model.extra ?? {}),
  });
}

function validateConfigModel(m) {
  if (!m || typeof m !== 'object') return ['config required'];
  const errors = [];
  const repos = Array.isArray(m.repos) ? m.repos : [];
  if (repos.length === 0) errors.push('at least one repo is required');
  for (const r of repos) {
    if (!r?.name || !NAME_RE.test(r.name)) errors.push(`repo name "${r?.name ?? ''}" is invalid`);
    if (!r?.url) errors.push(`repo ${r?.name ?? '?'}: url is required`);
    if (r?.integration !== 'pr' && r?.integration !== 'merge') {
      errors.push(`repo ${r?.name ?? '?'}: integration must be "pr" or "merge"`);
    }
  }
  const names = repos.map((r) => r?.name);
  if (new Set(names).size !== names.length) errors.push('repo names must be unique');
  for (const k of ['max_builders', 'max_critics', 'max_planner', 'max_agent_minutes', 'attempt_cap']) {
    if (!Number.isInteger(m[k]) || m[k] < 1) errors.push(`${k} must be a positive integer`);
  }
  for (const k of ['active', 'idle']) {
    if (!Number.isInteger(m.sleep?.[k]) || m.sleep[k] < 1) errors.push(`sleep.${k} must be a positive integer`);
  }
  return errors;
}

module.exports = { NAME_RE, parseConfig, configToYaml, validateConfigModel };
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin && npm test
```

Expected: all pass (14 existing + 5 new).

- [ ] **Step 6: Commit**

```bash
cd ~/development/nikrich/seance
git add poltergeist-plugin/src/lib/workspace.cjs poltergeist-plugin/test/workspace.test.mjs poltergeist-plugin/package.json poltergeist-plugin/package-lock.json
git commit -m "feat(plugin): config.yaml round-trip + validation for workspace editor"
```

---

### Task 2: Scaffold + repo sync (`workspace.cjs` part 2)

**Files:**
- Modify: `poltergeist-plugin/src/lib/workspace.cjs`
- Modify: `poltergeist-plugin/test/workspace.test.mjs`

**Interfaces:**
- Consumes: Task 1's `configToYaml`, `NAME_RE`.
- Produces: `scaffoldWorkspace({root, name, config, seanceRepo, runGit}) -> Promise<{wsPath, clones}>` and `syncRepos(wsPath, config, runGit) -> Promise<clones>` where `clones = [{name, ok, error?}]` and `runGit(args) -> Promise<{code, stdout, stderr}>`.

- [ ] **Step 1: Write the failing tests**

Append to `poltergeist-plugin/test/workspace.test.mjs` (add `mkdtempSync`, `mkdirSync`, `existsSync`, `readFileSync`, `readlinkSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path` to the imports, and pull `scaffoldWorkspace`, `syncRepos` from the require):

```js
function fakeGit(failFor = []) {
  const calls = [];
  const runGit = async (args) => {
    calls.push(args);
    const dest = args[args.length - 1];
    const name = dest.split('/').pop();
    if (failFor.includes(name)) return { code: 128, stdout: '', stderr: `fatal: could not read from remote (${name})` };
    mkdirSync(dest, { recursive: true }); // simulate a successful clone
    return { code: 0, stdout: '', stderr: '' };
  };
  return { calls, runGit };
}

function tmpSetup() {
  const base = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  const seanceRepo = join(base, 'seance-repo');
  mkdirSync(join(seanceRepo, 'skills'), { recursive: true });
  return { root: join(base, 'seance'), seanceRepo };
}

const MODEL = () => parseConfig(TEMPLATE);

test('scaffoldWorkspace: creates the contract tree, config, skills symlink, clones', async () => {
  const { root, seanceRepo } = tmpSetup();
  const { calls, runGit } = fakeGit();
  const { wsPath, clones } = await scaffoldWorkspace({ root, name: 'proj', config: MODEL(), seanceRepo, runGit });
  assert.equal(wsPath, join(root, 'proj'));
  for (const d of ['inbox/processed', 'state/requirements', 'state/stories', 'state/agents', 'attention', 'journal', 'repos', 'worktrees', 'logs', '.claude']) {
    assert.ok(existsSync(join(wsPath, d)), `missing ${d}`);
  }
  const cfg = parseConfig(readFileSync(join(wsPath, 'config.yaml'), 'utf-8'));
  assert.equal(cfg.workspace, 'proj'); // name wins over the model's workspace field
  assert.equal(readlinkSync(join(wsPath, '.claude', 'skills')), join(seanceRepo, 'skills'));
  assert.deepEqual(calls, [['clone', '--branch', 'main', 'git@github.com:you/example-repo.git', join(wsPath, 'repos', 'example-repo')]]);
  assert.deepEqual(clones, [{ name: 'example-repo', ok: true, error: undefined }]);
});

test('scaffoldWorkspace: rejects bad names, existing dirs, missing skills', async () => {
  const { root, seanceRepo } = tmpSetup();
  const { runGit } = fakeGit();
  await assert.rejects(() => scaffoldWorkspace({ root, name: 'bad name!', config: MODEL(), seanceRepo, runGit }), /invalid workspace name/);
  mkdirSync(join(root, 'taken'), { recursive: true });
  await assert.rejects(() => scaffoldWorkspace({ root, name: 'taken', config: MODEL(), seanceRepo, runGit }), /already exists/);
  await assert.rejects(() => scaffoldWorkspace({ root, name: 'ok', config: MODEL(), seanceRepo: join(root, 'nowhere'), runGit }), /seanceRepoPath/);
});

test('scaffoldWorkspace: clone failure is non-fatal, workspace survives', async () => {
  const { root, seanceRepo } = tmpSetup();
  const { runGit } = fakeGit(['example-repo']);
  const { wsPath, clones } = await scaffoldWorkspace({ root, name: 'proj', config: MODEL(), seanceRepo, runGit });
  assert.ok(existsSync(join(wsPath, 'config.yaml')));
  assert.equal(clones[0].ok, false);
  assert.match(clones[0].error, /could not read from remote/);
});

test('syncRepos: clones only repos missing from repos/', async () => {
  const { root, seanceRepo } = tmpSetup();
  const first = fakeGit();
  const { wsPath } = await scaffoldWorkspace({ root, name: 'proj', config: MODEL(), seanceRepo, runGit: first.runGit });
  const model = MODEL();
  model.repos.push({ name: 'second', url: 'git@github.com:you/second.git', default_branch: 'dev', integration: 'merge', test_command: 'make test' });
  const again = fakeGit();
  const clones = await syncRepos(wsPath, model, again.runGit);
  assert.deepEqual(again.calls, [['clone', '--branch', 'dev', 'git@github.com:you/second.git', join(wsPath, 'repos', 'second')]]);
  assert.deepEqual(clones, [{ name: 'second', ok: true, error: undefined }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin && npm test
```

Expected: FAIL — `scaffoldWorkspace is not a function`.

- [ ] **Step 3: Implement scaffold + sync**

Add to `poltergeist-plugin/src/lib/workspace.cjs` (before `module.exports`; update the exports line):

```js
const CONTRACT_DIRS = [
  'inbox/processed', 'state/requirements', 'state/stories', 'state/agents',
  'attention', 'journal', 'repos', 'worktrees', 'logs', '.claude',
];

async function syncRepos(wsPath, config, runGit) {
  const clones = [];
  for (const r of config.repos ?? []) {
    const dest = join(wsPath, 'repos', r.name);
    if (existsSync(dest)) continue;
    const res = await runGit(['clone', '--branch', r.default_branch, r.url, dest]);
    clones.push({
      name: r.name,
      ok: res.code === 0,
      error: res.code === 0 ? undefined : (res.stderr || 'git clone failed').trim().slice(-500),
    });
  }
  return clones;
}

async function scaffoldWorkspace({ root, name, config, seanceRepo, runGit }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`invalid workspace name "${name}" — letters, digits, . _ - only`);
  }
  const wsPath = join(root, name);
  if (existsSync(wsPath)) throw new Error(`workspace already exists: ${wsPath}`);
  const skillsSrc = join(seanceRepo, 'skills');
  if (!existsSync(skillsSrc)) {
    throw new Error(`skills not found at ${skillsSrc} — set the seanceRepoPath plugin setting to your séance checkout`);
  }
  for (const d of CONTRACT_DIRS) mkdirSync(join(wsPath, d), { recursive: true });
  writeFileSync(join(wsPath, 'config.yaml'), configToYaml({ ...config, workspace: name }));
  try {
    symlinkSync(skillsSrc, join(wsPath, '.claude', 'skills'));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const clones = await syncRepos(wsPath, config, runGit);
  return { wsPath, clones };
}

module.exports = { NAME_RE, parseConfig, configToYaml, validateConfigModel, scaffoldWorkspace, syncRepos };
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin && npm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd ~/development/nikrich/seance
git add poltergeist-plugin/src/lib/workspace.cjs poltergeist-plugin/test/workspace.test.mjs
git commit -m "feat(plugin): workspace scaffolding + non-fatal repo cloning"
```

---

### Task 3: IPC handlers in `main.cjs`

**Files:**
- Modify: `poltergeist-plugin/src/main.cjs`

**Interfaces:**
- Consumes: Task 1–2 exports from `./lib/workspace.cjs`; existing `withClaudePath` from `./lib/spawn-env.cjs`; existing `SEANCE_ROOT`, `DEFAULT_SEANCE_REPO`, `assertWorkspace`, `ctx.settings`.
- Produces: IPC channels `workspace:create (name, model) -> {wsPath, clones}`, `workspace:config:read (wsPath) -> model`, `workspace:config:write (wsPath, model) -> {clones}` for the renderer.

- [ ] **Step 1: Wire the module and handlers**

In `poltergeist-plugin/src/main.cjs`:

(a) Update the header comment (currently says writes ONLY to inbox/):

```js
// Séance plugin — Poltergeist main-process side.
// Consumes the Séance workspace file contract (README): writes ONLY to
// inbox/ (+ this plugin's own dataDir), plus workspace creation and the
// config editor (scaffolding new ~/seance/<name> trees and rewriting
// config.yaml). All other workspace state stays read-only. Heartbeat
// start/stop is process management, not files.
```

(b) Add the require next to the other lib requires:

```js
const { parseConfig, configToYaml, validateConfigModel, scaffoldWorkspace, syncRepos } = require('./lib/workspace.cjs');
```

(c) Inside `activate(ctx)`, next to the other handlers, add:

```js
  const runGit = (args) =>
    new Promise((resolveRun) => {
      execFile(
        'git',
        args,
        { env: withClaudePath(), timeout: 10 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 },
        (err, stdout, stderr) => {
          resolveRun({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: stdout ?? '',
            stderr: (stderr ?? '') + (err && !stderr ? ` ${err.message}` : ''),
          });
        },
      );
    });

  ctx.ipc.handle('workspace:create', async (name, model) => {
    const errors = validateConfigModel(model);
    if (errors.length > 0) throw new Error(errors.join('; '));
    mkdirSync(SEANCE_ROOT, { recursive: true });
    const seanceRepo = ctx.settings.get('seanceRepoPath') ?? DEFAULT_SEANCE_REPO;
    return scaffoldWorkspace({ root: SEANCE_ROOT, name, config: model, seanceRepo, runGit });
  });

  ctx.ipc.handle('workspace:config:read', (wsPath) => {
    const ws = assertWorkspace(wsPath);
    return parseConfig(readFileSync(join(ws, 'config.yaml'), 'utf-8'));
  });

  ctx.ipc.handle('workspace:config:write', async (wsPath, model) => {
    const ws = assertWorkspace(wsPath);
    const errors = validateConfigModel(model);
    if (errors.length > 0) throw new Error(errors.join('; '));
    writeFileSync(join(ws, 'config.yaml'), configToYaml(model));
    return { clones: await syncRepos(ws, model, runGit) };
  });
```

- [ ] **Step 2: Build and test**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin && npm test && npm run build
```

Expected: tests pass, esbuild bundles `dist/main.cjs` (now includes `yaml`) with no errors.

- [ ] **Step 3: Commit (source only — dist ships in Task 5)**

```bash
cd ~/development/nikrich/seance
git add poltergeist-plugin/src/main.cjs
git commit -m "feat(plugin): workspace create/read/write IPC handlers"
```

---

### Task 4: Renderer — WorkspaceForm, config tab, create mode

**Files:**
- Modify: `poltergeist-plugin/src/renderer.jsx`

**Interfaces:**
- Consumes: IPC channels from Task 3; existing renderer primitives `Panel`, `Btn`, `Pill`, `Eyebrow`, `useTheme`, plus lucide icons already imported (`Cog`, `GitBranch`, `Check`, `X`, `Sparkles`).
- Produces: user-visible config tab + create flow; no downstream code consumers.

- [ ] **Step 1: Add the shared form model default and WorkspaceForm**

Add after the `Panel` component in `poltergeist-plugin/src/renderer.jsx`:

```jsx
// ---- workspace config form ----------------------------------------------

const BLANK_REPO = { name: '', url: '', default_branch: 'main', integration: 'pr', test_command: '' };
const BLANK_CONFIG = {
  workspace: '',
  repos: [{ ...BLANK_REPO }],
  max_builders: 3, max_critics: 2, max_planner: 1, max_agent_minutes: 45, attempt_cap: 3,
  models: { manager: 'haiku', planner: 'opus', builder: 'sonnet', critic: 'opus' },
  sleep: { active: 60, idle: 600 },
};
const MODEL_OPTIONS = ['haiku', 'sonnet', 'opus'];
const repoNameFromUrl = (url) => (url.split('/').pop() ?? '').replace(/\.git$/, '').trim();

function Field({ theme, label, children, width }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, width, minWidth: 0 }}>
      <Eyebrow theme={theme}>{label}</Eyebrow>
      {children}
    </label>
  );
}

function Segmented({ theme, value, options, onChange }) {
  return (
    <div style={{ display: 'inline-flex', gap: 3, padding: 3, background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm }}>
      {options.map((o) => {
        const on = value === o;
        return (
          <button key={o} type="button" onClick={() => onChange(o)} style={{
            padding: '5px 11px', borderRadius: 4, cursor: 'pointer', border: 'none',
            background: on ? theme.neonMist : 'transparent',
            color: on ? theme.neonInk : theme.ink2,
            fontFamily: theme.fontMono, fontSize: 11, fontWeight: on ? 600 : 500,
          }}>{o}</button>
        );
      })}
    </div>
  );
}

function WorkspaceForm({ theme, mode, initial, busy, error, cloneResults, onSubmit }) {
  const [cfg, setCfg] = useState(initial ?? BLANK_CONFIG);
  const [name, setName] = useState('');
  useEffect(() => { if (initial) setCfg(initial); }, [initial]);

  const field = {
    fontFamily: 'inherit', fontSize: 13, color: theme.ink0,
    background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
    padding: '8px 11px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  const numField = { ...field, fontFamily: theme.fontMono, fontSize: 12 };
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setRepo = (i, patch) => setCfg((c) => ({ ...c, repos: c.repos.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const num = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? 0 : n; };

  const clientErrors = [];
  if (mode === 'create' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) clientErrors.push('workspace name: letters, digits, . _ - only');
  if (!cfg.repos.some((r) => r.url.trim())) clientErrors.push('at least one repo with a url');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
      {mode === 'create' && (
        <Panel theme={theme} title="workspace" subtitle="lives under ~/seance/<name>">
          <Field theme={theme} label="name">
            <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12, maxWidth: 280 }} placeholder="my-project"
              value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </Field>
        </Panel>
      )}

      <Panel theme={theme} title="repos" subtitle="the fleet works these"
        action={<Btn theme={theme} variant="ghost" disabled={busy}
          onClick={() => set({ repos: [...cfg.repos, { ...BLANK_REPO }] })}>+ add repo</Btn>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {cfg.repos.map((r, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12, borderBottom: i < cfg.repos.length - 1 ? `1px solid ${theme.hairline}` : 'none' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto auto', gap: 10, alignItems: 'end' }}>
                <Field theme={theme} label="git url">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }} placeholder="git@github.com:you/repo.git"
                    value={r.url} disabled={busy}
                    onChange={(e) => {
                      const url = e.target.value;
                      const derived = repoNameFromUrl(url);
                      setRepo(i, { url, ...(r.name === '' || r.name === repoNameFromUrl(r.url) ? { name: derived } : {}) });
                    }} />
                </Field>
                <Field theme={theme} label="name">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }} value={r.name} disabled={busy}
                    onChange={(e) => setRepo(i, { name: e.target.value })} />
                </Field>
                <Field theme={theme} label="branch">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12, width: 110 }} value={r.default_branch} disabled={busy}
                    onChange={(e) => setRepo(i, { default_branch: e.target.value })} />
                </Field>
                <button type="button" title="remove repo" disabled={busy || cfg.repos.length === 1}
                  onClick={() => set({ repos: cfg.repos.filter((_, j) => j !== i) })}
                  style={{ background: 'transparent', border: 'none', color: theme.ink3, cursor: cfg.repos.length === 1 ? 'not-allowed' : 'pointer', padding: 6 }}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'end' }}>
                <Field theme={theme} label="integration">
                  <Segmented theme={theme} value={r.integration} options={['pr', 'merge']} onChange={(v) => setRepo(i, { integration: v })} />
                </Field>
                <Field theme={theme} label="test command (critic runs this on every verdict)">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }} placeholder="npm test"
                    value={r.test_command} disabled={busy} onChange={(e) => setRepo(i, { test_command: e.target.value })} />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Panel theme={theme} title="limits" subtitle="fleet size & safety rails">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {[['max_builders', 'builders'], ['max_critics', 'critics'], ['max_planner', 'planners'], ['max_agent_minutes', 'agent minutes'], ['attempt_cap', 'attempt cap']].map(([k, label]) => (
              <Field key={k} theme={theme} label={label}>
                <input type="number" min="1" style={numField} value={cfg[k]} disabled={busy}
                  onChange={(e) => set({ [k]: num(e.target.value) })} />
              </Field>
            ))}
          </div>
        </Panel>
        <Panel theme={theme} title="models & cadence" subtitle="claude aliases · heartbeat sleep">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {['manager', 'planner', 'builder', 'critic'].map((role) => (
              <Field key={role} theme={theme} label={role}>
                <select style={{ ...numField, cursor: 'pointer' }} value={cfg.models[role]} disabled={busy}
                  onChange={(e) => set({ models: { ...cfg.models, [role]: e.target.value } })}>
                  {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            ))}
            <Field theme={theme} label="active sleep (s)">
              <input type="number" min="1" style={numField} value={cfg.sleep.active} disabled={busy}
                onChange={(e) => set({ sleep: { ...cfg.sleep, active: num(e.target.value) } })} />
            </Field>
            <Field theme={theme} label="idle sleep (s)">
              <input type="number" min="1" style={numField} value={cfg.sleep.idle} disabled={busy}
                onChange={(e) => set({ sleep: { ...cfg.sleep, idle: num(e.target.value) } })} />
            </Field>
          </div>
        </Panel>
      </div>

      {(error || clientErrors.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: theme.oxbloodMist, border: `1px solid ${theme.oxblood}`, borderRadius: theme.rMd, padding: '9px 13px', fontSize: 12.5, color: theme.pillOxbloodFg }}>
          <AlertTriangle size={14} color={theme.oxblood} style={{ flexShrink: 0 }} />
          <span>{error ?? clientErrors.join(' · ')}</span>
        </div>
      )}

      {cloneResults?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cloneResults.map((c) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: theme.fontMono, fontSize: 11.5, color: c.ok ? theme.pillMossFg : theme.pillOxbloodFg }}>
              {c.ok ? <Check size={12} /> : <X size={12} />}
              <span>{c.name}</span>
              {!c.ok && <span style={{ color: theme.ink2, overflowWrap: 'anywhere' }}>— {c.error} (check ssh keys / gh auth, then save to retry)</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {busy && (
          <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.ink2, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="seance-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: theme.neon }} />
            {mode === 'create' ? 'summoning workspace… cloning repos can take a minute' : 'saving…'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Btn theme={theme} variant="primary" icon={<Sparkles size={13} />} disabled={busy || clientErrors.length > 0}
          onClick={() => onSubmit(mode === 'create' ? { name, config: cfg } : { config: cfg })}>
          {mode === 'create' ? 'create workspace' : 'save config'}
        </Btn>
      </div>
    </div>
  );
}

function ConfigTab({ theme, api, ws }) {
  const [initial, setInitial] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [cloneResults, setCloneResults] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    setInitial(null); setError(null); setCloneResults(null); setSavedAt(null);
    api.ipc.invoke('workspace:config:read', ws).then(setInitial).catch((e) => setError(String(e?.message ?? e)));
  }, [api, ws]);

  if (!initial && !error) return <SkeletonNote theme={theme} text="reading config…" />;
  return (
    <div style={{ overflowY: 'auto', minHeight: 0, paddingBottom: 4 }}>
      {savedAt && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontFamily: theme.fontMono, fontSize: 11.5, color: theme.pillMossFg }}>
          <Check size={12} /> config saved
        </div>
      )}
      <WorkspaceForm theme={theme} mode="edit" initial={initial} busy={busy} error={error} cloneResults={cloneResults}
        onSubmit={async ({ config }) => {
          setBusy(true); setError(null); setSavedAt(null);
          try {
            const r = await api.ipc.invoke('workspace:config:write', ws, config);
            setCloneResults(r.clones); setSavedAt(Date.now());
          } catch (e) { setError(String(e?.message ?? e)); }
          finally { setBusy(false); }
        }} />
    </div>
  );
}

function SkeletonNote({ theme, text }) {
  return <div style={{ fontSize: 12, color: theme.ink3, padding: '8px 2px' }}>{text}</div>;
}
```

- [ ] **Step 2: Wire create mode + config tab into the shell**

In `App` (same file):

(a) Add `Cog` to the TABS list:

```jsx
const TABS = [
  { id: 'board', label: 'board', Icon: LayoutGrid },
  { id: 'hood', label: 'under the hood', Icon: Cpu },
  { id: 'chat', label: 'chat', Icon: MessageSquare },
  { id: 'config', label: 'config', Icon: Cog },
];
```

(b) Add state + create handler inside `App`:

```jsx
  const [creating, setCreating] = useState(false);       // create view open?
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [createClones, setCreateClones] = useState(null);

  const createWorkspace = async ({ name, config }) => {
    setCreateBusy(true); setCreateError(null);
    try {
      const r = await api.ipc.invoke('workspace:create', name, config);
      setCreateClones(r.clones);
      const list = await api.ipc.invoke('workspaces:list');
      setWorkspaces(list);
      setSnap(null); setWs(r.wsPath); setCreating(false); setTab('board');
    } catch (e) { setCreateError(String(e?.message ?? e)); }
    finally { setCreateBusy(false); }
  };
```

(c) Header: add a "+ new" ghost button right after the workspace-picker span (visible whenever `workspaces !== null`):

```jsx
        {workspaces !== null && (
          <Btn theme={theme} variant="ghost" onClick={() => setCreating(true)}>+ new</Btn>
        )}
```

(d) Body: `creating` takes precedence over everything (incl. no-workspace); `NoWorkspace` gains the CTA. Replace the `noWorkspace ? <NoWorkspace/> : <>…</>` block body with:

```jsx
      {creating ? (
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <Eyebrow theme={theme}>new workspace</Eyebrow>
            <span style={{ flex: 1 }} />
            <Btn theme={theme} variant="ghost" disabled={createBusy} onClick={() => setCreating(false)}>cancel</Btn>
          </div>
          <WorkspaceForm theme={theme} mode="create" busy={createBusy} error={createError}
            cloneResults={createClones} onSubmit={createWorkspace} />
        </div>
      ) : noWorkspace ? (
        <NoWorkspace theme={theme} onCreate={() => setCreating(true)} />
      ) : (
        <>
          {/* …existing tabs block unchanged, plus: */}
          {tab === 'config' && ws && <ConfigTab theme={theme} api={api} ws={ws} />}
        </>
      )}
```

(e) `NoWorkspace` becomes actionable — replace the "create one under ~/seance…" sentence and add the button:

```jsx
function NoWorkspace({ theme, onCreate }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40 }}>
      <Ghost size={48} color={theme.ink2} className="seance-float" />
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontFamily: theme.fontDisplay, fontWeight: 600, fontSize: 20, letterSpacing: '-0.02em', color: theme.ink0, marginBottom: 6 }}>
          no séance in progress
        </div>
        <p style={{ fontSize: 13, color: theme.ink2, lineHeight: 1.5, margin: 0 }}>
          the séance binds to a workspace, opens a worktree per agent, and works the backlog until you call it back.
        </p>
      </div>
      <Btn theme={theme} variant="primary" icon={<Sparkles size={13} />} onClick={onCreate}>create a workspace</Btn>
    </div>
  );
}
```

- [ ] **Step 3: Build and test**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin && npm test && npm run build
```

Expected: tests pass; esbuild bundles with no errors (Cog/Check/X/Sparkles/AlertTriangle already imported — add any the build reports missing to the lucide-react import).

- [ ] **Step 4: Commit**

```bash
cd ~/development/nikrich/seance
git add poltergeist-plugin/src/renderer.jsx
git commit -m "feat(plugin): config tab + create-workspace form"
```

---

### Task 5: Harness verification, dist, version, ship

**Files:**
- Modify: `poltergeist-plugin/manifest.json` (version → `0.3.0`)
- Modify: `poltergeist-plugin/dist/*` (rebuild)
- Test: scratchpad harness (`harness.html` + `shoot.mjs` from the redesign session — extend, don't rewrite)

**Interfaces:**
- Consumes: everything above.
- Produces: merged PR; marketplace-ready 0.3.0.

- [ ] **Step 1: Extend the mock harness**

In the scratchpad harness (`scratchpad/seance-verify/harness.html`), copy the fresh `dist/renderer.mjs` over, then add to the mock `invoke` switch:

```js
            case 'workspace:config:read': return {
              workspace: 'poltergeist',
              repos: [{ name: 'poltergeist', url: 'git@github.com:nikrich/ghost-brain.git', default_branch: 'main', integration: 'pr', test_command: 'npm test' }],
              max_builders: 3, max_critics: 2, max_planner: 1, max_agent_minutes: 45, attempt_cap: 3,
              models: { manager: 'haiku', planner: 'opus', builder: 'sonnet', critic: 'opus' },
              sleep: { active: 60, idle: 600 },
            };
            case 'workspace:config:write': return { clones: [{ name: 'new-repo', ok: false, error: 'fatal: could not read from remote' }] };
            case 'workspace:create': return { wsPath: '/ws/created', clones: [{ name: 'repo', ok: true }] };
```

And in `shoot.mjs` add shots: config tab (`await shoot('live', 'config', '7-config-tab')`) and the create view (navigate, then `await page.click('text="+ new"'); await page.waitForTimeout(600); await page.screenshot(...)` as `8-create`).

- [ ] **Step 2: Run the harness, eyeball both screenshots**

```bash
cd <scratchpad>/seance-verify && cp ~/development/nikrich/seance/poltergeist-plugin/dist/renderer.mjs . && node shoot.mjs
```

Expected: `no page errors`; Read `7-config-tab.png` and `8-create.png` — form panels render, styled, nothing clipped.

- [ ] **Step 3: Bump version, rebuild, final test**

```bash
cd ~/development/nikrich/seance/poltergeist-plugin
# manifest.json: "version": "0.2.1" -> "0.3.0"
npm test && npm run build
```

- [ ] **Step 4: Commit, PR, merge**

```bash
cd ~/development/nikrich/seance
git add poltergeist-plugin/manifest.json poltergeist-plugin/dist
git commit -m "feat(plugin): ship workspace creator/editor (0.3.0)"
git push -u origin feat/plugin-create-workspace
gh pr create --title "feat(plugin): create & edit workspaces from the UI" --body "<summary + test plan per repo convention>"
gh pr merge --squash --delete-branch
```

Expected: PR merges clean onto main.
