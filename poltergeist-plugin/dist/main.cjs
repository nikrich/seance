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
    function parseFrontmatter2(md) {
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
      return readdirSync2(dir).filter((f) => f.endsWith(".md")).map((f) => ({ name: f, ...parseFrontmatter2(readFileSync2(join2(dir, f), "utf-8")) }));
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
    module2.exports = { parseFrontmatter: parseFrontmatter2, readWorkspaceStatus: readWorkspaceStatus2, pidAlive: pidAlive2 };
  }
});

// src/lib/activity.cjs
var require_activity = __commonJS({
  "src/lib/activity.cjs"(exports2, module2) {
    "use strict";
    var { existsSync: existsSync2, readdirSync: readdirSync2, readFileSync: readFileSync2, statSync: statSync2 } = require("node:fs");
    var { join: join2 } = require("node:path");
    var { parseFrontmatter: parseFrontmatter2 } = require_state_files();
    var LEDGER_RE = /^### Attempt (\d+) — ([a-z ()>]+?) \(([^)]+)\)\s*$/;
    var LABEL_KIND = {
      "handed off": "handoff",
      rejected: "rejected",
      approved: "approved",
      blocked: "blocked",
      "agent died": "agent-died",
      killed: "tick-kill"
    };
    function tickEvents(wsPath) {
      const p = join2(wsPath, "journal", "ticks.ndjson");
      if (!existsSync2(p)) return [];
      const events = [];
      for (const line of readFileSync2(p, "utf-8").split("\n")) {
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
            kind: "human",
            text: `you: ${t.action ?? "action"}${t.target ? " " + t.target : ""}`
          });
          continue;
        }
        const spawned = t.spawned ?? {};
        for (const role of ["planner", "builder", "critic"]) {
          const n = Number(spawned[role] ?? 0);
          if (n > 0) {
            events.push({ ts: t.ts, kind: "tick-spawn", text: `tick: spawned ${n} ${role}${n > 1 ? "s" : ""}` });
          }
        }
        if (Number(t.reaped ?? 0) > 0) {
          events.push({ ts: t.ts, kind: "tick-reap", text: `tick: reaped ${t.reaped} agent${t.reaped > 1 ? "s" : ""}` });
        }
        if (Number(t.killed ?? 0) > 0) {
          events.push({ ts: t.ts, kind: "tick-kill", text: `tick: killed ${t.killed} stuck agent${t.killed > 1 ? "s" : ""}` });
        }
      }
      return events;
    }
    function ledgerEvents(wsPath) {
      const dir = join2(wsPath, "state", "stories");
      if (!existsSync2(dir)) return [];
      const events = [];
      for (const f of readdirSync2(dir)) {
        if (!f.endsWith(".md")) continue;
        let md;
        try {
          md = readFileSync2(join2(dir, f), "utf-8");
        } catch {
          continue;
        }
        const { attrs, body } = parseFrontmatter2(md);
        const storyId = String(attrs.id ?? f.replace(/\.md$/, ""));
        const lines = body.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(LEDGER_RE);
          if (!m) continue;
          const [, n, label, ts] = m;
          const kind = LABEL_KIND[label.trim()] ?? "handoff";
          let detail = "";
          for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
            const d = lines[j].match(/^- (What failed|What was done):\s*(.*)$/);
            if (d) {
              detail = " \u2014 " + d[2].slice(0, 160);
              break;
            }
          }
          events.push({ ts, kind, text: `${storyId} attempt ${n} ${label.trim()}${detail}`, storyId });
        }
      }
      return events;
    }
    function attentionEvents(wsPath) {
      const dir = join2(wsPath, "attention");
      if (!existsSync2(dir)) return [];
      const events = [];
      for (const f of readdirSync2(dir)) {
        if (f.startsWith(".")) continue;
        let ts;
        try {
          ts = statSync2(join2(dir, f)).mtime.toISOString();
        } catch {
          continue;
        }
        events.push({ ts, kind: "attention", text: `needs you: ${f}` });
      }
      return events;
    }
    function buildActivity2(wsPath, limit = 100) {
      const events = [...tickEvents(wsPath), ...ledgerEvents(wsPath), ...attentionEvents(wsPath)];
      events.sort((a, b) => a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0);
      return events.slice(0, limit);
    }
    module2.exports = { buildActivity: buildActivity2 };
  }
});

