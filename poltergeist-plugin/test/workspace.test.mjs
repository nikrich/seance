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
