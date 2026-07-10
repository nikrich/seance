import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { parseConfig, configToYaml, validateConfigModel, scaffoldWorkspace, syncRepos, ensureMcpConfig, ensureAgentSettings } = require('../src/lib/workspace.cjs');

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

  const badUrl = parseConfig(TEMPLATE);
  badUrl.repos[0].url = '--upload-pack=touch /tmp/pwned';
  assert.ok(validateConfigModel(badUrl).some((e) => e === 'repo example-repo: url must not start with "-"'));

  const badBranch = parseConfig(TEMPLATE);
  badBranch.repos[0].default_branch = '--upload-pack=touch /tmp/pwned';
  assert.ok(validateConfigModel(badBranch).some((e) => e === 'repo example-repo: default_branch is invalid'));

  const emptyBranch = parseConfig(TEMPLATE);
  emptyBranch.repos[0].default_branch = '';
  assert.ok(validateConfigModel(emptyBranch).some((e) => e === 'repo example-repo: default_branch is invalid'));
});

test('parseConfig / configToYaml / validateConfigModel: feature-pr is a valid integration mode', () => {
  const withFeaturePr = TEMPLATE.replace('integration: pr', 'integration: feature-pr');
  const m = parseConfig(withFeaturePr);
  assert.equal(m.repos[0].integration, 'feature-pr');
  assert.deepEqual(validateConfigModel(m), []);
  // round-trips through YAML unchanged
  const back = parseConfig(configToYaml(m));
  assert.equal(back.repos[0].integration, 'feature-pr');
});

test('configToYaml: ignores extra entries that collide with known keys', () => {
  const m = parseConfig(TEMPLATE);
  m.extra = { repos: 'evil', custom_key: 'kept' };
  const back = parseConfig(configToYaml(m));
  assert.deepEqual(back.repos, m.repos);
  assert.deepEqual(back.extra, { custom_key: 'kept' });
});

test('parseConfig: inbox_feeds absent defaults to []', () => {
  const m = parseConfig(TEMPLATE);
  assert.deepEqual(m.inbox_feeds, []);
});

test('inbox_feeds: round-trips and never rides in extra', () => {
  const m = parseConfig(TEMPLATE);
  m.inbox_feeds = ['/Users/you/ouija/outbox', '/Users/you/other/outbox'];
  const yaml = configToYaml(m);
  const back = parseConfig(yaml);
  assert.deepEqual(back.inbox_feeds, ['/Users/you/ouija/outbox', '/Users/you/other/outbox']);
  assert.deepEqual(back.extra, {});
});

test('configToYaml: empty inbox_feeds emits no inbox_feeds key', () => {
  const m = parseConfig(TEMPLATE);
  m.inbox_feeds = [];
  const yaml = configToYaml(m);
  assert.ok(!yaml.includes('inbox_feeds'));
});

test('validateConfigModel: rejects non-absolute inbox_feeds entries', () => {
  const relative = parseConfig(TEMPLATE);
  relative.inbox_feeds = ['relative/path'];
  assert.ok(validateConfigModel(relative).some((e) => e === 'inbox_feeds entries must be absolute paths'));

  const notString = parseConfig(TEMPLATE);
  notString.inbox_feeds = [42];
  assert.ok(validateConfigModel(notString).some((e) => e === 'inbox_feeds entries must be absolute paths'));

  const empty = parseConfig(TEMPLATE);
  empty.inbox_feeds = [''];
  assert.ok(validateConfigModel(empty).some((e) => e === 'inbox_feeds entries must be absolute paths'));

  const root = parseConfig(TEMPLATE);
  root.inbox_feeds = ['/'];
  assert.ok(validateConfigModel(root).some((e) => e === 'inbox_feeds entries must be absolute paths'));

  const valid = parseConfig(TEMPLATE);
  valid.inbox_feeds = ['/Users/you/ouija/outbox'];
  assert.deepEqual(validateConfigModel(valid), []);
});

test('parseConfig: coerces non-string inbox_feeds entries to strings', () => {
  const withNumeric = parseConfig(TEMPLATE + 'inbox_feeds:\n  - 42\n');
  assert.deepEqual(withNumeric.inbox_feeds, ['42']);
  // Coerced to a string, but still relative (no leading "/"), so validation still rejects it.
  assert.ok(validateConfigModel(withNumeric).some((e) => e === 'inbox_feeds entries must be absolute paths'));
});

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
  for (const d of ['inbox/processed', 'state/requirements', 'state/stories', 'state/agents', 'attention', 'journal', 'repos', 'worktrees', 'logs', '.claude', 'questions']) {
    assert.ok(existsSync(join(wsPath, d)), `missing ${d}`);
  }
  const cfg = parseConfig(readFileSync(join(wsPath, 'config.yaml'), 'utf-8'));
  assert.equal(cfg.workspace, 'proj'); // name wins over the model's workspace field
  assert.equal(readlinkSync(join(wsPath, '.claude', 'skills')), join(seanceRepo, 'skills'));
  assert.deepEqual(calls, [['-c', 'protocol.ext.allow=never', 'clone', '--branch', 'main', '--', 'git@github.com:you/example-repo.git', join(wsPath, 'repos', 'example-repo')]]);
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
  assert.deepEqual(again.calls, [['-c', 'protocol.ext.allow=never', 'clone', '--branch', 'dev', '--', 'git@github.com:you/second.git', join(wsPath, 'repos', 'second')]]);
  assert.deepEqual(clones, [{ name: 'second', ok: true, error: undefined }]);
});

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

test('scaffoldWorkspace: writes .claude/settings.local.json trusting project MCP servers', async () => {
  const { root, seanceRepo } = tmpSetup();
  const { runGit } = fakeGit();
  const { wsPath } = await scaffoldWorkspace({ root, name: 'proj', config: MODEL(), seanceRepo, runGit });
  const settings = readFileSync(join(wsPath, '.claude', 'settings.local.json'), 'utf-8');
  assert.equal(settings, '{"enableAllProjectMcpServers": true}\n');
});

test('ensureAgentSettings: writes once, never overwrites an existing settings.local.json', async () => {
  const { root, seanceRepo } = tmpSetup();
  const { runGit } = fakeGit();
  const { wsPath } = await scaffoldWorkspace({ root, name: 'proj', config: MODEL(), seanceRepo, runGit });
  // scaffold already wrote it — a second call is a no-op
  assert.equal(ensureAgentSettings(wsPath), false);
  writeFileSync(join(wsPath, '.claude', 'settings.local.json'), '{"custom":true}');
  assert.equal(ensureAgentSettings(wsPath), false);
  assert.equal(readFileSync(join(wsPath, '.claude', 'settings.local.json'), 'utf-8'), '{"custom":true}');
});
