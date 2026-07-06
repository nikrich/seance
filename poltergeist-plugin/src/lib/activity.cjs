'use strict';
// Builds the "under the hood" activity feed by merging journal ticks, story
// attempts-ledger verdicts, and attention arrivals. Read-only; malformed or
// missing files degrade to fewer events, never throw.

const { existsSync, readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { parseFrontmatter } = require('./state-files.cjs');

const LEDGER_RE = /^### Attempt (\d+) — ([a-z ()>]+?) \(([^)]+)\)\s*$/;

const LABEL_KIND = {
  'handed off': 'handoff',
  rejected: 'rejected',
  approved: 'approved',
  blocked: 'blocked',
  'agent died': 'agent-died',
  killed: 'tick-kill',
};

function tickEvents(wsPath) {
  const p = join(wsPath, 'journal', 'ticks.ndjson');
  if (!existsSync(p)) return [];
  const events = [];
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let t;
    try {
      t = JSON.parse(line);
    } catch {
      continue;
    }
    if (!t.ts) continue;
    if (t.human) {
      events.push({
        ts: t.ts,
        kind: 'human',
        text: `you: ${t.action ?? 'action'}${t.target ? ' ' + t.target : ''}`,
      });
      continue;
    }
    const spawned = t.spawned ?? {};
    for (const role of ['planner', 'builder', 'critic']) {
      const n = Number(spawned[role] ?? 0);
      if (n > 0) {
        events.push({ ts: t.ts, kind: 'tick-spawn', text: `tick: spawned ${n} ${role}${n > 1 ? 's' : ''}` });
      }
    }
    if (Number(t.reaped ?? 0) > 0) {
      events.push({ ts: t.ts, kind: 'tick-reap', text: `tick: reaped ${t.reaped} agent${t.reaped > 1 ? 's' : ''}` });
    }
    if (Number(t.killed ?? 0) > 0) {
      events.push({ ts: t.ts, kind: 'tick-kill', text: `tick: killed ${t.killed} stuck agent${t.killed > 1 ? 's' : ''}` });
    }
  }
  return events;
}

function ledgerEvents(wsPath) {
  const dir = join(wsPath, 'state', 'stories');
  if (!existsSync(dir)) return [];
  const events = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    let md;
    try {
      md = readFileSync(join(dir, f), 'utf-8');
    } catch {
      continue;
    }
    const { attrs, body } = parseFrontmatter(md);
    const storyId = String(attrs.id ?? f.replace(/\.md$/, ''));
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(LEDGER_RE);
      if (!m) continue;
      const [, n, label, ts] = m;
      const kind = LABEL_KIND[label.trim()] ?? 'handoff';
      // first detail bullet after the heading, if any
      let detail = '';
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const d = lines[j].match(/^- (What failed|What was done):\s*(.*)$/);
        if (d) {
          detail = ' — ' + d[2].slice(0, 160);
          break;
        }
      }
      events.push({ ts, kind, text: `${storyId} attempt ${n} ${label.trim()}${detail}`, storyId });
    }
  }
  return events;
}

function attentionEvents(wsPath) {
  const dir = join(wsPath, 'attention');
  if (!existsSync(dir)) return [];
  const events = [];
  for (const f of readdirSync(dir)) {
    if (f.startsWith('.')) continue;
    let ts;
    try {
      ts = statSync(join(dir, f)).mtime.toISOString();
    } catch {
      continue;
    }
    events.push({ ts, kind: 'attention', text: `needs you: ${f}` });
  }
  return events;
}

function buildActivity(wsPath, limit = 100) {
  const events = [...tickEvents(wsPath), ...ledgerEvents(wsPath), ...attentionEvents(wsPath)];
  events.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return events.slice(0, limit);
}

module.exports = { buildActivity };
