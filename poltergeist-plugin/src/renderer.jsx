// Séance plugin UI. Framework-free contract with Poltergeist: we export
// mount(el, api) and bundle our own React. Styling uses the host's theme CSS
// variables (api.theme) with dark fallbacks so the screen blends into the app.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

const COLUMNS = [
  { key: 'backlog', label: 'backlog', statuses: ['pending'] },
  { key: 'building', label: 'building', statuses: ['building'] },
  { key: 'verifying', label: 'verifying', statuses: ['verifying', 'approved'] },
  { key: 'shipped', label: 'shipped', statuses: ['merged', 'pr_open'] },
  { key: 'blocked', label: 'blocked', statuses: ['blocked'] },
];

function useTheme(api) {
  return useMemo(() => {
    const t = api.theme ?? {};
    const v = (name, fallback) => (t[name] && t[name] !== '' ? t[name] : fallback);
    return {
      paper: v('--paper', '#0E0F12'),
      vellum: v('--vellum', '#16181D'),
      fog: v('--fog', '#22252C'),
      hairline: v('--hairline', '#22252C'),
      ink0: v('--ink-0', '#E8E6E3'),
      ink1: v('--ink-1', '#A8A6A3'),
      ink2: v('--ink-2', '#6B6966'),
      neon: v('--neon', '#B8F53D'),
      moss: v('--moss', '#5A8A4A'),
      oxblood: v('--oxblood', '#B33A3A'),
    };
  }, [api]);
}

function relTime(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function Card({ children, theme, tone }) {
  return (
    <div
      style={{
        border: `1px solid ${tone === 'alert' ? theme.oxblood : theme.hairline}`,
        background: theme.vellum,
        borderRadius: 8,
        padding: '8px 10px',
        fontSize: 12,
        color: theme.ink0,
        lineHeight: 1.4,
      }}
    >
      {children}
    </div>
  );
}

const KIND_GLYPH = {
  'tick-spawn': '⚡',
  'tick-reap': '↩',
  'tick-kill': '☠',
  human: '☺',
  handoff: '⇢',
  rejected: '✗',
  approved: '✓',
  blocked: '⛔',
  'agent-died': '☠',
  attention: '⚠',
};

function UnderTheHood({ api, ws, theme, input }) {
  const [events, setEvents] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(null);
  const [logText, setLogText] = useState('');
  const nextByteRef = useRef(0);
  const preRef = useRef(null);
  const atBottomRef = useRef(true);

  const refresh = useCallback(async () => {
    try {
      setEvents(await api.ipc.invoke('activity', ws, 100));
      setAgents(await api.ipc.invoke('agents:list', ws));
    } catch {
      // feed is best-effort; next tick refresh will retry
    }
  }, [api, ws]);

  useEffect(() => {
    void refresh();
    const off = api.ipc.on('changed', (p) => {
      if (p?.wsPath === ws) void refresh();
    });
    const t = setInterval(() => void refresh(), 15000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [api, ws, refresh]);

  // log tailing for the selected agent
  useEffect(() => {
    if (!selected) return;
    let stop = false;
    nextByteRef.current = 0;
    setLogText('');
    const pull = async () => {
      try {
        const r = await api.ipc.invoke('log:read', ws, selected, nextByteRef.current);
        if (stop) return;
        if (r.chunk) {
          nextByteRef.current = r.nextByte;
          setLogText((prev) => (prev + r.chunk).slice(-400000));
        }
      } catch {
        // ignore transient read errors
      }
    };
    void pull();
    const t = setInterval(pull, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [api, ws, selected]);

  useEffect(() => {
    const el = preRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logText]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: selected ? '5fr 7fr' : '1fr', gap: 12, minHeight: 0, flex: 1 }}>
      <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: theme.ink2 }}>
          agents
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {[...agents].sort((a, b) => (a.source === 'system' ? -1 : b.source === 'system' ? 1 : 0)).slice(0, 14).map((a) => (
            <button
              key={a.id}
              onClick={() => setSelected(a.id === selected ? null : a.id)}
              style={{
                background: a.id === selected ? theme.fog : theme.vellum,
                border: `1px solid ${theme.hairline}`,
                borderRadius: 6, padding: '3px 8px', fontSize: 10,
                color: theme.ink1, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5,
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 3, background: a.alive ? theme.moss : theme.ink2, display: 'inline-block' }} />
              {a.id}
            </button>
          ))}
        </div>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: theme.ink2, marginTop: 6 }}>
          activity
        </div>
        {events.map((e, i) => (
          <div
            key={`${e.ts}-${i}`}
            onClick={() => e.agentId && setSelected(e.agentId)}
            style={{
              display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12,
              padding: '5px 8px', borderRadius: 6,
              background: e.kind === 'rejected' || e.kind === 'blocked' || e.kind === 'attention' ? theme.vellum : 'transparent',
              color: theme.ink0, cursor: e.agentId ? 'pointer' : 'default',
            }}
          >
            <span style={{ color: e.kind === 'approved' ? theme.moss : e.kind === 'rejected' || e.kind === 'attention' ? theme.oxblood : theme.ink2 }}>
              {KIND_GLYPH[e.kind] ?? '·'}
            </span>
            <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{e.text}</span>
            <span style={{ fontSize: 10, color: theme.ink2, whiteSpace: 'nowrap' }}>{relTime(e.ts)}</span>
          </div>
        ))}
        {events.length === 0 && <div style={{ fontSize: 12, color: theme.ink2 }}>nothing yet — quiet as the grave.</div>}
      </div>
      {selected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: theme.ink1 }}>{selected}</span>
            <div style={{ flex: 1 }} />
            <button onClick={() => setSelected(null)} style={{ background: theme.fog, color: theme.ink1, border: 'none', borderRadius: 6, fontSize: 11, padding: '3px 10px', cursor: 'pointer' }}>
              close
            </button>
          </div>
          <pre
            ref={preRef}
            onScroll={(ev) => {
              const el = ev.currentTarget;
              atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            }}
            style={{
              flex: 1, minHeight: 0, overflow: 'auto', margin: 0, padding: 10,
              background: theme.paper, border: `1px solid ${theme.hairline}`, borderRadius: 8,
              fontSize: 11, lineHeight: 1.45, color: theme.ink1, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
            }}
          >
            {logText || '(log is empty)'}
          </pre>
        </div>
      )}
    </div>
  );
}

