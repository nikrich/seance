import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildActivity } = require('../src/lib/activity.cjs');

function makeWs() {
  const ws = mkdtempSync(join(tmpdir(), 'seance-act-'));
  for (const d of ['state/stories', 'attention', 'journal']) {
    mkdirSync(join(ws, d), { recursive: true });
  }
  return ws;
}

test('merges ticks, ledger verdicts, and attention; skips garbage; sorts newest-first', () => {
  const ws = makeWs();
  writeFileSync(
    join(ws, 'journal', 'ticks.ndjson'),
    [
      '{"ts":"2026-07-06T10:00:00Z","reaped":0,"killed":0,"spawned":{"planner":0,"builder":1,"critic":0},"backlog":1,"in_flight":1,"blocked":0,"inbox":0}',
      'this is not json {{{',
      '{"ts":"2026-07-06T10:05:00Z","human":true,"action":"requeue","target":"REQ-2-s2"}',
    ].join('\n') + '\n',
  );
  writeFileSync(
    join(ws, 'state/stories/REQ-2-s2.md'),
    `---
id: REQ-2-s2
requirement: REQ-2
repo: toy
status: merged
attempts: 2
---

## Task

Add average.

## Attempts ledger

### Attempt 1 — rejected (2026-07-06T09:50:00Z)
- What failed: merge conflict in lib/calc.sh against main
- What to do differently: rebase onto main

### Attempt 2 — approved (2026-07-06T10:10:00Z)
- Verified oracle and full suite green after rebase.
`,
  );
  writeFileSync(join(ws, 'attention', 'REQ-9.md'), 'needs a human');

  const events = buildActivity(ws, 100);
  const kinds = events.map((e) => e.kind);
  assert.ok(kinds.includes('tick-spawn'));
  assert.ok(kinds.includes('human'));
  assert.ok(kinds.includes('rejected'));
  assert.ok(kinds.includes('approved'));
  assert.ok(kinds.includes('attention'));
  // garbage line contributed nothing
  assert.equal(events.filter((e) => e.text.includes('not json')).length, 0);

  const rejected = events.find((e) => e.kind === 'rejected');
  assert.equal(rejected.storyId, 'REQ-2-s2');
  assert.ok(rejected.text.includes('merge conflict'), rejected.text);

  // newest-first ordering (excluding attention whose ts is a file mtime)
  const ordered = events.filter((e) => e.kind !== 'attention').map((e) => e.ts);
  const sorted = [...ordered].sort().reverse();
  assert.deepEqual(ordered, sorted);
});

test('respects limit and tolerates empty workspaces', () => {
  const ws = makeWs();
  const lines = [];
  for (let i = 10; i < 40; i++) {
    lines.push(`{"ts":"2026-07-06T10:${i}:00Z","reaped":1,"killed":0,"spawned":{"planner":0,"builder":0,"critic":0}}`);
  }
  writeFileSync(join(ws, 'journal', 'ticks.ndjson'), lines.join('\n'));
  assert.equal(buildActivity(ws, 5).length, 5);

  const empty = mkdtempSync(join(tmpdir(), 'seance-act-empty-'));
  assert.deepEqual(buildActivity(empty, 10), []);
});
