import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readOverview, aggregateWorkspaces } = require('../src/lib/overview.cjs');

function makeWorkspace(root, name) {
  const ws = join(root, name);
  for (const d of ['state/requirements', 'state/stories', 'state/agents', 'attention', 'questions', 'journal']) {
    mkdirSync(join(ws, d), { recursive: true });
  }
  writeFileSync(join(ws, 'config.yaml'), 'workspace: ' + name + '\n');
  return ws;
}

function writeStory(ws, id, status) {
  writeFileSync(
    join(ws, 'state', 'stories', `${id}.md`),
    `---\nid: ${id}\nrequirement: REQ-1\nrepo: toy\nstatus: ${status}\ndeps: []\noracle: "x"\nbranch: seance/${id}\nattempts: 0\n---\n\n## Task\n\nDo the thing.\n\n## Attempts ledger\n`,
  );
}

function writeAgent(ws, id, pid) {
  writeFileSync(
    join(ws, 'state', 'agents', `${id}.md`),
    `---\nid: ${id}\nrole: builder\npid: ${pid}\nstory: null\nstarted_at: 2026-07-06T10:00:00Z\n---\n`,
  );
}

function writeTick(ws, iso) {
  writeFileSync(join(ws, 'journal', 'ticks.ndjson'), `{"ts":"${iso}"}\n`);
}

test('aggregateWorkspaces: totals equal the sum of per-workspace parts', () => {
  const root = mkdtempSync(join(tmpdir(), 'seance-root-'));
  const wsA = makeWorkspace(root, 'alpha');
  writeStory(wsA, 'REQ-1-s1', 'pending');
  writeStory(wsA, 'REQ-1-s2', 'building');
  writeStory(wsA, 'REQ-1-s3', 'verifying');
  writeAgent(wsA, 'builder-1', process.pid);
  writeTick(wsA, '2026-07-06T10:00:00Z');

  const wsB = makeWorkspace(root, 'beta');
  writeStory(wsB, 'REQ-2-s1', 'merged');
  writeStory(wsB, 'REQ-2-s2', 'blocked');
  writeTick(wsB, '2026-07-06T10:00:00Z');

  const now = Date.parse('2026-07-06T10:00:10Z');
  const overview = readOverview(root, { heartbeats: { [wsA]: process.pid }, now });

  assert.equal(overview.totals.workspaces, 2);
  const [a, b] = overview.workspaces;
  assert.deepEqual(overview.totals.lanes, {
    backlog: a.lanes.backlog + b.lanes.backlog,
    building: a.lanes.building + b.lanes.building,
    verifying: a.lanes.verifying + b.lanes.verifying,
    shipped: a.lanes.shipped + b.lanes.shipped,
    blocked: a.lanes.blocked + b.lanes.blocked,
  });
  assert.equal(overview.totals.liveAgents, a.liveAgents + b.liveAgents);
  assert.equal(overview.totals.needsYou, overview.needsYou.length);

  assert.deepEqual(a.lanes, { backlog: 1, building: 1, verifying: 1, shipped: 0, blocked: 0 });
  assert.deepEqual(b.lanes, { backlog: 0, building: 0, verifying: 0, shipped: 1, blocked: 1 });
  assert.equal(a.liveAgents, 1);
  assert.equal(a.blocked, 0);
  assert.equal(b.blocked, 1);
});

test('health derivation: stopped or stale-with-pending-work is unhealthy; running fresh (or no pending work) is healthy', () => {
  const root = mkdtempSync(join(tmpdir(), 'seance-root-'));

  // running, fresh tick, has pending work -> healthy
  const wsRunning = makeWorkspace(root, 'running');
  writeStory(wsRunning, 'REQ-1-s1', 'building');
  writeTick(wsRunning, '2026-07-06T10:00:00Z');

  // stopped (no heartbeat entry), has pending work -> unhealthy
  const wsStopped = makeWorkspace(root, 'stopped');
  writeStory(wsStopped, 'REQ-2-s1', 'building');
  writeTick(wsStopped, '2026-07-06T10:00:00Z');

  // running but stale tick (>900s old), has pending work -> unhealthy
  const wsStale = makeWorkspace(root, 'stale');
  writeStory(wsStale, 'REQ-3-s1', 'building');
  writeTick(wsStale, '2026-07-06T09:00:00Z');

  // running, stale tick, but NO pending work -> healthy
  const wsIdle = makeWorkspace(root, 'idle');
  writeStory(wsIdle, 'REQ-4-s1', 'merged');
  writeTick(wsIdle, '2026-07-06T09:00:00Z');

  const now = Date.parse('2026-07-06T10:00:10Z'); // 10s after fresh tick, 3610s after stale tick

  const heartbeats = {
    [wsRunning]: process.pid,
    [wsStale]: process.pid,
    [wsIdle]: process.pid,
  };

  const overview = readOverview(root, { heartbeats, now });
  const byName = Object.fromEntries(overview.workspaces.map((w) => [w.name, w]));

  assert.equal(byName.running.healthy, true);
  assert.equal(byName.stopped.healthy, false);
  assert.equal(byName.stopped.running, false);
  assert.equal(byName.stale.healthy, false);
  assert.equal(byName.stale.tickAgeSec >= 900, true);
  assert.equal(byName.idle.healthy, true);
});