function ChatText({ text }) {
  // tiny markdown-lite: paragraphs, `code`, - lists
  const blocks = text.split(/\n{2,}/);
  return blocks.map((b, i) => {
    const lines = b.split('\n');
    const isList = lines.every((l) => l.trim().startsWith('- ') || !l.trim());
    const renderInline = (s) =>
      s.split(/(`[^`]+`)/).map((part, j) =>
        part.startsWith('`') && part.endsWith('`') ? (
          <code key={j} style={{ background: 'rgba(128,128,128,0.18)', borderRadius: 3, padding: '0 4px', fontSize: '0.92em' }}>
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      );
    if (isList) {
      return (
        <ul key={i} style={{ margin: '4px 0', paddingLeft: 18 }}>
          {lines.filter((l) => l.trim()).map((l, j) => <li key={j}>{renderInline(l.trim().slice(2))}</li>)}
        </ul>
      );
    }
    return <p key={i} style={{ margin: '4px 0' }}>{renderInline(b)}</p>;
  });
}

const STARTERS = ["what's happening right now?", 'why was the last story rejected?', 'what needs me?'];

function Chat({ api, ws, theme }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [focused, setFocused] = useState(false);
  const endRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    api.ipc.invoke('chat:history', ws).then(setMessages).catch(() => setMessages([]));
  }, [api, ws]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, pending]);

  // grow the textarea up to ~5 rows, then scroll internally (matches the host chat)
  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
    el.style.overflowY = el.scrollHeight > 132 ? 'auto' : 'hidden';
  };

  const sendMessage = async (text) => {
    if (!text.trim() || pending) return;
    setDraft('');
    requestAnimationFrame(autosize);
    setPending(true);
    setMessages((m) => [...m, { role: 'user', text, ts: new Date().toISOString() }]);
    try {
      await api.ipc.invoke('chat:send', ws, text);
    } catch {
      // error message is recorded in history by the main side
    } finally {
      setPending(false);
      api.ipc.invoke('chat:history', ws).then(setMessages).catch(() => {});
    }
  };

  const bubbleStyle = (role) => ({
    alignSelf: role === 'user' ? 'flex-end' : 'flex-start',
    maxWidth: '80%',
    whiteSpace: 'pre-wrap',
    background: role === 'user' ? theme.vellum : 'transparent',
    border: role === 'user' ? `1px solid ${theme.hairline}` : role === 'error' ? `1px solid ${theme.oxblood}` : 'none',
    color: role === 'error' ? theme.oxblood : theme.ink0,
    borderRadius: 10,
    padding: role === 'user' ? '10px 14px' : '2px 2px',
    fontSize: 13.5,
    lineHeight: 1.5,
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 6 }}>
        <button
          onClick={() => void api.ipc.invoke('chat:reset', ws).then(() => setMessages([]))}
          disabled={pending}
          title="forget this conversation"
          style={{ background: 'transparent', border: 'none', color: theme.ink2, fontSize: 11, cursor: pending ? 'default' : 'pointer', padding: '2px 4px' }}
        >
          + new séance
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, padding: '4px 2px' }}>
        {messages.length === 0 && !pending && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center', marginTop: 48 }}>
            <div style={{ fontSize: 13, color: theme.ink2 }}>ask the séance anything about this workspace</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {STARTERS.map((s) => (
                <button key={s} onClick={() => void sendMessage(s)} style={{ background: theme.vellum, border: `1px solid ${theme.hairline}`, color: theme.ink1, borderRadius: 14, fontSize: 11.5, padding: '5px 12px', cursor: 'pointer' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={bubbleStyle(m.role)}>
            <ChatText text={m.text} />
          </div>
        ))}
        {pending && (
          <div style={{ ...bubbleStyle('assistant'), color: theme.ink2, fontStyle: 'italic' }}>
            consulting the spirits…
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* single bordered container, borderless textarea + embedded send — mirrors the host chat */}
      <div
        style={{
          display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 10,
          background: theme.vellum, border: `1px solid ${focused ? theme.ink2 : theme.hairline}`,
          borderRadius: 10, padding: '6px 6px 6px 14px', transition: 'border-color 120ms',
        }}
      >
        <textarea
          ref={taRef}
          rows={1}
          value={draft}
          disabled={pending}
          placeholder={pending ? 'the séance is responding…' : 'message the séance…'}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => { setDraft(e.target.value); autosize(); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void sendMessage(draft);
            }
          }}
          style={{
            flex: 1, resize: 'none', overflowY: 'hidden', border: 'none', outline: 'none',
            background: 'transparent', color: theme.ink0, fontFamily: 'inherit',
            fontSize: 13.5, lineHeight: 1.5, padding: '7px 0',
          }}
        />
        <button
          aria-label="send"
          disabled={pending || !draft.trim()}
          onClick={() => void sendMessage(draft)}
          style={{
            width: 32, height: 32, flexShrink: 0, marginBottom: 1, borderRadius: 6, border: 'none',
            background: theme.neon, color: '#0E0F12', fontSize: 15, lineHeight: 1, fontWeight: 700,
            cursor: pending || !draft.trim() ? 'not-allowed' : 'pointer',
            opacity: pending || !draft.trim() ? 0.4 : 1,
          }}
        >
          ↑
        </button>
      </div>
    </div>
  );
}

function App({ api }) {
  const theme = useTheme(api);
  const [workspaces, setWorkspaces] = useState([]);
  const [ws, setWs] = useState(null);
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ id: '', title: '', priority: 'normal', body: '' });
  const [steerText, setSteerText] = useState('');
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState('board');

  const refresh = useCallback(async (path) => {
    if (!path) return;
    try {
      setSnap(await api.ipc.invoke('status', path));
      setError(null);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    api.ipc.invoke('workspaces:list').then((list) => {
      if (!alive) return;
      setWorkspaces(list);
      if (list.length && !ws) setWs(list[0].path);
    }).catch((e) => setError(String(e?.message ?? e)));
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (!ws) return;
    void refresh(ws);
    void api.ipc.invoke('watch:start', ws);
    const off = api.ipc.on('changed', (p) => {
      if (p?.wsPath === ws) void refresh(ws);
    });
    const poll = setInterval(() => void refresh(ws), 15000);
    return () => {
      off();
      clearInterval(poll);
      void api.ipc.invoke('watch:stop', ws);
    };
  }, [ws, api, refresh]);

  const act = async (fn) => {
    try {
      await fn();
      setNotice(null);
      await refresh(ws);
    } catch (e) {
      setNotice(String(e?.message ?? e));
    }
  };

  const hb = snap?.heartbeat ?? { running: false };
  const tickAge = snap?.lastTickTs ? (Date.now() - Date.parse(snap.lastTickTs)) / 1000 : Infinity;
  const pendingWork = (snap?.backlogCounts?.pending ?? 0) + (snap?.backlogCounts?.building ?? 0) + (snap?.backlogCounts?.verifying ?? 0);
  const health = hb.running
    ? tickAge < 900 || pendingWork === 0 ? theme.moss : theme.oxblood
    : theme.ink2;

  const input = {
    background: theme.paper,
    border: `1px solid ${theme.hairline}`,
    borderRadius: 6,
    color: theme.ink0,
    fontSize: 12,
    padding: '6px 8px',
    outline: 'none',
  };
  const btn = (bg, fg) => ({
    background: bg,
    color: fg,
    border: 'none',
    borderRadius: 6,
    fontSize: 12,
    fontWeight: 600,
    padding: '7px 12px',
    cursor: 'pointer',
  });

  return (
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, color: theme.ink0, fontFamily: 'inherit', height: '100%', boxSizing: 'border-box' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 16, fontWeight: 600 }}>séance</span>
        <select value={ws ?? ''} onChange={(e) => { setSnap(null); setWs(e.target.value); }} style={{ ...input, minWidth: 160 }}>
          {workspaces.map((w) => <option key={w.path} value={w.path}>{w.name}</option>)}
        </select>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: health, display: 'inline-block' }} />
        <span style={{ fontSize: 11, color: theme.ink2 }}>
          {hb.running ? `heartbeat running · tick ${relTime(snap?.lastTickTs)}` : `heartbeat stopped · last tick ${relTime(snap?.lastTickTs)}`}
        </span>
        <div style={{ flex: 1 }} />
        <button
          style={btn(hb.running ? theme.fog : theme.neon, hb.running ? theme.ink0 : '#0E0F12')}
          onClick={() => act(() => api.ipc.invoke(hb.running ? 'heartbeat:stop' : 'heartbeat:start', ws))}
        >
          {hb.running ? 'stop heartbeat' : 'start heartbeat'}
        </button>
      </div>

      {/* tabs */}
      <div style={{ display: 'flex', gap: 4, borderBottom: `1px solid ${theme.hairline}` }}>
        {[['board', 'board'], ['hood', 'under the hood'], ['chat', 'chat']].map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '6px 14px', fontSize: 12, fontWeight: tab === key ? 600 : 400,
              color: tab === key ? theme.ink0 : theme.ink2,
              borderBottom: `2px solid ${tab === key ? theme.neon : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <Card theme={theme} tone="alert">{error}</Card>}
      {notice && tab === 'board' && <Card theme={theme} tone="alert">{notice}</Card>}

      {tab === 'hood' && ws && <UnderTheHood api={api} ws={ws} theme={theme} input={input} />}
      {tab === 'chat' && ws && <Chat api={api} ws={ws} theme={theme} />}

      {tab !== 'board' ? null : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, overflowY: 'auto', minHeight: 0 }}>
      {/* attention strip */}
      {snap?.attention?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: theme.oxblood }}>
            needs you ({snap.attention.length})
          </div>
          {snap.attention.map((a) => (
            <Card key={a.name} theme={theme} tone="alert">
              <strong>{a.name}</strong>
              <div style={{ whiteSpace: 'pre-wrap', color: theme.ink1, marginTop: 4, maxHeight: 120, overflow: 'auto' }}>{a.body}</div>
            </Card>
          ))}
        </div>
      )}

      {/* board */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
        {COLUMNS.map((col) => {
          const stories = (snap?.stories ?? []).filter((s) => col.statuses.includes(s.status));
          return (
            <div key={col.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: theme.ink2 }}>
                {col.label} {stories.length > 0 && `· ${stories.length}`}
              </div>
              {stories.map((s) => (
                <Card key={s.id} theme={theme} tone={col.key === 'blocked' ? 'alert' : undefined}>
                  <div style={{ fontFamily: 'monospace', fontSize: 10, color: theme.ink2 }}>{s.id}</div>
                  <div style={{ margin: '3px 0', overflow: 'hidden', textOverflow: 'ellipsis', display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' }}>{s.title || '(untitled)'}</div>
                  <div style={{ display: 'flex', gap: 6, fontSize: 10, color: theme.ink2 }}>
                    <span>{s.repo}</span>
                    {s.attempts > 1 && <span style={{ color: theme.oxblood }}>attempt {s.attempts}</span>}
                  </div>
                </Card>
              ))}
            </div>
          );
        })}
      </div>

      {/* summon */}
      <div style={{ border: `1px solid ${theme.hairline}`, borderRadius: 10, background: theme.vellum, padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>summon</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input style={{ ...input, width: 140 }} placeholder="REQ-42" value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value.toUpperCase() })} />
          <input style={{ ...input, flex: 1 }} placeholder="title" value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <select style={input} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            <option value="low">low</option>
            <option value="normal">normal</option>
            <option value="high">high</option>
          </select>
        </div>
        <textarea style={{ ...input, minHeight: 90, resize: 'vertical', fontFamily: 'inherit' }}
          placeholder="describe what you want and why — acceptance criteria, not implementation steps"
          value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            style={btn(theme.neon, '#0E0F12')}
            disabled={!ws}
            onClick={() => act(async () => {
              await api.ipc.invoke('summon', ws, form);
              setForm({ id: '', title: '', priority: 'normal', body: '' });
            })}
          >
            summon the spirits
          </button>
          <div style={{ flex: 1 }} />
          <input style={{ ...input, flex: 1 }} placeholder='steer: "pause repo x", "REQ-41 first"…'
            value={steerText} onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && steerText.trim()) {
                void act(async () => {
                  await api.ipc.invoke('steer', ws, steerText);
                  setSteerText('');
                });
              }
            }} />
        </div>
      </div>
        </div>
      )}
    </div>
  );
}

export function mount(el, api) {
  const root = createRoot(el);
  root.render(<App api={api} />);
  return () => root.unmount();
}
