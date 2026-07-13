import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseFrontmatter,
  readWorkspaceStatus,
  dismissAttention,
  answerQuestion,
  writeSpec,
  ackFeaturePr,
  agentsForRequirement,
  removeRequirement,
  reapAgents,
} = require('../src/lib/state-files.cjs');

test('dismissAttention: moves the item out of attention/, keeps an audit copy', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'attention'), { recursive: true });
  writeFileSync(join(ws, 'attention', 'note.md'), 'needs a human');

  dismissAttention(ws, 'note.md');
  assert.equal(readWorkspaceStatus(ws).attention.length, 0);
  assert.ok(existsSync(join(ws, 'attention', '.dismissed', 'note.md')));

  // rejects traversal and unknown names
  assert.throws(() => dismissAttention(ws, '../config.yaml'), /invalid attention item/);
  assert.throws(() => dismissAttention(ws, 'nope.md'), /not found/);
});

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

  // pending inbox: a summoned requirement, a steering note, and processed/ to ignore
  mkdirSync(join(ws, 'inbox/processed'), { recursive: true });
  writeFileSync(
    join(ws, 'inbox/REQ-2.md'),
    '---\nid: REQ-2\ntitle: Do the thing\npriority: high\n---\n\nbody',
  );
  writeFileSync(join(ws, 'inbox/steer-123.md'), 'REQ-41 first\n');
  writeFileSync(join(ws, 'inbox/processed/REQ-0.md'), 'already consumed');

  const snap = readWorkspaceStatus(ws);
  assert.equal(snap.inbox.length, 2);
  const req = snap.inbox.find((i) => i.id === 'REQ-2');
  assert.equal(req.title, 'Do the thing');
  const note = snap.inbox.find((i) => i.file === 'steer-123.md');
  assert.equal(note.id, null);
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

test('answerQuestion: a body line "status: open" does not re-arm an already-answered question', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'questions'), { recursive: true });
  const f = 'REQ-7-s3-tricky.md';
  writeFileSync(
    join(ws, 'questions', f),
    '---\nid: q\nstory: REQ-7-s3\nrequirement: REQ-7\nstatus: answered\n---\n## Question\n\nShould the default be "status: open" or "status: closed"?\n\n## Answer\n\nalready answered\n',
  );
  assert.throws(() => answerQuestion(ws, f, 'again'), /already answered/);
  const text = readFileSync(join(ws, 'questions', f), 'utf-8');
  assert.match(text, /^status: answered$/m);
  assert.equal((text.match(/## Answer/g) ?? []).length, 1);
});

test('writeSpec: approve transitions to planning, stamps spec_approved_at, replaces the spec', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-8.md'),
    '---\nid: REQ-8\ntitle: T\nstatus: spec_review\npriority: normal\n---\nbody\n\n## Spec\n\nold spec\n',
  );
  writeSpec(ws, 'REQ-8', 'new approved spec', { mode: 'approve' });
  const text = readFileSync(join(ws, 'state/requirements/REQ-8.md'), 'utf-8');
  assert.match(text, /status: planning/);
  assert.match(text, /spec_approved_at: /);
  assert.match(text, /## Spec\n\nnew approved spec/);
  assert.ok(!text.includes('old spec'));
  assert.throws(() => writeSpec(ws, 'bad id!', 'x', { mode: 'approve' }), /invalid requirement id/);
  assert.throws(() => writeSpec(ws, 'REQ-99', 'x', { mode: 'approve' }), /not found/);
});

test('writeSpec: revise transitions to speccing and appends feedback', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-9.md'),
    '---\nid: REQ-9\ntitle: T\nstatus: spec_review\npriority: normal\n---\nbody\n\n## Spec\n\nold spec\n',
  );
  writeSpec(ws, 'REQ-9', 'tweaked spec', { mode: 'revise', feedback: 'tighter scope please' });
  const text = readFileSync(join(ws, 'state/requirements/REQ-9.md'), 'utf-8');
  assert.match(text, /status: speccing/);
  assert.match(text, /## Spec\n\ntweaked spec/);
  assert.match(text, /## Spec feedback \(.*\)\n\ntighter scope please/);
});

test('writeSpec: revise with empty specText keeps the existing Spec section', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-10.md'),
    '---\nid: REQ-10\ntitle: T\nstatus: spec_review\npriority: normal\n---\nbody\n\n## Spec\n\nkeep me untouched\n',
  );
  writeSpec(ws, 'REQ-10', '', { mode: 'revise', feedback: 'needs more detail' });
  const text = readFileSync(join(ws, 'state/requirements/REQ-10.md'), 'utf-8');
  assert.match(text, /## Spec\n\nkeep me untouched/);
  assert.match(text, /status: speccing/);
  assert.match(text, /## Spec feedback \(.*\)\n\nneeds more detail/);
});

