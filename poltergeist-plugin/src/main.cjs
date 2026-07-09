'use strict';
// Séance plugin — Poltergeist main-process side.
// Consumes the Séance workspace file contract (README): writes ONLY to
// inbox/ (+ this plugin's own dataDir); reads everything else. Heartbeat
// start/stop is process management, not files.

const { execFile, spawn } = require('node:child_process');
const {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { readWorkspaceStatus, pidAlive } = require('./lib/state-files.cjs');
const { parseFrontmatter } = require('./lib/state-files.cjs');
const { buildActivity } = require('./lib/activity.cjs');
const { createChat } = require('./lib/chat.cjs');
const { withClaudePath } = require('./lib/spawn-env.cjs');

const SEANCE_ROOT = join(homedir(), 'seance');
const DEFAULT_SEANCE_REPO = join(homedir(), 'development', 'nikrich', 'seance');
const REQ_ID_RE = /^[A-Z][A-Z0-9-]{1,31}$/;

let watchers = [];   // [{ wsPath, close() }]
let ctxRef = null;

function assertWorkspace(wsPath) {
  if (typeof wsPath !== 'string') throw new Error('workspace path required');
  const norm = resolve(wsPath);
  if (norm !== SEANCE_ROOT && !norm.startsWith(SEANCE_ROOT + '/')) {
    throw new Error(`workspace must live under ${SEANCE_ROOT}`);
  }
  if (!existsSync(join(norm, 'config.yaml'))) {
    throw new Error(`not a séance workspace (no config.yaml): ${norm}`);
  }
  return norm;
}

function heartbeatsFile(ctx) {
  return join(ctx.dataDir, 'heartbeats.json');
}

function readHeartbeats(ctx) {
  try {
    return JSON.parse(readFileSync(heartbeatsFile(ctx), 'utf-8'));
  } catch {
    return {};
  }
}

function writeHeartbeats(ctx, hb) {
  mkdirSync(ctx.dataDir, { recursive: true });
  writeFileSync(heartbeatsFile(ctx), JSON.stringify(hb, null, 2));
}

function heartbeatStatus(ctx, ws) {
  const hb = readHeartbeats(ctx);
  const pid = hb[ws];
  const running = pid != null && pidAlive(pid);
  return { running, pid: running ? pid : null };
}

function activate(ctx) {
  ctxRef = ctx;

  ctx.ipc.handle('workspaces:list', () => {
    if (!existsSync(SEANCE_ROOT)) return [];
    return readdirSync(SEANCE_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(SEANCE_ROOT, d.name, 'config.yaml')))
      .map((d) => ({ name: d.name, path: join(SEANCE_ROOT, d.name) }));
  });

  ctx.ipc.handle('status', (wsPath) => {
    const ws = assertWorkspace(wsPath);
    return {
      ...readWorkspaceStatus(ws),
      heartbeat: heartbeatStatus(ctx, ws),
    };
  });

  ctx.ipc.handle('summon', (wsPath, req) => {
    const ws = assertWorkspace(wsPath);
    const { id, title, priority, body } = req ?? {};
    if (typeof id !== 'string' || !REQ_ID_RE.test(id)) {
      throw new Error('requirement id must match ^[A-Z][A-Z0-9-]{1,31}$');
    }
    if (typeof title !== 'string' || !title.trim()) throw new Error('title required');
    if (typeof body !== 'string' || !body.trim()) throw new Error('body required');
    const prio = ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';
    const inboxFile = join(ws, 'inbox', `${id}.md`);
    if (existsSync(inboxFile) || existsSync(join(ws, 'state', 'requirements', `${id}.md`))) {
      throw new Error(`requirement ${id} already exists`);
    }
    mkdirSync(join(ws, 'inbox'), { recursive: true });
    writeFileSync(
      inboxFile,
      `---\nid: ${id}\ntitle: ${title.trim()}\npriority: ${prio}\n---\n\n${body.trim()}\n`,
    );
    return { ok: true, file: inboxFile };
  });

  ctx.ipc.handle('steer', (wsPath, text) => {
    const ws = assertWorkspace(wsPath);
    if (typeof text !== 'string' || !text.trim()) throw new Error('steering text required');
    mkdirSync(join(ws, 'inbox'), { recursive: true });
    const file = join(ws, 'inbox', `steer-${Date.now()}.md`);
    writeFileSync(file, text.trim() + '\n');
    return { ok: true, file };
  });

  ctx.ipc.handle('heartbeat:start', (wsPath) => {
    const ws = assertWorkspace(wsPath);
    const existing = heartbeatStatus(ctx, ws);
    if (existing.running) return existing;
    const repo = ctx.settings.get('seanceRepoPath') ?? DEFAULT_SEANCE_REPO;
    const script = join(repo, 'bin', 'heartbeat.sh');
    if (!existsSync(script)) {
      throw new Error(`heartbeat.sh not found at ${script} — set the seanceRepoPath plugin setting`);
    }
    mkdirSync(join(ws, 'logs'), { recursive: true });
    const out = openSync(join(ws, 'logs', 'heartbeat-plugin.log'), 'a');
    const child = spawn('bash', [script, ws], {
      detached: true,
      stdio: ['ignore', out, out],
      env: withClaudePath(),
    });
    child.unref();
    const hb = readHeartbeats(ctx);
    hb[ws] = child.pid;
    writeHeartbeats(ctx, hb);
    ctx.log('heartbeat started', ws, 'pid', child.pid);
    return { running: true, pid: child.pid };
  });

  ctx.ipc.handle('heartbeat:stop', (wsPath) => {
    const ws = assertWorkspace(wsPath);
    const hb = readHeartbeats(ctx);
    const pid = hb[ws];
    if (pid != null) {
      // detached spawn = its own process group; kill the group so the child
      // `claude -p` tick and `sleep` go with it.
      try {
        process.kill(-pid);
      } catch {
        try {
          process.kill(pid);
        } catch {
          // already gone
        }
      }
      delete hb[ws];
      writeHeartbeats(ctx, hb);
      ctx.log('heartbeat stopped', ws);
    }
    return { running: false, pid: null };
  });

  ctx.ipc.handle('heartbeat:status', (wsPath) => heartbeatStatus(ctx, assertWorkspace(wsPath)));

  ctx.ipc.handle('watch:start', (wsPath) => {
    const ws = assertWorkspace(wsPath);
    if (watchers.some((w) => w.wsPath === ws)) return { ok: true };
    let timer = null;
    const notify = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ctx.ipc.send('changed', { wsPath: ws }), 500);
    };
    const handles = [];
    for (const sub of ['state', 'attention', 'journal']) {
      const dir = join(ws, sub);
      if (!existsSync(dir)) continue;
      try {
        handles.push(watch(dir, { recursive: true }, notify));
      } catch (e) {
        ctx.log('watch failed for', dir, e.message);
      }
    }
    watchers.push({
      wsPath: ws,
      close: () => {
        if (timer) clearTimeout(timer);
        for (const h of handles) h.close();
      },
    });
    return { ok: true };
  });

  ctx.ipc.handle('activity', (wsPath, limit) => {
    const ws = assertWorkspace(wsPath);
    return buildActivity(ws, Number.isInteger(limit) && limit > 0 ? limit : 100);
  });

  ctx.ipc.handle('agents:list', (wsPath) => {
    const ws = assertWorkspace(wsPath);
    const readAgents = (dir, source) => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((f) => f.endsWith('.md'))
        .map((f) => {
          const { attrs } = parseFrontmatter(readFileSync(join(dir, f), 'utf-8'));
          const pid = Number(attrs.pid ?? 0);
          return {
            id: String(attrs.id ?? f.replace(/\.md$/, '')),
            role: String(attrs.role ?? ''),
            story: attrs.story == null ? null : String(attrs.story),
            startedAt: String(attrs.started_at ?? ''),
            alive: source === 'live' ? pidAlive(pid) : false,
            source,
          };
        });
    };
    const agents = [
      ...readAgents(join(ws, 'state', 'agents'), 'live'),
      ...readAgents(join(ws, 'journal', 'agents'), 'reaped'),
    ].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
    for (const [id, file] of [['manager', 'manager.log'], ['heartbeat', 'heartbeat-plugin.log']]) {
      if (existsSync(join(ws, 'logs', file))) {
        agents.push({ id, role: id, story: null, startedAt: '', alive: false, source: 'system' });
      }
    }
    return agents;
  });

  ctx.ipc.handle('log:read', (wsPath, agentId, fromByte) => {
    const ws = assertWorkspace(wsPath);
    if (typeof agentId !== 'string' || !/^[\w.-]+$/.test(agentId)) {
      throw new Error('invalid agent id');
    }
    const file =
      agentId === 'manager'
        ? join(ws, 'logs', 'manager.log')
        : agentId === 'heartbeat'
          ? join(ws, 'logs', 'heartbeat-plugin.log')
          : join(ws, 'logs', `${agentId}.log`);
    if (!existsSync(file)) return { chunk: '', nextByte: 0, size: 0 };
    const size = statSync(file).size;
    const CAP = 256 * 1024;
    let start = Number.isInteger(fromByte) && fromByte > 0 ? fromByte : 0;
    if (start === 0 && size > CAP) start = size - CAP; // first read of a huge log: tail it
    if (start >= size) return { chunk: '', nextByte: size, size };
    const len = Math.min(size - start, CAP);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    return { chunk: buf.toString('utf-8'), nextByte: start + len, size };
  });

  const chatApi = createChat({
    dataDir: ctx.dataDir,
    runClaude: (args, cwd, timeoutMs) =>
      new Promise((resolveRun) => {
        execFile(
          'claude',
          args,
          { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: withClaudePath() },
          (err, stdout, stderr) => {
            resolveRun({
              code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
              stdout: stdout ?? '',
              stderr: (stderr ?? '') + (err && !stderr ? ` ${err.message}` : ''),
            });
          },
        );
      }),
  });

  ctx.ipc.handle('chat:send', async (wsPath, text) => {
    const ws = assertWorkspace(wsPath);
    if (typeof text !== 'string' || !text.trim()) throw new Error('message required');
    const model = ctx.settings.get('chatModel') ?? 'sonnet';
    return chatApi.send(ws, text.trim(), model);
  });

  ctx.ipc.handle('chat:history', (wsPath) => chatApi.history(assertWorkspace(wsPath)));

  ctx.ipc.handle('chat:reset', (wsPath) => {
    chatApi.reset(assertWorkspace(wsPath));
    return { ok: true };
  });

  ctx.ipc.handle('watch:stop', (wsPath) => {
    const ws = typeof wsPath === 'string' ? resolve(wsPath) : null;
    watchers = watchers.filter((w) => {
      if (ws === null || w.wsPath === ws) {
        w.close();
        return false;
      }
      return true;
    });
    return { ok: true };
  });
}

function deactivate() {
  for (const w of watchers) w.close();
  watchers = [];
  // heartbeats keep running on purpose — autonomous work outlives the app
  ctxRef = null;
}

module.exports = { activate, deactivate };
