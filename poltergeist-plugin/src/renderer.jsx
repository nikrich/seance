// Séance plugin UI. Framework-free contract with Poltergeist: we export
// mount(el, api) and bundle our own React. Styling uses the host's theme CSS
// variables (api.theme) with dark fallbacks so the screen blends into the app.

import { useCallback, useEffect, useMemo, useState } from 'react';
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

function App({ api }) {
  const theme = useTheme(api);
  const [workspaces, setWorkspaces] = useState([]);
  const [ws, setWs] = useState(null);
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ id: '', title: '', priority: 'normal', body: '' });
  const [steerText, setSteerText] = useState('');
  const [notice, setNotice] = useState(null);

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
    <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16, color: theme.ink0, fontFamily: 'inherit' }}>
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

      {error && <Card theme={theme} tone="alert">{error}</Card>}
      {notice && <Card theme={theme} tone="alert">{notice}</Card>}

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
  );
}

export function mount(el, api) {
  const root = createRoot(el);
  root.render(<App api={api} />);
  return () => root.unmount();
}
