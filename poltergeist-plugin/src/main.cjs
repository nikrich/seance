'use strict';
// Séance plugin — Poltergeist main-process side.
// Consumes the Séance workspace file contract (README): writes ONLY to
// inbox/ (+ this plugin's own dataDir); reads everything else. Heartbeat
// start/stop is process management, not files.

const { spawn } = require('node:child_process');
const {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  watch,
  writeFileSync,
} = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const { readWorkspaceStatus, pidAlive } = require('./lib/state-files.cjs');

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