// src/lib/chat.cjs
var require_chat = __commonJS({
  "src/lib/chat.cjs"(exports2, module2) {
    "use strict";
    var { existsSync: existsSync2, mkdirSync: mkdirSync2, readFileSync: readFileSync2, writeFileSync: writeFileSync2 } = require("node:fs");
    var { basename, join: join2 } = require("node:path");
    var PREAMBLE = "Invoke the seance-concierge skill. You are being used as a chat interface inside Poltergeist. ";
    function slugFor(wsPath) {
      return basename(wsPath).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }
    function readJson(p, fallback) {
      try {
        return JSON.parse(readFileSync2(p, "utf-8"));
      } catch {
        return fallback;
      }
    }
    function createChat2({ dataDir, runClaude }) {
      const sessionsFile = () => join2(dataDir, "chat-sessions.json");
      const transcriptFile = (ws) => join2(dataDir, "chat", `${slugFor(ws)}.json`);
      const inFlight = /* @__PURE__ */ new Set();
      function sessions() {
        return readJson(sessionsFile(), {});
      }
      function setSession(ws, id) {
        mkdirSync2(dataDir, { recursive: true });
        const s = sessions();
        if (id === null) delete s[ws];
        else s[ws] = id;
        writeFileSync2(sessionsFile(), JSON.stringify(s, null, 2));
      }
      function history(ws) {
        return readJson(transcriptFile(ws), []);
      }
      function appendMessages(ws, messages) {
        mkdirSync2(join2(dataDir, "chat"), { recursive: true });
        writeFileSync2(transcriptFile(ws), JSON.stringify([...history(ws), ...messages], null, 2));
      }
      async function send(ws, text, model) {
        if (inFlight.has(ws)) {
          throw new Error("the spirits are still deliberating \u2014 wait for the current answer");
        }
        inFlight.add(ws);
        const ts = (/* @__PURE__ */ new Date()).toISOString();
        try {
          const sessionId = sessions()[ws];
          const prompt = sessionId ? text : PREAMBLE + text;
          const args = [
            "-p",
            prompt,
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
            "--model",
            model
          ];
          if (sessionId) args.push("--resume", sessionId);
          const { code, stdout, stderr } = await runClaude(args, ws, 12e4);
          if (code !== 0) {
            throw new Error(`s\xE9ance chat failed: ${(stderr || "no output").slice(-300)}`);
          }
          let parsed;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            throw new Error(`s\xE9ance chat returned unparseable output: ${stdout.slice(-200)}`);
          }
          if (parsed.session_id) setSession(ws, parsed.session_id);
          const answer = String(parsed.result ?? "");
          appendMessages(ws, [
            { role: "user", text, ts },
            { role: "assistant", text: answer, ts: (/* @__PURE__ */ new Date()).toISOString() }
          ]);
          return { answer };
        } catch (err) {
          appendMessages(ws, [
            { role: "user", text, ts },
            { role: "error", text: err instanceof Error ? err.message : String(err), ts: (/* @__PURE__ */ new Date()).toISOString() }
          ]);
          throw err;
        } finally {
          inFlight.delete(ws);
        }
      }
      function reset(ws) {
        setSession(ws, null);
        mkdirSync2(join2(dataDir, "chat"), { recursive: true });
        writeFileSync2(transcriptFile(ws), "[]");
      }
      return { send, history, reset };
    }
    module2.exports = { createChat: createChat2 };
  }
});

// src/lib/spawn-env.cjs
var require_spawn_env = __commonJS({
  "src/lib/spawn-env.cjs"(exports2, module2) {
    "use strict";
    function withClaudePath2(env = process.env) {
      const home = env.HOME ?? "";
      const current = (env.PATH ?? "").split(":").filter(Boolean);
      const missing = ["/opt/homebrew/bin", "/usr/local/bin", home && `${home}/.local/bin`].filter(Boolean).filter((dir) => !current.includes(dir));
      return { ...env, PATH: [...missing, ...current].join(":") };
    }
    module2.exports = { withClaudePath: withClaudePath2 };
  }
});

