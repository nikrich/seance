'use strict';
// Cross-workspace overview aggregation — pure math in aggregateWorkspaces(),
// IO (enumerate workspaces, read each snapshot) in readOverview(). Lane
// mapping and the heartbeat health rule mirror renderer.jsx's COLUMNS /
// header health check byte-for-byte; keep them in sync if either changes.

const { existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
const { readWorkspaceStatus, pidAlive } = require('./state-files.cjs');

const LANE_STATUSES = {
  backlog: ['pending'],
  building: ['building'],
  verifying: ['verifying', 'approved'],
  shipped: ['merged', 'pr_open'],
  blocked: ['blocked'],
};

function emptyLanes() {
  return { backlog: 0, building: 0, verifying: 0, shipped: 0, blocked: 0 };
}

function laneCounts(stories) {
  const lanes = emptyLanes();
  for (const s of stories) {
    for (const lane of Object.keys(LANE_STATUSES)) {
      if (LANE_STATUSES[lane].includes(s.status)) {
        lanes[lane]++;
        break;
      }
    }
  }
  return lanes;
}

function needsYouItems(name, path, snapshot) {
  const items = [];
  for (const a of snapshot.attention ?? []) {
    items.push({ workspace: name, path, kind: 'attention', id: a.name, title: a.name, tab: 'board' });
  }
  for (const r of snapshot.requirements ?? []) {
    if (r.status === 'spec_review') {
      items.push({ workspace: name, path, kind: 'spec_review', id: r.id, title: r.title, tab: 'board' });
    }
  }
  for (const q of snapshot.questions ?? []) {
    items.push({ workspace: name, path, kind: 'question', id: q.id, title: q.question, tab: 'board' });
  }
  for (const r of snapshot.requirements ?? []) {
    if (r.featurePr && r.status === 'done' && r.featurePrAck !== true) {
      items.push({ workspace: name, path, kind: 'feature_pr', id: r.id, title: r.title, tab: 'board' });
    }
  }
  return items;
}

function aggregateWorkspaces(entries, now = Date.now()) {
  const workspaces = [];
  const needsYou = [];
  const totals = {
    workspaces: entries.length,
    healthy: 0,
    liveAgents: 0,
    lanes: emptyLanes(),
    requirementsInFlight: 0,
    needsYou: 0,
  };

  for (const entry of entries) {
    const { name, path, snapshot, running, error } = entry;

    if (error != null || snapshot == null) {
      workspaces.push({ name, path, error: error ?? 'unknown error', running: false, healthy: false });
      continue;
    }

    const lanes = laneCounts(snapshot.stories ?? []);
    const liveAgents = (snapshot.agents ?? []).filter((a) => a.alive === true).length;
    const requirementsInFlight = (snapshot.requirements ?? []).filter(
      (r) => r.status === 'speccing' || r.status === 'planning',
    ).length;
    const items = needsYouItems(name, path, snapshot);

    const tickAgeSec = snapshot.lastTickTs ? (now - Date.parse(snapshot.lastTickTs)) / 1000 : Infinity;
    const pendingWork =
      (snapshot.backlogCounts?.pending ?? 0) +
      (snapshot.backlogCounts?.building ?? 0) +
      (snapshot.backlogCounts?.verifying ?? 0);
    const healthy = running && (tickAgeSec < 900 || pendingWork === 0);

    workspaces.push({
      name,
      path,
      error: null,
      running,
      lastTickTs: snapshot.lastTickTs,
      tickAgeSec,
      healthy,
      lanes,
      liveAgents,
      requirementsInFlight,
      blocked: lanes.blocked,
      needsYou: items.length,
    });

    needsYou.push(...items);

    totals.healthy += healthy ? 1 : 0;
    totals.liveAgents += liveAgents;
    totals.requirementsInFlight += requirementsInFlight;
    for (const lane of Object.keys(totals.lanes)) totals.lanes[lane] += lanes[lane];
  }

  totals.needsYou = needsYou.length;

  return { workspaces, totals, needsYou };
}

function readOverview(root, { heartbeats = {}, now = Date.now(), readStatus = readWorkspaceStatus } = {}) {
  if (!existsSync(root)) return aggregateWorkspaces([], now);

  const wsDirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, 'config.yaml')))
    .map((d) => ({ name: d.name, path: join(root, d.name) }));

  const entries = wsDirs.map(({ name, path }) => {
    try {
      const snapshot = readStatus(path);
      const running = heartbeats[path] != null && pidAlive(heartbeats[path]);
      return { name, path, snapshot, running, error: null };
    } catch (e) {
      return { name, path, snapshot: null, running: false, error: String(e.message ?? e) };
    }
  });

  return aggregateWorkspaces(entries, now);
}

module.exports = { aggregateWorkspaces, readOverview };