test('writeSpec: approve (or revise) on a requirement not awaiting spec review throws — kills stale double-applies', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-11.md'),
    '---\nid: REQ-11\ntitle: T\nstatus: planning\npriority: normal\n---\nbody\n',
  );
  assert.throws(() => writeSpec(ws, 'REQ-11', 'x', { mode: 'approve' }), /not awaiting spec review/);
  assert.throws(() => writeSpec(ws, 'REQ-11', 'x', { mode: 'revise', feedback: 'y' }), /not awaiting spec review/);
});

test('ackFeaturePr: sets feature_pr_ack and readWorkspaceStatus reflects it; throws without feature_pr', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-12.md'),
    '---\nid: REQ-12\ntitle: Feature\nstatus: done\npriority: normal\nfeature_pr: https://github.com/x/y/pull/1\n---\nbody\n',
  );
  ackFeaturePr(ws, 'REQ-12');
  let text = readFileSync(join(ws, 'state/requirements/REQ-12.md'), 'utf-8');
  assert.match(text, /^feature_pr_ack: true$/m);
  let snap = readWorkspaceStatus(ws);
  assert.equal(snap.requirements.find((r) => r.id === 'REQ-12').featurePrAck, true);

  // idempotent — a second call doesn't duplicate the flag
  ackFeaturePr(ws, 'REQ-12');
  text = readFileSync(join(ws, 'state/requirements/REQ-12.md'), 'utf-8');
  assert.equal((text.match(/feature_pr_ack: true/g) ?? []).length, 1);

  writeFileSync(
    join(ws, 'state/requirements/REQ-13.md'),
    '---\nid: REQ-13\ntitle: No PR\nstatus: planned\npriority: normal\n---\nbody\n',
  );
  assert.throws(() => ackFeaturePr(ws, 'REQ-13'), /has no feature_pr/);
  assert.throws(() => ackFeaturePr(ws, 'bad id!'), /invalid requirement id/);
  assert.throws(() => ackFeaturePr(ws, 'REQ-99'), /not found/);
});

test('removeRequirement: flips the requirement and its stories to removed, leaves other requirements untouched', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  mkdirSync(join(ws, 'state/stories'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-20.md'),
    '---\nid: REQ-20\ntitle: Cancel me\nstatus: planned\npriority: normal\n---\nbody\n',
  );
  writeFileSync(
    join(ws, 'state/requirements/REQ-21.md'),
    '---\nid: REQ-21\ntitle: Untouched\nstatus: planned\npriority: normal\n---\nbody\n',
  );
  writeFileSync(
    join(ws, 'state/stories/REQ-20-s1.md'),
    '---\nid: REQ-20-s1\nrequirement: REQ-20\nrepo: toy\nstatus: building\ndeps: []\noracle: "x"\nbranch: seance/REQ-20-s1\nattempts: 1\n---\n\n## Task\n\nDo a thing.\n\n## Attempts ledger\n',
  );
  writeFileSync(
    join(ws, 'state/stories/REQ-20-s2.md'),
    '---\nid: REQ-20-s2\nrequirement: REQ-20\nrepo: toy\nstatus: pending\ndeps: []\noracle: "x"\nbranch: seance/REQ-20-s2\nattempts: 0\n---\n\n## Task\n\nDo another thing.\n\n## Attempts ledger\n',
  );
  writeFileSync(
    join(ws, 'state/stories/REQ-21-s1.md'),
    '---\nid: REQ-21-s1\nrequirement: REQ-21\nrepo: toy\nstatus: building\ndeps: []\noracle: "x"\nbranch: seance/REQ-21-s1\nattempts: 0\n---\n\n## Task\n\nUnrelated.\n\n## Attempts ledger\n',
  );

  const result = removeRequirement(ws, 'REQ-20');
  assert.deepEqual(result.storyIds.sort(), ['REQ-20-s1', 'REQ-20-s2']);

  const req20 = readFileSync(join(ws, 'state/requirements/REQ-20.md'), 'utf-8');
  assert.match(req20, /^status: removed$/m);
  const s1 = readFileSync(join(ws, 'state/stories/REQ-20-s1.md'), 'utf-8');
  assert.match(s1, /^status: removed$/m);
  assert.match(s1, /## Attempts ledger/); // body untouched
  const s2 = readFileSync(join(ws, 'state/stories/REQ-20-s2.md'), 'utf-8');
  assert.match(s2, /^status: removed$/m);

  // other requirement and its story are untouched
  const req21 = readFileSync(join(ws, 'state/requirements/REQ-21.md'), 'utf-8');
  assert.match(req21, /^status: planned$/m);
  const other = readFileSync(join(ws, 'state/stories/REQ-21-s1.md'), 'utf-8');
  assert.match(other, /^status: building$/m);

  assert.throws(() => removeRequirement(ws, 'bad id!'), /invalid requirement id/);
  assert.throws(() => removeRequirement(ws, 'REQ-99'), /not found/);
});

test('removeRequirement: guards done and is a safe no-op on an already-removed requirement', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/requirements'), { recursive: true });
  mkdirSync(join(ws, 'state/stories'), { recursive: true });
  writeFileSync(
    join(ws, 'state/requirements/REQ-22.md'),
    '---\nid: REQ-22\ntitle: Done\nstatus: done\npriority: normal\n---\nbody\n',
  );
  assert.throws(() => removeRequirement(ws, 'REQ-22'), /REQ-22 is done and cannot be removed/);

  writeFileSync(
    join(ws, 'state/requirements/REQ-23.md'),
    '---\nid: REQ-23\ntitle: Already removed\nstatus: removed\npriority: normal\n---\nbody\n',
  );
  writeFileSync(
    join(ws, 'state/stories/REQ-23-s1.md'),
    '---\nid: REQ-23-s1\nrequirement: REQ-23\nrepo: toy\nstatus: removed\ndeps: []\noracle: "x"\nbranch: seance/REQ-23-s1\nattempts: 0\n---\n\n## Task\n\nx.\n\n## Attempts ledger\n',
  );
  assert.doesNotThrow(() => removeRequirement(ws, 'REQ-23'));
  assert.doesNotThrow(() => removeRequirement(ws, 'REQ-23'));
  const req23 = readFileSync(join(ws, 'state/requirements/REQ-23.md'), 'utf-8');
  assert.equal((req23.match(/status: removed/g) ?? []).length, 1);
});

