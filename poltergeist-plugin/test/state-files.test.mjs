import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseFrontmatter, readWorkspaceStatus } = require('../src/lib/state-files.cjs');

test('parseFrontmatter: scalars, arrays, quoted strings, body', () => {
  const md = `---
id: REQ-1-s1
requirement: REQ-1
repo: toy
status: pending
deps: [REQ-1-s2, REQ-1-s3]
oracle: "bash test/sum_test.sh"
attempts: 0
---

## Task

Add a sum function.

## Attempts ledger
`;
  const { attrs, body } = parseFrontmatter(md);
  assert.equal(attrs.id, 'REQ-1-s1');
  assert.equal(attrs.status, 'pending');
  assert.deepEqual(attrs.deps, ['REQ-1-s2', 'REQ-1-s3']);
  assert.equal(attrs.oracle, 'bash test/sum_test.sh');
  assert.equal(attrs.attempts, 0);
  assert.match(body, /## Task/);
});

test('parseFrontmatter: empty array and no frontmatter', () => {
  assert.deepEqual(parseFrontmatter('---\ndeps: []\n---\nx').attrs.deps, []);
  const { attrs, body } = parseFrontmatter('just a note');
  assert.deepEqual(attrs, {});
  assert.equal(body, 'just a note');
});

test('readWorkspaceStatus assembles a full snapshot', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  for (const d of ['state/requirements', 'state/stories', 'state/agents', 'attention', 'journal']) {
    mkdirSync(join(ws, d), { recursive: true });
  }
  writeFileSync(
    join(ws, 'state/requirements/REQ-1.md'),
    '---\nid: REQ-1\ntitle: Add sum\nstatus: planned\npriority: normal\n---\nbody',
  );
  writeFileSync(
    join(ws, 'state/stories/REQ-1-s1.md'),
    '---\nid: REQ-1-s1\nrequirement: REQ-1\nrepo: toy\nstatus: merged\ndeps: []\noracle: "x"\nbranch: seance/REQ-1-s1\nattempts: 1\n---\n\n## Task\n\nAdd a `sum` function to lib/calc.sh.\nMore detail here.\n\n## Attempts ledger\n',
  );
  // agent with our own (live) pid, and one with a dead pid
  writeFileSync(
    join(ws, 'state/agents/builder-1.md'),
    `---\nid: builder-1\nrole: builder\npid: ${process.pid}\nstory: REQ-1-s1\nstarted_at: 2026-07-06T10:00:00Z\n---\n`,
  );
  writeFileSync(
    join(ws, 'state/agents/critic-1.md'),
    '---\nid: critic-1\nrole: critic\npid: 999999\nstory: REQ-1-s1\nstarted_at: 2026-07-06T10:00:00Z\n---\n',
  );
  writeFileSync(join(ws, 'attention/REQ-9.md'), 'needs a human');
  writeFileSync(
    join(ws, 'journal/ticks.ndjson'),
    '{"ts":"2026-07-06T10:00:00Z"}\n{"ts":"2026-07-06T10:01:00Z"}\n',
  );

  const snap = readWorkspaceStatus(ws);
  assert.equal(snap.requirements.length, 1);
  assert.equal(snap.requirements[0].title, 'Add sum');
  assert.equal(snap.stories.length, 1);
  assert.equal(snap.stories[0].status, 'merged');
  assert.equal(snap.stories[0].title, 'Add a `sum` function to lib/calc.sh.');
  assert.equal(snap.agents.length, 2);
  assert.equal(snap.agents.find((a) => a.id === 'builder-1').alive, true);
  assert.equal(snap.agents.find((a) => a.id === 'critic-1').alive, false);
  assert.equal(snap.attention.length, 1);
  assert.equal(snap.attention[0].name, 'REQ-9.md');
  assert.equal(snap.lastTickTs, '2026-07-06T10:01:00Z');
  assert.deepEqual(snap.backlogCounts, { merged: 1 });
});
