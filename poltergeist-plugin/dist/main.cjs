"use strict";
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// src/lib/state-files.cjs
var require_state_files = __commonJS({
  "src/lib/state-files.cjs"(exports2, module2) {
    "use strict";
    var { existsSync: existsSync2, readdirSync: readdirSync2, readFileSync: readFileSync2 } = require("node:fs");
    var { join: join2 } = require("node:path");
    function parseScalar(raw) {
      const s = raw.trim();
      if (s === "") return "";
      if (s === "null") return null;
      if (s === "true") return true;
      if (s === "false") return false;
      if (/^-?\d+$/.test(s)) return Number(s);
      if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
        return s.slice(1, -1);
      }
      return s;
    }
    function parseFrontmatter(md) {
      if (!md.startsWith("---")) return { attrs: {}, body: md };
      const end = md.indexOf("\n---", 3);
      if (end === -1) return { attrs: {}, body: md };
      const head = md.slice(3, end);
      const body = md.slice(end + 4).replace(/^\n/, "");
      const attrs = {};
      for (const line of head.split("\n")) {
        const m = line.match(/^([\w-]+):\s*(.*)$/);
        if (!m) continue;
        const [, key, rawValue] = m;
        const v = rawValue.trim();
        if (v.startsWith("[") && v.endsWith("]")) {
          const inner = v.slice(1, -1).trim();
          attrs[key] = inner === "" ? [] : inner.split(",").map((x) => parseScalar(x));
        } else {
          attrs[key] = parseScalar(v);
        }
      }
      return { attrs, body };
    }
    function readMdDir(dir) {
      if (!existsSync2(dir)) return [];
      return readdirSync2(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, ...parseFrontmatter(readFileSync2(join2(dir, f), "utf-8")) }));
    }
    function storyTitle(body) {
      const m = body.split(/^## Task\s*$/m)[1];
      if (!m) return "";
      for (const line of m.split("\n")) {
        const t = line.trim();
        if (t && !t.startsWith("#")) return t;
      }
      return "";
    }
    function pidAlive2(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
    function lastTickTs(wsPath) {
      const p = join2(wsPath, "journal", "ticks.ndjson");
      if (!existsSync2(p)) return null;
      const lines = readFileSync2(p, "utf-8").trim().split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const ts = JSON.parse(lines[i]).ts;
          if (ts) return ts;
        } catch {
        }
      }
      return null;
    }
    function readWorkspaceStatus2(wsPath) {
      const requirements = readMdDir(join2(wsPath, "state", "requirements")).map(({ attrs }) => ({
        id: String(attrs.id ?? ""),
        title: String(attrs.title ?? ""),
        status: String(attrs.status ?? ""),
        priority: String(attrs.priority ?? "normal")
      }));
      const stories = readMdDir(join2(wsPath, "state", "stories")).map(({ attrs, body }) => ({
        id: String(attrs.id ?? ""),
        requirement: String(attrs.requirement ?? ""),
        repo: String(attrs.repo ?? ""),
        status: String(attrs.status ?? ""),
        attempts: Number(attrs.attempts ?? 0),
        title: storyTitle(body)
      }));
      const agents = readMdDir(join2(wsPath, "state", "agents")).map(({ attrs }) => ({
        id: String(attrs.id ?? ""),
        role: String(attrs.role ?? ""),
        pid: Number(attrs.pid ?? 0),
        story: attrs.story == null ? null : String(attrs.story),
        startedAt: String(attrs.started_at ?? ""),
        alive: pidAlive2(Number(attrs.pid ?? 0))
      }));
      const attentionDir = join2(wsPath, "attention");
      const attention = !existsSync2(attentionDir) ? [] : readdirSync2(attentionDir).filter((f) => !f.startsWith(".")).map((f) => ({ name: f, body: readFileSync2(join2(attentionDir, f), "utf-8") }));
      const backlogCounts = {};
      for (const s of stories) backlogCounts[s.status] = (backlogCounts[s.status] ?? 0) + 1;
      return { requirements, stories, agents, attention, lastTickTs: lastTickTs(wsPath), backlogCounts };
    }
    module2.exports = { parseFrontmatter, readWorkspaceStatus: readWorkspaceStatus2, pidAlive: pidAlive2 };
  }
});

