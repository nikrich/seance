'use strict';
// Read-only parsing of a Séance workspace per the file contract in the
// repo README. Yaml-lite frontmatter: scalars, inline arrays, quoted strings —
// exactly what séance state files use, nothing more.

const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } = require('node:fs');
const { join } = require('node:path');

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if (s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseFrontmatter(md) {
  if (!md.startsWith('---')) return { attrs: {}, body: md };
  const end = md.indexOf('\n---', 3);
  if (end === -1) return { attrs: {}, body: md };
  const head = md.slice(3, end);
  const body = md.slice(end + 4).replace(/^\n/, '');
  const attrs = {};
  for (const line of head.split('\n')) {
    const m = line.match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    const v = rawValue.trim();
    if (v.startsWith('[') && v.endsWith(']')) {
      const inner = v.slice(1, -1).trim();
      attrs[key] = inner === '' ? [] : inner.split(',').map((x) => parseScalar(x));
    } else {
      attrs[key] = parseScalar(v);
    }
  }
  return { attrs, body };
}

function readMdDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ name: f, ...parseFrontmatter(readFileSync(join(dir, f), 'utf-8')) }));
}

function storyTitle(body) {
  const m = body.split(/^## Task\s*$/m)[1];
  if (!m) return '';
  for (const line of m.split('\n')) {
    const t = line.trim();
    if (t && !t.startsWith('#')) return t;
  }
  return '';
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lastTickTs(wsPath) {
  const p = join(wsPath, 'journal', 'ticks.ndjson');
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf-8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ts = JSON.parse(lines[i]).ts;
      if (ts) return ts;
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

function readWorkspaceStatus(wsPath) {
  const requirements = readMdDir(join(wsPath, 'state', 'requirements')).map(({ attrs }) => ({
    id: String(attrs.id ?? ''),
    title: String(attrs.title ?? ''),
    status: String(attrs.status ?? ''),
    priority: String(attrs.priority ?? 'normal'),
  }));

  const stories = readMdDir(join(wsPath, 'state', 'stories')).map(({ attrs, body }) => ({
    id: String(attrs.id ?? ''),
    requirement: String(attrs.requirement ?? ''),
    repo: String(attrs.repo ?? ''),
    status: String(attrs.status ?? ''),
    attempts: Number(attrs.attempts ?? 0),
    title: storyTitle(body),
  }));

  const agents = readMdDir(join(wsPath, 'state', 'agents')).map(({ attrs }) => ({
    id: String(attrs.id ?? ''),
    role: String(attrs.role ?? ''),
    pid: Number(attrs.pid ?? 0),
    story: attrs.story == null ? null : String(attrs.story),
    startedAt: String(attrs.started_at ?? ''),
    alive: pidAlive(Number(attrs.pid ?? 0)),
  }));

  const attentionDir = join(wsPath, 'attention');
  const attention = !existsSync(attentionDir)
    ? []
    : readdirSync(attentionDir)
        .filter((f) => !f.startsWith('.'))
        .map((f) => ({ name: f, body: readFileSync(join(attentionDir, f), 'utf-8') }));

  const backlogCounts = {};
  for (const s of stories) backlogCounts[s.status] = (backlogCounts[s.status] ?? 0) + 1;

  // pending inbox items (summoned requirements + steering notes) — files the
  // manager hasn't drained yet; processed/ is a subdirectory, excluded by the
  // .md filter on directory entries
  const inboxDir = join(wsPath, 'inbox');
  const inbox = !existsSync(inboxDir)
    ? []
    : readdirSync(inboxDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => {
          const { attrs } = parseFrontmatter(readFileSync(join(inboxDir, f), 'utf-8'));
          return {
            file: f,
            id: attrs.id == null ? null : String(attrs.id),
            title: String(attrs.title ?? ''),
          };
        });

  return { requirements, stories, agents, attention, inbox, lastTickTs: lastTickTs(wsPath), backlogCounts };
}

// A human "resolving" an attention item = moving it out of attention/ so the
// banner clears, into .dismissed/ so nothing is silently lost (dot-prefixed
// entries are filtered from the attention listing).
function dismissAttention(wsPath, name) {
  if (typeof name !== 'string' || !/^[\w][\w.\- ]*$/.test(name) || name.includes('..')) {
    throw new Error(`invalid attention item: ${name}`);
  }
  const src = join(wsPath, 'attention', name);
  if (!existsSync(src)) throw new Error(`attention item not found: ${name}`);
  const dismissedDir = join(wsPath, 'attention', '.dismissed');
  mkdirSync(dismissedDir, { recursive: true });
  renameSync(src, join(dismissedDir, name));
}

module.exports = { parseFrontmatter, readWorkspaceStatus, pidAlive, dismissAttention };
