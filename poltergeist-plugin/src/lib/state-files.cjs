'use strict';
// Read-only parsing of a Séance workspace per the file contract in the
// repo README. Yaml-lite frontmatter: scalars, inline arrays, quoted strings —
// exactly what séance state files use, nothing more.

const { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } = require('node:fs');
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
  const requirements = readMdDir(join(wsPath, 'state', 'requirements')).map(({ attrs, body }) => ({
    id: String(attrs.id ?? ''),
    title: String(attrs.title ?? ''),
    status: String(attrs.status ?? ''),
    priority: String(attrs.priority ?? 'normal'),
    spec: specSection(body),
    featurePr: attrs.feature_pr == null ? null : String(attrs.feature_pr),
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

  return { requirements, stories, agents, attention, inbox, lastTickTs: lastTickTs(wsPath), backlogCounts, questions: readQuestions(wsPath) };
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

const QUESTION_NAME_RE = /^[\w][\w.\- ]*$/;
const REQ_ID_RE = /^[A-Z][A-Z0-9-]{1,31}$/;

function specSection(body) {
  // stops at the next h2 (## Answer, ## Spec feedback, …) but not at the
  // spec's own ### subheadings
  const m = body.match(/## Spec\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1].trim() : '';
}

function readQuestions(wsPath) {
  const dir = join(wsPath, 'questions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const { attrs, body } = parseFrontmatter(readFileSync(join(dir, f), 'utf-8'));
      const q = body.match(/## Question\n([\s\S]*?)(?=\n## Answer|$)/);
      return {
        file: f,
        id: String(attrs.id ?? f.replace(/\.md$/, '')),
        story: attrs.story == null ? null : String(attrs.story),
        requirement: attrs.requirement == null ? null : String(attrs.requirement),
        status: String(attrs.status ?? 'open'),
        question: q ? q[1].trim() : body.trim(),
      };
    })
    .filter((q) => q.status === 'open');
}

function answerQuestion(wsPath, file, text) {
  if (typeof file !== 'string' || !QUESTION_NAME_RE.test(file) || file.includes('..')) {
    throw new Error(`invalid question file: ${file}`);
  }
  const p = join(wsPath, 'questions', file);
  if (!existsSync(p)) throw new Error(`question not found: ${file}`);
  const raw = readFileSync(p, 'utf-8');
  if (!/^status: open$/m.test(raw)) throw new Error(`question already answered: ${file}`);
  const updated = raw.replace(/^status: open$/m, 'status: answered') + `\n## Answer\n\n${text.trim()}\n`;
  writeFileSync(p, updated);
}

function writeSpec(wsPath, reqId, specText, opts) {
  if (typeof reqId !== 'string' || !REQ_ID_RE.test(reqId)) {
    throw new Error(`invalid requirement id: ${reqId}`);
  }
  const p = join(wsPath, 'state', 'requirements', `${reqId}.md`);
  if (!existsSync(p)) throw new Error(`requirement not found: ${reqId}`);
  let raw = readFileSync(p, 'utf-8');
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const spec = `## Spec\n\n${specText.trim()}\n`;
  raw = /## Spec\n/.test(raw)
    ? raw.replace(/## Spec\n[\s\S]*?(?=\n## |$)/, spec)
    : `${raw.trimEnd()}\n\n${spec}`;
  if (opts.mode === 'approve') {
    raw = raw.replace(/^status: .*$/m, 'status: planning');
    if (!/^spec_approved_at: /m.test(raw)) {
      raw = raw.replace(/^status: planning$/m, `status: planning\nspec_approved_at: ${ts}`);
    }
  } else {
    raw = raw.replace(/^status: .*$/m, 'status: speccing');
    raw = `${raw.trimEnd()}\n\n## Spec feedback (${ts})\n\n${String(opts.feedback ?? '').trim()}\n`;
  }
  writeFileSync(p, raw);
}

module.exports = { parseFrontmatter, readWorkspaceStatus, pidAlive, dismissAttention, answerQuestion, writeSpec };