test('needsYou tagging: attention, spec_review, open question, and unacked feature_pr all surface with workspace + kind', () => {
  const root = mkdtempSync(join(tmpdir(), 'seance-root-'));
  const ws = makeWorkspace(root, 'gamma');

  writeFileSync(join(ws, 'attention', 'REQ-9.md'), 'needs a human');

  writeFileSync(
    join(ws, 'state', 'requirements', 'REQ-5.md'),
    '---\nid: REQ-5\ntitle: Spec me\nstatus: spec_review\npriority: normal\n---\nbody\n',
  );
  writeFileSync(
    join(ws, 'state', 'requirements', 'REQ-6.md'),
    '---\nid: REQ-6\ntitle: Ship me\nstatus: done\npriority: normal\nfeature_pr: https://github.com/x/y/pull/1\n---\nbody\n',
  );

  writeFileSync(
    join(ws, 'questions', 'REQ-5-s1-naming.md'),
    '---\nid: REQ-5-s1-naming\nstory: REQ-5-s1\nrequirement: REQ-5\nstatus: open\nasked_at: 2026-07-09T10:00:00Z\n---\n## Question\n\nTabs or spaces?\n\n## Answer\n',
  );

  const overview = readOverview(root, { heartbeats: {}, now: Date.parse('2026-07-06T10:00:00Z') });

  assert.equal(overview.needsYou.length, 4);
  const byKind = Object.fromEntries(overview.needsYou.map((i) => [i.kind, i]));

  assert.equal(byKind.attention.workspace, 'gamma');
  assert.equal(byKind.attention.id, 'REQ-9.md');
  assert.equal(byKind.attention.tab, 'board');

  assert.equal(byKind.spec_review.id, 'REQ-5');
  assert.equal(byKind.spec_review.title, 'Spec me');
  assert.equal(byKind.spec_review.workspace, 'gamma');

  assert.equal(byKind.question.workspace, 'gamma');
  assert.match(byKind.question.title, /Tabs or spaces/);

  assert.equal(byKind.feature_pr.id, 'REQ-6');
  assert.equal(byKind.feature_pr.workspace, 'gamma');

  const gammaCard = overview.workspaces.find((w) => w.name === 'gamma');
  assert.equal(gammaCard.needsYou, 4);
  assert.equal(overview.totals.needsYou, 4);
});

test('readOverview on an empty/missing root returns zeroed totals, no throw', () => {
  const root = mkdtempSync(join(tmpdir(), 'seance-root-'));
  const overview = readOverview(root, { heartbeats: {}, now: Date.parse('2026-07-06T10:00:00Z') });
  assert.deepEqual(overview.workspaces, []);
  assert.deepEqual(overview.needsYou, []);
  assert.equal(overview.totals.workspaces, 0);
  assert.equal(overview.totals.healthy, 0);
  assert.equal(overview.totals.liveAgents, 0);
  assert.deepEqual(overview.totals.lanes, { backlog: 0, building: 0, verifying: 0, shipped: 0, blocked: 0 });
  assert.equal(overview.totals.requirementsInFlight, 0);
  assert.equal(overview.totals.needsYou, 0);

  const missing = readOverview(join(root, 'does-not-exist'), { heartbeats: {}, now: Date.parse('2026-07-06T10:00:00Z') });
  assert.deepEqual(missing.workspaces, []);
  assert.equal(missing.totals.workspaces, 0);
});

test('degraded case: a workspace whose status read throws becomes a degraded card contributing 0, others still aggregate', () => {
  const root = mkdtempSync(join(tmpdir(), 'seance-root-'));
  const wsGood = makeWorkspace(root, 'good');
  writeStory(wsGood, 'REQ-1-s1', 'building');
  writeTick(wsGood, '2026-07-06T10:00:00Z');
  const wsBad = makeWorkspace(root, 'bad');

  const now = Date.parse('2026-07-06T10:00:05Z');
  const readStatus = (wsPath) => {
    if (wsPath === wsBad) throw new Error('boom: corrupt state file');
    const { readWorkspaceStatus } = require('../src/lib/state-files.cjs');
    return readWorkspaceStatus(wsPath);
  };

  const overview = readOverview(root, { heartbeats: { [wsGood]: process.pid }, now, readStatus });

  assert.equal(overview.workspaces.length, 2);
  const bad = overview.workspaces.find((w) => w.name === 'bad');
  const good = overview.workspaces.find((w) => w.name === 'good');
  assert.equal(bad.error, 'boom: corrupt state file');
  assert.equal(bad.running, false);
  assert.equal(bad.healthy, false);

  assert.equal(good.lanes.building, 1);
  assert.deepEqual(overview.totals.lanes, { backlog: 0, building: 1, verifying: 0, shipped: 0, blocked: 0 });
  assert.equal(overview.totals.workspaces, 2);
});

test('aggregateWorkspaces is pure: same inputs, same now, produce identical results', () => {
  const entries = [
    { name: 'w', path: '/tmp/w', snapshot: { requirements: [], stories: [], agents: [], attention: [], questions: [], backlogCounts: {}, lastTickTs: null }, running: true, error: null },
  ];
  const now = 1751800000000;
  const r1 = aggregateWorkspaces(entries, now);
  const r2 = aggregateWorkspaces(entries, now);
  assert.deepEqual(r1, r2);
});