test('agentsForRequirement: selects via requirement (planner) and via story->requirement (builder/critic), excludes others', () => {
  const agents = [
    { id: 'planner-1', role: 'planner', pid: 1, story: null, requirement: 'REQ-30' },
    { id: 'builder-1', role: 'builder', pid: 2, story: 'REQ-30-s1', requirement: null },
    { id: 'critic-1', role: 'critic', pid: 3, story: 'REQ-30-s2', requirement: null },
    { id: 'planner-2', role: 'planner', pid: 4, story: null, requirement: 'REQ-31' },
    { id: 'builder-2', role: 'builder', pid: 5, story: 'REQ-31-s1', requirement: null },
    { id: 'builder-3', role: 'builder', pid: 6, story: 'unrelated-story', requirement: null },
  ];
  const stories = [
    { id: 'REQ-30-s1', requirement: 'REQ-30' },
    { id: 'REQ-30-s2', requirement: 'REQ-30' },
    { id: 'REQ-31-s1', requirement: 'REQ-31' },
  ];
  const selected = agentsForRequirement(agents, stories, 'REQ-30');
  assert.deepEqual(
    selected.map((a) => a.id).sort(),
    ['builder-1', 'critic-1', 'planner-1'],
  );
});

test('reapAgents: moves registry files to journal/agents/, calls kill with each pid, idempotent on re-fire', () => {
  const ws = mkdtempSync(join(tmpdir(), 'seance-ws-'));
  mkdirSync(join(ws, 'state/agents'), { recursive: true });
  writeFileSync(
    join(ws, 'state/agents/builder-1.md'),
    '---\nid: builder-1\nrole: builder\npid: 4242\nstory: REQ-40-s1\nrequirement: null\nstarted_at: 2026-07-06T10:00:00Z\n---\n',
  );
  writeFileSync(
    join(ws, 'state/agents/planner-1.md'),
    '---\nid: planner-1\nrole: planner\npid: 4343\nstory: null\nrequirement: REQ-40\nstarted_at: 2026-07-06T10:00:00Z\n---\n',
  );

  const killedPids = [];
  reapAgents(ws, ['builder-1', 'planner-1'], (pid) => killedPids.push(pid));

  assert.deepEqual(killedPids.sort(), [4242, 4343]);
  assert.ok(!existsSync(join(ws, 'state/agents/builder-1.md')));
  assert.ok(!existsSync(join(ws, 'state/agents/planner-1.md')));
  assert.ok(existsSync(join(ws, 'journal/agents/builder-1.md')));
  assert.ok(existsSync(join(ws, 'journal/agents/planner-1.md')));

  // second call: files already moved — skipped, not thrown, kill not re-invoked
  assert.doesNotThrow(() => reapAgents(ws, ['builder-1', 'planner-1'], (pid) => killedPids.push(pid)));
  assert.equal(killedPids.length, 2);
});