// src/main.cjs
var { spawn } = require("node:child_process");
var {
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  watch,
  writeFileSync
} = require("node:fs");
var { homedir } = require("node:os");
var { join, resolve } = require("node:path");
var { readWorkspaceStatus, pidAlive } = require_state_files();
var SEANCE_ROOT = join(homedir(), "seance");
var DEFAULT_SEANCE_REPO = join(homedir(), "development", "nikrich", "seance");
var REQ_ID_RE = /^[A-Z][A-Z0-9-]{1,31}$/;
var watchers = [];
var ctxRef = null;
function assertWorkspace(wsPath) {
  if (typeof wsPath !== "string") throw new Error("workspace path required");
  const norm = resolve(wsPath);
  if (norm !== SEANCE_ROOT && !norm.startsWith(SEANCE_ROOT + "/")) {
    throw new Error(`workspace must live under ${SEANCE_ROOT}`);
  }
  if (!existsSync(join(norm, "config.yaml"))) {
    throw new Error(`not a s\xE9ance workspace (no config.yaml): ${norm}`);
  }
  return norm;
}
function heartbeatsFile(ctx) {
  return join(ctx.dataDir, "heartbeats.json");
}
function readHeartbeats(ctx) {
  try {
    return JSON.parse(readFileSync(heartbeatsFile(ctx), "utf-8"));
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
  ctx.ipc.handle("workspaces:list", () => {
    if (!existsSync(SEANCE_ROOT)) return [];
    return readdirSync(SEANCE_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(SEANCE_ROOT, d.name, "config.yaml"))).map((d) => ({ name: d.name, path: join(SEANCE_ROOT, d.name) }));
  });
  ctx.ipc.handle("status", (wsPath) => {
    const ws = assertWorkspace(wsPath);
    return {
      ...readWorkspaceStatus(ws),
      heartbeat: heartbeatStatus(ctx, ws)
    };
  });
  ctx.ipc.handle("summon", (wsPath, req) => {
    const ws = assertWorkspace(wsPath);
    const { id, title, priority, body } = req ?? {};
    if (typeof id !== "string" || !REQ_ID_RE.test(id)) {
      throw new Error("requirement id must match ^[A-Z][A-Z0-9-]{1,31}$");
    }
    if (typeof title !== "string" || !title.trim()) throw new Error("title required");
    if (typeof body !== "string" || !body.trim()) throw new Error("body required");
    const prio = ["low", "normal", "high"].includes(priority) ? priority : "normal";
    const inboxFile = join(ws, "inbox", `${id}.md`);
    if (existsSync(inboxFile) || existsSync(join(ws, "state", "requirements", `${id}.md`))) {
      throw new Error(`requirement ${id} already exists`);
    }
    mkdirSync(join(ws, "inbox"), { recursive: true });
    writeFileSync(
      inboxFile,
      `---
id: ${id}
title: ${title.trim()}
priority: ${prio}
---

${body.trim()}
`
    );
    return { ok: true, file: inboxFile };
  });
  ctx.ipc.handle("steer", (wsPath, text) => {
    const ws = assertWorkspace(wsPath);
    if (typeof text !== "string" || !text.trim()) throw new Error("steering text required");
    mkdirSync(join(ws, "inbox"), { recursive: true });
    const file = join(ws, "inbox", `steer-${Date.now()}.md`);
    writeFileSync(file, text.trim() + "\n");
    return { ok: true, file };
  });
  ctx.ipc.handle("heartbeat:start", (wsPath) => {
    const ws = assertWorkspace(wsPath);
    const existing = heartbeatStatus(ctx, ws);
    if (existing.running) return existing;
    const repo = ctx.settings.get("seanceRepoPath") ?? DEFAULT_SEANCE_REPO;
    const script = join(repo, "bin", "heartbeat.sh");
    if (!existsSync(script)) {
      throw new Error(`heartbeat.sh not found at ${script} \u2014 set the seanceRepoPath plugin setting`);
    }
    mkdirSync(join(ws, "logs"), { recursive: true });
    const out = openSync(join(ws, "logs", "heartbeat-plugin.log"), "a");
    const child = spawn("bash", [script, ws], {
      detached: true,
      stdio: ["ignore", out, out]
    });
    child.unref();
    const hb = readHeartbeats(ctx);
    hb[ws] = child.pid;
    writeHeartbeats(ctx, hb);
    ctx.log("heartbeat started", ws, "pid", child.pid);
    return { running: true, pid: child.pid };
  });
  ctx.ipc.handle("heartbeat:stop", (wsPath) => {
    const ws = assertWorkspace(wsPath);
    const hb = readHeartbeats(ctx);
    const pid = hb[ws];
    if (pid != null) {
      try {
        process.kill(-pid);
      } catch {
        try {
          process.kill(pid);
        } catch {
        }
      }
      delete hb[ws];
      writeHeartbeats(ctx, hb);
      ctx.log("heartbeat stopped", ws);
    }
    return { running: false, pid: null };
  });
  ctx.ipc.handle("heartbeat:status", (wsPath) => heartbeatStatus(ctx, assertWorkspace(wsPath)));
  ctx.ipc.handle("watch:start", (wsPath) => {
    const ws = assertWorkspace(wsPath);
    if (watchers.some((w) => w.wsPath === ws)) return { ok: true };
    let timer = null;
    const notify = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ctx.ipc.send("changed", { wsPath: ws }), 500);
    };
    const handles = [];
    for (const sub of ["state", "attention", "journal"]) {
      const dir = join(ws, sub);
      if (!existsSync(dir)) continue;
      try {
        handles.push(watch(dir, { recursive: true }, notify));
      } catch (e) {
        ctx.log("watch failed for", dir, e.message);
      }
    }
    watchers.push({
      wsPath: ws,
      close: () => {
        if (timer) clearTimeout(timer);
        for (const h of handles) h.close();
      }
    });
    return { ok: true };
  });
  ctx.ipc.handle("watch:stop", (wsPath) => {
    const ws = typeof wsPath === "string" ? resolve(wsPath) : null;
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
  ctxRef = null;
}
module.exports = { activate, deactivate };
