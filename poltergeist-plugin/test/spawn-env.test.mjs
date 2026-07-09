import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withClaudePath } = require('../src/lib/spawn-env.cjs');

const GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'; // what launchd hands a .app

test('withClaudePath: prepends claude install dirs to a stripped GUI PATH', () => {
  const env = withClaudePath({ HOME: '/Users/jan', PATH: GUI_PATH });
  const parts = env.PATH.split(':');
  assert.deepEqual(parts.slice(0, 3), ['/opt/homebrew/bin', '/usr/local/bin', '/Users/jan/.local/bin']);
  assert.equal(parts.slice(3).join(':'), GUI_PATH);
});

test('withClaudePath: keeps already-present dirs in place (no duplicates)', () => {
  const path = `/Users/jan/.local/bin:${GUI_PATH}`;
  const env = withClaudePath({ HOME: '/Users/jan', PATH: path });
  const parts = env.PATH.split(':');
  assert.equal(parts.filter((p) => p === '/Users/jan/.local/bin').length, 1);
  assert.deepEqual(parts.slice(0, 2), ['/opt/homebrew/bin', '/usr/local/bin']);
});

test('withClaudePath: tolerates missing HOME and PATH', () => {
  const env = withClaudePath({});
  const parts = env.PATH.split(':');
  assert.deepEqual(parts, ['/opt/homebrew/bin', '/usr/local/bin']);
});

test('withClaudePath: preserves the rest of the env', () => {
  const env = withClaudePath({ HOME: '/Users/jan', PATH: GUI_PATH, FOO: 'bar' });
  assert.equal(env.FOO, 'bar');
  assert.equal(env.HOME, '/Users/jan');
});