// src/main.cjs
var { execFile, spawn } = require("node:child_process");
var {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  watch,
  writeFileSync
} = require("node:fs");
var { homedir } = require("node:os");
var { join, resolve } = require("node:path");
var { readWorkspaceStatus, pidAlive } = require_state_files();
var { parseFrontmatter } = require_state_files();
var { buildActivity } = require_activity();
var { createChat } = require_chat();
var { withClaudePath } = require_spawn_env();
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
      stdio: ["ignore", out, out],
      env: withClaudePath()
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
  ctx.ipc.handle("activity", (wsPath, limit) => {
    const ws = assertWorkspace(wsPath);
    return buildActivity(ws, Number.isInteger(limit) && limit > 0 ? limit : 100);
  });
  ctx.ipc.handle("agents:list", (wsPath) => {
    const ws = assertWorkspace(wsPath);
    const readAgents = (dir, source) => {
      if (!existsSync(dir)) return [];
      return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
        const { attrs } = parseFrontmatter(readFileSync(join(dir, f), "utf-8"));
        const pid = Number(attrs.pid ?? 0);
        return {
          id: String(attrs.id ?? f.replace(/\.md$/, "")),
          role: String(attrs.role ?? ""),
          story: attrs.story == null ? null : String(attrs.story),
          startedAt: String(attrs.started_at ?? ""),
          alive: source === "live" ? pidAlive(pid) : false,
          source
        };
      });
    };
    const agents = [
      ...readAgents(join(ws, "state", "agents"), "live"),
      ...readAgents(join(ws, "journal", "agents"), "reaped")
    ].sort((a, b) => a.startedAt < b.startedAt ? 1 : -1);
    for (const [id, file] of [["manager", "manager.log"], ["heartbeat", "heartbeat-plugin.log"]]) {
      if (existsSync(join(ws, "logs", file))) {
        agents.push({ id, role: id, story: null, startedAt: "", alive: false, source: "system" });
      }
    }
    return agents;
  });
  ctx.ipc.handle("log:read", (wsPath, agentId, fromByte) => {
    const ws = assertWorkspace(wsPath);
    if (typeof agentId !== "string" || !/^[\w.-]+$/.test(agentId)) {
      throw new Error("invalid agent id");
    }
    const file = agentId === "manager" ? join(ws, "logs", "manager.log") : agentId === "heartbeat" ? join(ws, "logs", "heartbeat-plugin.log") : join(ws, "logs", `${agentId}.log`);
    if (!existsSync(file)) return { chunk: "", nextByte: 0, size: 0 };
    const size = statSync(file).size;
    const CAP = 256 * 1024;
    let start = Number.isInteger(fromByte) && fromByte > 0 ? fromByte : 0;
    if (start === 0 && size > CAP) start = size - CAP;
    if (start >= size) return { chunk: "", nextByte: size, size };
    const len = Math.min(size - start, CAP);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buf, 0, len, start);
    } finally {
      closeSync(fd);
    }
    return { chunk: buf.toString("utf-8"), nextByte: start + len, size };
  });
  const chatApi = createChat({
    dataDir: ctx.dataDir,
    runClaude: (args, cwd, timeoutMs) => new Promise((resolveRun) => {
      execFile(
        "claude",
        args,
        { cwd, timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024, env: withClaudePath() },
        (err, stdout, stderr) => {
          resolveRun({
            code: err ? typeof err.code === "number" ? err.code : 1 : 0,
            stdout: stdout ?? "",
            stderr: (stderr ?? "") + (err && !stderr ? ` ${err.message}` : "")
          });
        }
      );
    })
  });
  ctx.ipc.handle("chat:send", async (wsPath, text) => {
    const ws = assertWorkspace(wsPath);
    if (typeof text !== "string" || !text.trim()) throw new Error("message required");
    const model = ctx.settings.get("chatModel") ?? "sonnet";
    return chatApi.send(ws, text.trim(), model);
  });
  ctx.ipc.handle("chat:history", (wsPath) => chatApi.history(assertWorkspace(wsPath)));
  ctx.ipc.handle("chat:reset", (wsPath) => {
    chatApi.reset(assertWorkspace(wsPath));
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
