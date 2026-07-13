// Séance plugin UI. Framework-free contract with Poltergeist: we export
// mount(el, api) and bundle our own React. Styling uses the host's theme CSS
// variables — the guaranteed api.theme set as fallbacks, plus the host's
// extended tokens via var() (the plugin renders in the host document, so
// they resolve live and follow theme switches). Layout and states follow the
// "Séance — summon & watch the fleet" screen in the ghostbrain Design System.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Check,
  Cog,
  Compass,
  Ghost,
  GitBranch,
  Hammer,
  HeartCrack,
  LayoutGrid,
  MessageSquare,
  Moon,
  Cpu,
  RotateCcw,
  ScanEye,
  Skull,
  Sparkles,
  Square,
  Terminal,
  User,
  X,
} from 'lucide-react';

const COLUMNS = [
  { key: 'backlog', label: 'backlog', tone: 'outline', statuses: ['pending'] },
  { key: 'building', label: 'building', tone: 'neon', statuses: ['building'] },
  { key: 'verifying', label: 'verifying', tone: 'fog', statuses: ['verifying', 'approved'] },
  { key: 'shipped', label: 'shipped', tone: 'moss', statuses: ['merged', 'pr_open'] },
  { key: 'blocked', label: 'blocked', tone: 'oxblood', statuses: ['blocked'] },
];

// Extended host tokens with dark fallbacks. The api.theme contract guarantees
// only the core set; everything else falls back if the host ever renames it.
function useTheme(api) {
  return useMemo(() => {
    const t = api.theme ?? {};
    const v = (name, fallback) => (t[name] && t[name] !== '' ? t[name] : fallback);
    const core = {
      paper: v('--paper', '#0E0F12'),
      vellum: v('--vellum', '#15171B'),
      fog: v('--fog', '#1E2026'),
      hairline: v('--hairline', '#22252C'),
      hairline2: v('--hairline-2', 'rgba(242,243,245,0.14)'),
      ink0: v('--ink-0', '#E8E6E3'),
      ink1: v('--ink-1', '#A8A6A3'),
      ink2: v('--ink-2', '#6B6966'),
      neon: v('--neon', '#B8F53D'),
      moss: v('--moss', '#5A8A4A'),
      oxblood: v('--oxblood', '#B33A3A'),
    };
    // live var() references, falling back to the contract-resolved values
    return {
      ...core,
      ink3: `var(--ink-3, ${core.ink2})`,
      hairline3: `var(--hairline-3, ${core.hairline2})`,
      neonInk: `var(--neon-ink, ${core.neon})`,
      neonMist: 'var(--neon-mist, #1F2A0A)',
      mossMist: 'var(--moss-mist, #16201A)',
      oxbloodMist: 'var(--oxblood-mist, #2A1411)',
      pillMossFg: `var(--pill-moss-fg, ${core.moss})`,
      pillOxbloodFg: `var(--pill-oxblood-fg, ${core.oxblood})`,
      rSm: 'var(--r-sm, 4px)',
      rMd: 'var(--r-md, 8px)',
      rLg: 'var(--r-lg, 12px)',
      rPill: 'var(--r-pill, 999px)',
      fontMono: "var(--font-mono, ui-monospace, 'SF Mono', Menlo, monospace)",
      fontDisplay: 'var(--font-display, inherit)',
    };
  }, [api]);
}

function relTime(iso) {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '\u2014'; // ledger headings sometimes carry text where the ts belongs
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

// ---- small DS-alike primitives (the host's components aren't importable
// from a plugin, so these mirror Pill/Btn/Panel/Eyebrow on the same tokens) --

function Pill({ theme, tone = 'fog', title, children }) {
  const tones = {
    neon: { background: theme.neonMist, color: theme.neonInk, border: '1px solid transparent' },
    moss: { background: theme.mossMist, color: theme.pillMossFg, border: '1px solid transparent' },
    oxblood: { background: theme.oxbloodMist, color: theme.pillOxbloodFg, border: '1px solid transparent' },
    fog: { background: theme.fog, color: theme.ink1, border: '1px solid transparent' },
    outline: { background: 'transparent', color: theme.ink2, border: `1px solid ${theme.hairline2}` },
  };
  return (
    <span title={title} style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 9px', borderRadius: theme.rPill,
      fontFamily: theme.fontMono, fontSize: 10.5, lineHeight: 1.6, whiteSpace: 'nowrap',
      ...(tones[tone] ?? tones.fog),
    }}>{children}</span>
  );
}

function Eyebrow({ theme, children }) {
  return (
    <span style={{
      fontFamily: theme.fontMono, fontSize: 10, textTransform: 'uppercase',
      letterSpacing: '0.1em', color: theme.ink2,
    }}>{children}</span>
  );
}

function Btn({ theme, variant = 'ghost', icon, disabled, onClick, title, children }) {
  const variants = {
    primary: { background: theme.neon, color: '#0E0F12', border: '1px solid transparent', fontWeight: 600 },
    ghost: { background: 'transparent', color: theme.ink1, border: `1px solid ${theme.hairline2}` },
    danger: { background: theme.oxblood, color: '#FFF', border: '1px solid transparent', fontWeight: 600 },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        padding: '7px 13px', borderRadius: theme.rSm, fontSize: 12, fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1,
        ...(variants[variant] ?? variants.ghost),
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function Panel({ theme, title, subtitle, action, children, style }) {
  return (
    <section style={{
      border: `1px solid ${theme.hairline}`, borderRadius: theme.rLg,
      background: theme.vellum, display: 'flex', flexDirection: 'column', minHeight: 0, ...style,
    }}>
      <header style={{
        display: 'flex', alignItems: 'baseline', gap: 10,
        borderBottom: `1px solid ${theme.hairline}`, padding: '11px 15px',
      }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink0 }}>{title}</span>
        {subtitle && <Eyebrow theme={theme}>{subtitle}</Eyebrow>}
        {action && <span style={{ marginLeft: 'auto' }}>{action}</span>}
      </header>
      <div style={{ padding: '13px 15px', minHeight: 0, display: 'flex', flexDirection: 'column' }}>{children}</div>
    </section>
  );
}

// ---- workspace config form ----------------------------------------------

const BLANK_REPO = { name: '', url: '', default_branch: 'main', integration: 'pr', test_command: '' };
const BLANK_CONFIG = {
  workspace: '',
  repos: [{ ...BLANK_REPO }],
  max_builders: 3, max_critics: 2, max_planner: 1, max_agent_minutes: 45, attempt_cap: 3,
  models: { manager: 'haiku', planner: 'opus', builder: 'sonnet', critic: 'opus' },
  sleep: { active: 60, idle: 600 },
  inbox_feeds: [],
  autonomy: { auto_approve_specs: false, auto_merge: false },
};
const MODEL_OPTIONS = ['haiku', 'sonnet', 'opus'];
const repoNameFromUrl = (url) => (url.split('/').pop() ?? '').replace(/\.git$/, '').trim();

function Field({ theme, label, children, width }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5, width, minWidth: 0 }}>
      <Eyebrow theme={theme}>{label}</Eyebrow>
      {children}
    </label>
  );
}

function Segmented({ theme, value, options, onChange, disabled }) {
  return (
    <div style={{ display: 'inline-flex', gap: 3, padding: 3, background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm }}>
      {options.map((o) => {
        const on = value === o;
        return (
          <button key={o} type="button" disabled={disabled} onClick={() => onChange(o)} style={{
            padding: '5px 11px', borderRadius: 4, cursor: disabled ? 'not-allowed' : 'pointer', border: 'none',
            background: on ? theme.neonMist : 'transparent',
            color: on ? theme.neonInk : theme.ink2,
            fontFamily: theme.fontMono, fontSize: 11, fontWeight: on ? 600 : 500,
          }}>{o}</button>
        );
      })}
    </div>
  );
}

function WorkspaceForm({ theme, mode, initial, busy, error, cloneResults, onSubmit }) {
  const [cfg, setCfg] = useState(initial ?? BLANK_CONFIG);
  const [name, setName] = useState('');
  useEffect(() => { if (initial) setCfg(initial); }, [initial]);

  const field = {
    fontFamily: 'inherit', fontSize: 13, color: theme.ink0,
    background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
    padding: '8px 11px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  const numField = { ...field, fontFamily: theme.fontMono, fontSize: 12 };
  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setRepo = (i, patch) => setCfg((c) => ({ ...c, repos: c.repos.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));
  const num = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? 0 : n; };
  const feeds = cfg.inbox_feeds ?? [];
  const setFeed = (i, value) => setCfg((c) => ({ ...c, inbox_feeds: (c.inbox_feeds ?? []).map((f, j) => (j === i ? value : f)) }));

  const clientErrors = [];
  if (mode === 'create' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) clientErrors.push('workspace name: letters, digits, . _ - only');
  if (!cfg.repos.some((r) => r.url.trim())) clientErrors.push('at least one repo with a url');
  if (feeds.some((f) => typeof f !== 'string' || !f.startsWith('/'))) clientErrors.push('inbox_feeds entries must be absolute paths');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 860 }}>
      {mode === 'create' && (
        <Panel theme={theme} title="workspace" subtitle="lives under ~/seance/<name>">
          <Field theme={theme} label="name">
            <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12, maxWidth: 280 }} placeholder="my-project"
              value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          </Field>
        </Panel>
      )}

      <Panel theme={theme} title="repos" subtitle="the fleet works these"
        action={<Btn theme={theme} variant="ghost" disabled={busy}
          onClick={() => set({ repos: [...cfg.repos, { ...BLANK_REPO }] })}>+ add repo</Btn>}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {cfg.repos.map((r, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingBottom: 12, borderBottom: i < cfg.repos.length - 1 ? `1px solid ${theme.hairline}` : 'none' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto auto', gap: 10, alignItems: 'end' }}>
                <Field theme={theme} label="git url">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }} placeholder="git@github.com:you/repo.git"
                    value={r.url} disabled={busy}
                    onChange={(e) => {
                      const url = e.target.value;
                      const derived = repoNameFromUrl(url);
                      setRepo(i, { url, ...(r.name === '' || r.name === repoNameFromUrl(r.url) ? { name: derived } : {}) });
                    }} />
                </Field>
                <Field theme={theme} label="name">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }} value={r.name} disabled={busy}
                    onChange={(e) => setRepo(i, { name: e.target.value })} />
                </Field>
                <Field theme={theme} label="branch">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12, width: 110 }} value={r.default_branch} disabled={busy}
                    onChange={(e) => setRepo(i, { default_branch: e.target.value })} />
                </Field>
                <button type="button" title="remove repo" disabled={busy || cfg.repos.length === 1}
                  onClick={() => set({ repos: cfg.repos.filter((_, j) => j !== i) })}
                  style={{ background: 'transparent', border: 'none', color: theme.ink3, cursor: cfg.repos.length === 1 ? 'not-allowed' : 'pointer', padding: 6 }}>
                  <X size={14} />
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 10, alignItems: 'end' }}>
                <Field theme={theme} label="integration">
                  <Segmented theme={theme} value={r.integration} options={['pr', 'merge', 'feature-pr']} onChange={(v) => setRepo(i, { integration: v })} disabled={busy} />
                </Field>
                <Field theme={theme} label="test command (critic runs this on every verdict)">
                  <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }} placeholder="npm test"
                    value={r.test_command} disabled={busy} onChange={(e) => setRepo(i, { test_command: e.target.value })} />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel theme={theme} title="feed directories" subtitle="outboxes séance drains into this workspace (e.g. ouija)"
        action={<Btn theme={theme} variant="ghost" disabled={busy}
          onClick={() => set({ inbox_feeds: [...feeds, ''] })}>+ add feed</Btn>}>
        {feeds.length === 0 ? (
          <span style={{ fontSize: 12, color: theme.ink3 }}>no feeds — séance only drains its own inbox/</span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {feeds.map((f, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }} placeholder="/Users/you/ouija/outbox"
                  value={f} disabled={busy} onChange={(e) => setFeed(i, e.target.value)} />
                <button type="button" title="remove feed" disabled={busy}
                  onClick={() => set({ inbox_feeds: feeds.filter((_, j) => j !== i) })}
                  style={{ background: 'transparent', border: 'none', color: theme.ink3, cursor: 'pointer', padding: 6 }}>
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <Panel theme={theme} title="limits" subtitle="fleet size & safety rails">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {[['max_builders', 'builders'], ['max_critics', 'critics'], ['max_planner', 'planners'], ['max_agent_minutes', 'agent minutes'], ['attempt_cap', 'attempt cap']].map(([k, label]) => (
              <Field key={k} theme={theme} label={label}>
                <input type="number" min="1" style={numField} value={cfg[k]} disabled={busy}
                  onChange={(e) => set({ [k]: num(e.target.value) })} />
              </Field>
            ))}
          </div>
        </Panel>
        <Panel theme={theme} title="models & cadence" subtitle="claude aliases · heartbeat sleep">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
            {['manager', 'planner', 'builder', 'critic'].map((role) => (
              <Field key={role} theme={theme} label={role}>
                <select style={{ ...numField, cursor: 'pointer' }} value={cfg.models[role]} disabled={busy}
                  onChange={(e) => set({ models: { ...cfg.models, [role]: e.target.value } })}>
                  {MODEL_OPTIONS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            ))}
            <Field theme={theme} label="active sleep (s)">
              <input type="number" min="1" style={numField} value={cfg.sleep.active} disabled={busy}
                onChange={(e) => set({ sleep: { ...cfg.sleep, active: num(e.target.value) } })} />
            </Field>
            <Field theme={theme} label="idle sleep (s)">
              <input type="number" min="1" style={numField} value={cfg.sleep.idle} disabled={busy}
                onChange={(e) => set({ sleep: { ...cfg.sleep, idle: num(e.target.value) } })} />
            </Field>
          </div>
        </Panel>
      </div>

      <Panel theme={theme} title="autonomy" subtitle="opt-in — remove the human gates">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10 }}>
          <Field theme={theme} label="auto-approve specs">
            <Segmented theme={theme} value={(cfg.autonomy?.auto_approve_specs ?? false) ? 'on' : 'off'} options={['off', 'on']}
              onChange={(v) => set({ autonomy: { ...cfg.autonomy, auto_approve_specs: v === 'on' } })} disabled={busy} />
          </Field>
          <Field theme={theme} label="auto-merge PRs">
            <Segmented theme={theme} value={(cfg.autonomy?.auto_merge ?? false) ? 'on' : 'off'} options={['off', 'on']}
              onChange={(v) => set({ autonomy: { ...cfg.autonomy, auto_merge: v === 'on' } })} disabled={busy} />
          </Field>
        </div>
      </Panel>

      {(error || clientErrors.length > 0) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: theme.oxbloodMist, border: `1px solid ${theme.oxblood}`, borderRadius: theme.rMd, padding: '9px 13px', fontSize: 12.5, color: theme.pillOxbloodFg }}>
          <AlertTriangle size={14} color={theme.oxblood} style={{ flexShrink: 0 }} />
          <span>{error ?? clientErrors.join(' · ')}</span>
        </div>
      )}

      {cloneResults?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cloneResults.map((c) => (
            <div key={c.name} style={{ display: 'flex', alignItems: 'center', gap: 8, fontFamily: theme.fontMono, fontSize: 11.5, color: c.ok ? theme.pillMossFg : theme.pillOxbloodFg }}>
              {c.ok ? <Check size={12} /> : <X size={12} />}
              <span>{c.name}</span>
              {!c.ok && <span style={{ color: theme.ink2, overflowWrap: 'anywhere' }}>— {c.error} (check ssh keys / gh auth, then save to retry)</span>}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {busy && (
          <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.ink2, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span className="seance-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: theme.neon }} />
            {mode === 'create' ? 'summoning workspace… cloning repos can take a minute' : 'saving…'}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <Btn theme={theme} variant="primary" icon={<Sparkles size={13} />} disabled={busy || clientErrors.length > 0}
          onClick={() => onSubmit(mode === 'create' ? { name, config: cfg } : { config: cfg })}>
          {mode === 'create' ? 'create workspace' : 'save config'}
        </Btn>
      </div>
    </div>
  );
}

function ConfigTab({ theme, api, ws, initialCloneResults, onConsumedCloneResults }) {
  const [initial, setInitial] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [cloneResults, setCloneResults] = useState(null);
  const [savedAt, setSavedAt] = useState(null);

  useEffect(() => {
    setInitial(null); setError(null); setSavedAt(null);
    setCloneResults(initialCloneResults ?? null);
    if (initialCloneResults) onConsumedCloneResults?.();
    api.ipc.invoke('workspace:config:read', ws).then(setInitial).catch((e) => setError(String(e?.message ?? e)));
    // initialCloneResults/onConsumedCloneResults intentionally excluded: this
    // should only re-seed on mount/ws change, not whenever the parent's
    // callback identity or (already-nulled) clones prop happens to change.
  }, [api, ws]);

  if (!initial && !error) return <SkeletonNote theme={theme} text="reading config…" />;
  return (
    <div style={{ overflowY: 'auto', minHeight: 0, paddingBottom: 4 }}>
      {savedAt && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontFamily: theme.fontMono, fontSize: 11.5, color: theme.pillMossFg }}>
          <Check size={12} /> config saved
        </div>
      )}
      <WorkspaceForm theme={theme} mode="edit" initial={initial} busy={busy} error={error} cloneResults={cloneResults}
        onSubmit={async ({ config }) => {
          setBusy(true); setError(null); setSavedAt(null);
          try {
            const r = await api.ipc.invoke('workspace:config:write', ws, config);
            setCloneResults(r.clones); setSavedAt(Date.now());
          } catch (e) { setError(String(e?.message ?? e)); }
          finally { setBusy(false); }
        }} />
    </div>
  );
}

function SkeletonNote({ theme, text }) {
  return <div style={{ fontSize: 12, color: theme.ink3, padding: '8px 2px' }}>{text}</div>;
}

// ---- board -----------------------------------------------------------------

const KIND_ICON = {
  'tick-spawn': [Sparkles, 'neon'],
  'tick-reap': [Moon, 'ink'],
  'tick-kill': [Square, 'oxblood'],
  human: [User, 'ink'],
  handoff: [ArrowRight, 'ink'],
  rejected: [X, 'oxblood'],
  approved: [Check, 'moss'],
  blocked: [AlertOctagon, 'oxblood'],
  'agent-died': [Skull, 'oxblood'],
  attention: [AlertTriangle, 'oxblood'],
};

function StoryCard({ theme, story, colKey }) {
  const blocked = colKey === 'blocked';
  const shipped = colKey === 'shipped';
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: theme.paper,
        border: `1px solid ${hover && !blocked ? theme.hairline3 : theme.hairline}`,
        borderLeft: blocked ? `2px solid ${theme.oxblood}` : undefined,
        borderRadius: theme.rMd,
        padding: '10px 11px',
        display: 'flex', flexDirection: 'column', gap: 7,
        opacity: shipped ? 0.82 : 1,
        transition: 'border-color 120ms',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.ink2, letterSpacing: '0.02em' }}>{story.id}</span>
        <span style={{ flex: 1 }} />
        {story.attempts > 1 && (
          <span title="attempts" style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            fontFamily: theme.fontMono, fontSize: 10,
            color: blocked ? theme.pillOxbloodFg : theme.ink2,
          }}>
            <RotateCcw size={10} />×{story.attempts}
          </span>
        )}
      </div>
      <div style={{
        fontSize: 13, lineHeight: 1.4, color: shipped ? theme.ink1 : theme.ink0,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
      }}>{story.title || '(untitled)'}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Pill theme={theme} tone={COLUMNS.find((c) => c.key === colKey)?.tone ?? 'fog'}>
          {colKey === 'building' && <span className="seance-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: theme.neon }} />}
          {colKey === 'backlog' ? 'queued' : colKey}
        </Pill>
        <span style={{ flex: 1 }} />
        {story.repo && <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.ink3 }}>{story.repo}</span>}
      </div>
    </div>
  );
}

function HeartbeatBanner({ theme, lastTickTs, onRevive, busy }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: theme.oxbloodMist, border: `1px solid ${theme.oxblood}`,
      borderRadius: theme.rMd, padding: '11px 15px',
    }}>
      <HeartCrack size={18} color={theme.oxblood} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink0 }}>the heartbeat is quiet</div>
        <div style={{ fontSize: 12, color: theme.pillOxbloodFg, marginTop: 1 }}>
          last tick {relTime(lastTickTs)} — no new spawns until the séance is revived.
        </div>
      </div>
      <Btn theme={theme} variant="danger" icon={<Activity size={13} />} onClick={onRevive} disabled={busy}>
        revive séance
      </Btn>
    </div>
  );
}

// ---- waiting on you: spec reviews, questions, feature PRs ----------------

// markdown-lite for specs: ##/### headings, - bullets, **bold**, `code`.
// Same spirit as ChatText, plus the heading/bold vocabulary planner specs use.
function MdLite({ theme, text }) {
  const inline = (s) =>
    s.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, j) =>
      part.startsWith('`') && part.endsWith('`') ? (
        <code key={j} style={{ background: 'rgba(128,128,128,0.18)', borderRadius: 3, padding: '0 4px', fontFamily: theme.fontMono, fontSize: '0.9em' }}>{part.slice(1, -1)}</code>
      ) : part.startsWith('**') && part.endsWith('**') ? (
        <strong key={j} style={{ color: theme.ink0, fontWeight: 600 }}>{part.slice(2, -2)}</strong>
      ) : (
        part
      ),
    );
  const heading = {
    fontFamily: theme.fontMono, fontSize: 10.5, textTransform: 'uppercase',
    letterSpacing: '0.1em', color: theme.ink2, marginTop: 6,
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, fontSize: 13, lineHeight: 1.55, color: theme.ink1 }}>
      {text.split('\n').map((l, i) => {
        const t = l.trim();
        if (t === '') return null;
        const h = t.match(/^#{2,4}\s+(.*)$/);
        if (h) return <div key={i} style={{ ...heading, marginTop: i === 0 ? 0 : 6 }}>{h[1]}</div>;
        if (t.startsWith('- ')) {
          return (
            <div key={i} style={{ display: 'flex', gap: 8, paddingLeft: 4 }}>
              <span style={{ color: theme.ink3, flexShrink: 0 }}>•</span>
              <span style={{ minWidth: 0 }}>{inline(t.slice(2))}</span>
            </div>
          );
        }
        return <div key={i}>{inline(t)}</div>;
      })}
    </div>
  );
}

function SpecReviewCard({ theme, api, ws, act, req }) {
  const [text, setText] = useState(req.spec);
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);
  useEffect(() => setText(req.spec), [req.id, req.spec]);
  const field = {
    fontFamily: theme.fontMono, fontSize: 12, lineHeight: 1.55, color: theme.ink0,
    background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
    padding: '9px 11px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };
  return (
    <Panel
      theme={theme}
      title={`spec review — ${req.id}`}
      subtitle={req.title}
      action={
        <Btn theme={theme} variant="ghost" onClick={() => setEditing((e) => !e)}>
          {editing ? 'preview' : 'edit'}
        </Btn>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {editing ? (
          <textarea rows={10} style={{ ...field, resize: 'vertical', minHeight: 140 }}
            value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <div style={{
            maxHeight: 340, overflowY: 'auto', padding: '10px 12px',
            background: theme.paper, border: `1px solid ${theme.hairline}`, borderRadius: theme.rSm,
          }}>
            <MdLite theme={theme} text={text} />
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, alignItems: 'center' }}>
          <input style={{ ...field, fontFamily: 'inherit', fontSize: 12.5 }}
            placeholder="feedback for the planner (required to request changes)"
            value={feedback} onChange={(e) => setFeedback(e.target.value)} />
          <Btn theme={theme} variant="ghost" disabled={!feedback.trim()}
            onClick={() => act(() => api.ipc.invoke('spec:revise', ws, req.id, text, feedback))}>
            request changes
          </Btn>
          <Btn theme={theme} variant="primary" icon={<Check size={13} />} disabled={!text.trim()}
            onClick={() => act(() => api.ipc.invoke('spec:approve', ws, req.id, text))}>
            approve spec
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

function QuestionCard({ theme, api, ws, act, q }) {
  const [answer, setAnswer] = useState('');
  return (
    <Panel theme={theme} title={`the séance asks — ${q.story ?? q.requirement}`} subtitle={q.file}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5, color: theme.ink1, maxHeight: 180, overflowY: 'auto' }}>{q.question}</div>
        <div style={{ display: 'flex', gap: 10 }}>
          <input
            style={{
              flex: 1, fontFamily: 'inherit', fontSize: 12.5, color: theme.ink0,
              background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
              padding: '9px 11px', outline: 'none',
            }}
            placeholder="your answer — unblocks the story on the next tick"
            value={answer} onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && answer.trim()) {
                void act(() => api.ipc.invoke('question:answer', ws, q.file, answer));
              }
            }}
          />
          <Btn theme={theme} variant="primary" disabled={!answer.trim()}
            onClick={() => act(() => api.ipc.invoke('question:answer', ws, q.file, answer))}>
            answer
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

// A requirement being specced or decomposed has no stories, no inbox entry,
// and no waiting-on-you card — without this row the board looks like the
// summon did nothing for the minutes the planner is working.
function InTheWorks({ theme, snap }) {
  const reqs = (snap?.requirements ?? []).filter((r) => r.status === 'speccing' || r.status === 'planning');
  if (reqs.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {reqs.map((r) => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: theme.vellum, border: `1px solid ${theme.hairline}`,
          borderRadius: theme.rMd, padding: '9px 13px',
        }}>
          <span className="seance-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: theme.neon, flexShrink: 0 }} />
          <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.ink2 }}>{r.id}</span>
          <span style={{ fontSize: 12.5, color: theme.ink1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {r.title}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.ink2, whiteSpace: 'nowrap' }}>
            {r.status === 'speccing'
              ? 'the séance is researching & drafting the spec — review lands here'
              : 'spec approved — decomposing into stories'}
          </span>
        </div>
      ))}
    </div>
  );
}

function WaitingOnYou({ theme, api, ws, act, snap }) {
  const specs = (snap?.requirements ?? []).filter((r) => r.status === 'spec_review');
  const questions = snap?.questions ?? [];
  const prs = (snap?.requirements ?? []).filter((r) => r.featurePr && r.status === 'done' && !r.featurePrAck);
  const count = specs.length + questions.length + prs.length;
  if (count === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={12} color={theme.neon} />
        <Eyebrow theme={theme}>waiting on you · {count}</Eyebrow>
      </div>
      {specs.map((r) => <SpecReviewCard key={r.id} theme={theme} api={api} ws={ws} act={act} req={r} />)}
      {questions.map((q) => <QuestionCard key={q.file} theme={theme} api={api} ws={ws} act={act} q={q} />)}
      {prs.map((r) => (
        <div key={r.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: theme.neonMist, border: `1px solid ${theme.neon}`,
          borderRadius: theme.rMd, padding: '10px 13px', fontSize: 12.5,
        }}>
          <GitBranch size={14} color={theme.neonInk} />
          <span style={{ color: theme.ink0, fontWeight: 600 }}>{r.id}</span>
          <span style={{ color: theme.ink1, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title} — feature complete, one PR awaits your merge</span>
          <Btn theme={theme} variant="ghost" onClick={() => api.openExternal(r.featurePr)}>open PR</Btn>
          <Btn theme={theme} variant="ghost" onClick={() => act(() => api.ipc.invoke('feature-pr:ack', ws, r.id))}>dismiss</Btn>
        </div>
      ))}
    </div>
  );
}

function Board({ theme, snap, hb, ws, act, api, form, setForm, steerText, setSteerText }) {
  const stories = snap?.stories ?? [];
  const inbox = snap?.inbox ?? [];
  const priorities = ['low', 'normal', 'high'];
  const [queued, setQueued] = useState(null);
  // null = auto (open only when the board is empty); the strips and columns
  // grow over time and were pushing the capture form out of sight
  const [composerOpen, setComposerOpen] = useState(null);
  const showComposer = composerOpen ?? ((snap?.stories ?? []).length === 0);

  useEffect(() => {
    if (!queued) return;
    const t = setTimeout(() => setQueued(null), 8000);
    return () => clearTimeout(t);
  }, [queued]);

  const field = {
    fontFamily: 'inherit', fontSize: 13, color: theme.ink0,
    background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
    padding: '8px 11px', outline: 'none', width: '100%', boxSizing: 'border-box',
  };

  const composer = showComposer ? (
    <Panel
      theme={theme}
      title="summon a requirement"
      subtitle="acceptance criteria, not implementation"
      action={<Btn theme={theme} variant="ghost" onClick={() => setComposerOpen(false)}>collapse</Btn>}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr auto', gap: 10, alignItems: 'center' }}>
          <input
            style={{ ...field, fontFamily: theme.fontMono, fontSize: 12 }}
            placeholder="REQ-42"
            value={form.id}
            onChange={(e) => setForm({ ...form, id: e.target.value.toUpperCase() })}
          />
          <input
            style={field}
            placeholder="title — one line"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
          <div style={{
            display: 'inline-flex', gap: 3, padding: 3,
            background: theme.paper, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rSm,
          }}>
            {priorities.map((p) => {
              const on = form.priority === p;
              return (
                <button key={p} onClick={() => setForm({ ...form, priority: p })} style={{
                  padding: '5px 11px', borderRadius: 4, cursor: 'pointer', border: 'none',
                  background: on ? theme.neonMist : 'transparent',
                  color: on ? theme.neonInk : theme.ink2,
                  fontFamily: theme.fontMono, fontSize: 11, fontWeight: on ? 600 : 500,
                }}>{p}</button>
              );
            })}
          </div>
        </div>
        <textarea
          rows={3}
          style={{ ...field, resize: 'vertical', lineHeight: 1.5, minHeight: 76 }}
          placeholder="describe what you want and why — acceptance criteria, not implementation steps"
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            fontFamily: theme.fontMono, fontSize: 10.5, color: theme.ink3,
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}>
            <Sparkles size={12} color="currentColor" />
            the planner will split this into stories before spawning
          </span>
          <span style={{ flex: 1 }} />
          <Btn
            theme={theme}
            variant="primary"
            icon={<Sparkles size={13} />}
            disabled={!ws}
            onClick={() => act(async () => {
              const id = form.id;
              await api.ipc.invoke('summon', ws, form);
              setForm({ id: '', title: '', priority: 'normal', body: '' });
              setQueued(`${id} is in the inbox — the séance is waking to plan it`);
            })}
          >
            summon
          </Btn>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, borderTop: `1px solid ${theme.hairline}`, paddingTop: 10 }}>
          <Compass size={13} color={theme.ink3} style={{ flexShrink: 0 }} />
          <input
            style={{ ...field, border: 'none', background: 'transparent', padding: '2px 0', fontSize: 12.5 }}
            placeholder='steer the running séance: "pause repo x", "REQ-41 first"…'
            value={steerText}
            onChange={(e) => setSteerText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && steerText.trim()) {
                void act(async () => {
                  await api.ipc.invoke('steer', ws, steerText);
                  setSteerText('');
                  setQueued('steering note queued — the séance is waking to read it');
                });
              }
            }}
          />
        </div>
      </div>
    </Panel>
  ) : (
    <button
      type="button"
      onClick={() => setComposerOpen(true)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
        background: theme.vellum, border: `1px dashed ${theme.hairline2}`, borderRadius: theme.rMd,
        padding: '10px 13px', cursor: 'pointer', fontFamily: 'inherit',
      }}
    >
      <Sparkles size={13} color={theme.neonInk} />
      <span style={{ fontSize: 13, color: theme.ink1 }}>summon a requirement…</span>
      <span style={{ flex: 1 }} />
      <span style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: theme.ink3 }}>acceptance criteria, not implementation</span>
    </button>
  );

  return (
    <div className="seance-scroll-col" style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', minHeight: 0, paddingBottom: 4 }}>
      {snap && !hb.running && (
        <HeartbeatBanner
          theme={theme}
          lastTickTs={snap?.lastTickTs}
          onRevive={() => act(() => api.ipc.invoke('heartbeat:start', ws))}
        />
      )}

      <WaitingOnYou theme={theme} api={api} ws={ws} act={act} snap={snap} />
      <InTheWorks theme={theme} snap={snap} />

      {snap?.attention?.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <AlertTriangle size={12} color={theme.oxblood} />
            <Eyebrow theme={theme}>needs you · {snap.attention.length}</Eyebrow>
          </div>
          {snap.attention.map((a) => (
            <div key={a.name} style={{
              background: theme.oxbloodMist, border: `1px solid ${theme.oxblood}`,
              borderRadius: theme.rMd, padding: '10px 13px', fontSize: 12.5, lineHeight: 1.45,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ color: theme.ink0, flex: 1, minWidth: 0 }}>{a.name}</strong>
                <button
                  type="button"
                  title="dismiss — moves it to attention/.dismissed/"
                  onClick={() => act(() => api.ipc.invoke('attention:dismiss', ws, a.name))}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                    background: 'transparent', border: `1px solid ${theme.oxblood}`,
                    color: theme.pillOxbloodFg, borderRadius: theme.rPill,
                    padding: '2px 10px', fontFamily: theme.fontMono, fontSize: 10.5, flexShrink: 0,
                  }}
                >
                  <X size={11} /> dismiss
                </button>
              </div>
              <div style={{ whiteSpace: 'pre-wrap', color: theme.pillOxbloodFg, marginTop: 4, maxHeight: 120, overflow: 'auto' }}>{a.body}</div>
            </div>
          ))}
        </div>
      )}

      {queued && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: theme.mossMist, border: `1px solid ${theme.moss}`,
          borderRadius: theme.rMd, padding: '9px 13px', fontSize: 12.5, color: theme.pillMossFg,
        }}>
          <Check size={14} color={theme.moss} style={{ flexShrink: 0 }} />
          <span>{queued}</span>
        </div>
      )}

      {inbox.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <Eyebrow theme={theme}>inbox · {inbox.length} awaiting the next tick</Eyebrow>
          {inbox.map((i) => (
            <Pill key={i.file} theme={theme} tone="outline" title={i.title}>
              {i.id ?? 'note'}
            </Pill>
          ))}
        </div>
      )}

      {composer}

      {snap && stories.length === 0 ? (
        <Panel theme={theme} title="board" subtitle={inbox.length > 0 ? 'the séance is on its way' : 'nothing summoned yet'}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '28px 20px' }}>
            <LayoutGrid size={22} color={theme.ink3} />
            <div style={{ fontSize: 13, color: theme.ink2, textAlign: 'center', maxWidth: 420, lineHeight: 1.5 }}>
              {inbox.length > 0
                ? `${inbox.filter((i) => i.id).map((i) => i.id).join(', ') || 'your note'} is waiting in the inbox — stories appear here once the planner has split it.`
                : 'the board is quiet. summon your first requirement below and the séance will split it into stories and spawn a fleet.'}
            </div>
          </div>
        </Panel>
      ) : (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12,
          opacity: snap && !hb.running ? 0.62 : 1, filter: snap && !hb.running ? 'saturate(0.7)' : 'none',
          transition: 'opacity 200ms',
        }}>
          {COLUMNS.map((col) => {
            const items = stories.filter((s) => col.statuses.includes(s.status));
            return (
              <div key={col.key} style={{ display: 'flex', flexDirection: 'column', gap: 9, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 20, padding: '0 2px' }}>
                  <Eyebrow theme={theme}>{col.label}</Eyebrow>
                  <Pill theme={theme} tone={col.tone}>{items.length}</Pill>
                </div>
                {items.length === 0 ? (
                  <div style={{
                    border: `1px dashed ${theme.hairline2}`, borderRadius: theme.rMd,
                    padding: '13px 10px', fontFamily: theme.fontMono, fontSize: 10.5,
                    color: theme.ink3, textAlign: 'center',
                  }}>empty</div>
                ) : (
                  items.map((s) => <StoryCard key={s.id} theme={theme} story={s} colKey={col.key} />)
                )}
              </div>
            );
          })}
        </div>
      )}

    </div>
  );
}

// ---- under the hood --------------------------------------------------------

const ROLE_ICON = {
  planner: Compass,
  builder: Hammer,
  critic: ScanEye,
  manager: Cog,
  heartbeat: Activity,
};

function agentPill(a) {
  if (a.source === 'system') return ['system', 'outline'];
  if (a.source === 'reaped') return ['reaped', 'fog'];
  return a.alive ? ['alive', 'neon'] : ['dead', 'oxblood'];
}

function LogTail({ theme, api, ws, agentId }) {
  const [logText, setLogText] = useState('');
  const [paused, setPaused] = useState(false);
  const nextByteRef = useRef(0);
  const boxRef = useRef(null);

  useEffect(() => {
    if (!agentId) return;
    let stop = false;
    nextByteRef.current = 0;
    setLogText('');
    setPaused(false);
    const pull = async () => {
      try {
        const r = await api.ipc.invoke('log:read', ws, agentId, nextByteRef.current);
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
  }, [api, ws, agentId]);

  useEffect(() => {
    const el = boxRef.current;
    if (el && !paused) el.scrollTop = el.scrollHeight;
  }, [logText, paused, agentId]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    setPaused(el.scrollHeight - el.scrollTop - el.clientHeight >= 32);
  };

  const colorFor = (ln) => {
    const s = ln.trimStart();
    if (s.startsWith('✗') || s.startsWith('fatal') || s.startsWith('Error')) return theme.pillOxbloodFg;
    if (s.startsWith('✓')) return theme.pillMossFg;
    if (s.startsWith('$')) return theme.neonInk;
    if (s.startsWith('[')) return theme.ink3;
    return theme.ink1;
  };

  // color only the visible tail; the backlog stays one cheap block
  const lines = logText.split('\n');
  const tail = lines.slice(-800);
  const head = lines.length > 800 ? lines.slice(0, -800).join('\n') : '';

  return (
    <section style={{
      border: `1px solid ${theme.hairline}`, borderRadius: theme.rLg, background: theme.vellum,
      display: 'flex', flexDirection: 'column', minHeight: 0,
    }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, borderBottom: `1px solid ${theme.hairline}`, padding: '10px 14px' }}>
        <Terminal size={14} color={theme.ink2} />
        <span style={{ fontSize: 13, fontWeight: 500, color: theme.ink0 }}>log tail</span>
        <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.ink2 }}>{agentId ?? '—'}</span>
        <span style={{ flex: 1 }} />
        {paused ? (
          <button onClick={() => setPaused(false)} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            border: `1px solid ${theme.neon}`, background: theme.neonMist, color: theme.neonInk,
            borderRadius: theme.rPill, padding: '3px 10px', fontFamily: theme.fontMono, fontSize: 10.5,
          }}>
            <ArrowDown size={11} /> scroll paused · resume
          </button>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: theme.fontMono, fontSize: 10.5, color: theme.ink2 }}>
            <span className="seance-dot" style={{ width: 6, height: 6, borderRadius: '50%', background: theme.neon }} /> following
          </span>
        )}
      </header>
      <div
        ref={boxRef}
        onScroll={onScroll}
        style={{
          flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 15px', background: theme.paper,
          borderRadius: `0 0 ${'var(--r-lg, 12px)'} ${'var(--r-lg, 12px)'}`,
          fontFamily: theme.fontMono, fontSize: 11.5, lineHeight: 1.6,
          whiteSpace: 'pre-wrap', overflowWrap: 'anywhere',
        }}
      >
        {!logText && <span style={{ color: theme.ink3 }}>(log is empty)</span>}
        {head && <div style={{ color: theme.ink3 }}>{head}</div>}
        {tail.map((ln, i) => (
          <div key={i} style={{ color: colorFor(ln) }}>{ln || ' '}</div>
        ))}
      </div>
    </section>
  );
}

function UnderTheHood({ theme, api, ws }) {
  const [events, setEvents] = useState([]);
  const [agents, setAgents] = useState([]);
  const [selected, setSelected] = useState(null);

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

  // default the tail to the most interesting agent: first live one, else first
  useEffect(() => {
    if (selected || agents.length === 0) return;
    setSelected((agents.find((a) => a.alive) ?? agents[0]).id);
  }, [agents, selected]);

  const roster = useMemo(
    () => [...agents].sort((a, b) => (a.source === 'system' ? 1 : b.source === 'system' ? -1 : 0)).slice(0, 20),
    [agents],
  );
  const alive = agents.filter((a) => a.alive).length;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'minmax(230px, 3fr) minmax(210px, 3fr) minmax(0, 6fr)',
      gap: 12, alignItems: 'stretch', flex: 1, minHeight: 0,
    }}>
      <Panel theme={theme} title="activity" subtitle="live · newest first" style={{ minHeight: 0 }}>
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          {events.length === 0 && (
            <div style={{ fontSize: 12, color: theme.ink3, padding: '6px 2px' }}>nothing yet — quiet as the grave.</div>
          )}
          {events.map((e, i) => {
            const [Icon, tone] = KIND_ICON[e.kind] ?? [Moon, 'ink'];
            const color = tone === 'neon' ? theme.neon
              : tone === 'moss' ? theme.pillMossFg
                : tone === 'oxblood' ? theme.pillOxbloodFg
                  : theme.ink2;
            return (
              <div
                key={`${e.ts}-${i}`}
                onClick={() => e.agentId && setSelected(e.agentId)}
                style={{
                  display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 2px',
                  borderTop: i === 0 ? 'none' : `1px solid ${theme.hairline}`,
                  fontSize: 12, cursor: e.agentId ? 'pointer' : 'default',
                }}
              >
                <Icon size={12} color={color} style={{ flexShrink: 0, alignSelf: 'center' }} />
                <span style={{ flex: 1, minWidth: 0, color: theme.ink0, overflowWrap: 'anywhere', lineHeight: 1.4 }}>{e.text}</span>
                <span style={{ fontFamily: theme.fontMono, fontSize: 10, color: theme.ink3, whiteSpace: 'nowrap' }}>{relTime(e.ts)}</span>
              </div>
            );
          })}
        </div>
      </Panel>

      <Panel theme={theme} title="roster" subtitle={`${alive} alive · ${agents.length} total`} style={{ minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, overflowY: 'auto', minHeight: 0 }}>
          {roster.map((a) => {
            const on = selected === a.id;
            const dead = !a.alive && a.source !== 'system';
            const Icon = ROLE_ICON[a.role] ?? ROLE_ICON[a.id] ?? Ghost;
            const [label, tone] = agentPill(a);
            return (
              <button
                key={`${a.source}-${a.id}`}
                onClick={() => setSelected(a.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%',
                  padding: '8px 10px', cursor: 'pointer', borderRadius: theme.rSm,
                  border: `1px solid ${on ? theme.hairline3 : 'transparent'}`,
                  background: on ? theme.fog : 'transparent',
                  opacity: a.source === 'reaped' ? 0.55 : 1,
                  fontFamily: 'inherit',
                }}
              >
                <Icon size={15} color={dead ? theme.ink3 : on ? theme.neon : theme.ink2} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 12.5, color: theme.ink0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.id}</span>
                  {a.story && <span style={{ display: 'block', fontFamily: theme.fontMono, fontSize: 10, color: theme.ink2, marginTop: 1 }}>{a.story}</span>}
                </span>
                <Pill theme={theme} tone={tone}>{label}</Pill>
              </button>
            );
          })}
          {roster.length === 0 && <div style={{ fontSize: 12, color: theme.ink3, padding: '6px 2px' }}>no agents yet.</div>}
        </div>
      </Panel>

      <LogTail theme={theme} api={api} ws={ws} agentId={selected} />
    </div>
  );
}

// ---- chat --------------------------------------------------------------

function ChatText({ text, theme, onLink }) {
  // markdown-lite for concierge answers: paragraphs, - lists, `code`,
  // **bold**, [links](url) (opened externally, never navigated), ###
  // headings, and pipe tables. Anything fancier renders as its raw text.
  const inline = (s) =>
    s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/).map((part, j) => {
      if (part.startsWith('`') && part.endsWith('`')) {
        return (
          <code key={j} style={{ background: 'rgba(128,128,128,0.18)', borderRadius: 3, padding: '0 4px', fontSize: '0.92em', fontFamily: theme.fontMono }}>
            {part.slice(1, -1)}
          </code>
        );
      }
      if (part.startsWith('**') && part.endsWith('**')) {
        return <strong key={j} style={{ color: theme.ink0, fontWeight: 600 }}>{part.slice(2, -2)}</strong>;
      }
      const link = part.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/);
      if (link) {
        return (
          <a key={j} href={link[2]}
            onClick={(e) => { e.preventDefault(); onLink?.(link[2]); }}
            style={{ color: theme.neonInk, textDecoration: 'underline', textUnderlineOffset: 2, cursor: 'pointer' }}>
            {link[1]}
          </a>
        );
      }
      return part;
    });

  const cell = { padding: '5px 10px', borderBottom: `1px solid ${theme.hairline}`, textAlign: 'left', verticalAlign: 'top' };

  const renderTable = (lines, key) => {
    const rows = lines
      .filter((l) => !/^\s*\|[\s\-|:]+\|\s*$/.test(l)) // drop the separator row
      .map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
    const [head, ...body] = rows;
    return (
      <div key={key} style={{ overflowX: 'auto', margin: '6px 0' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: '0.94em', minWidth: '60%' }}>
          <thead>
            <tr>{head.map((c, k) => (
              <th key={k} style={{ ...cell, fontFamily: theme.fontMono, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.08em', color: theme.ink2, borderBottom: `1px solid ${theme.hairline2}` }}>{inline(c)}</th>
            ))}</tr>
          </thead>
          <tbody>
            {body.map((r, k) => <tr key={k}>{r.map((c, m) => <td key={m} style={{ ...cell, color: theme.ink1 }}>{inline(c)}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
    );
  };

  // Group each block's lines into runs — the concierge often glues a bold
  // heading straight onto a table (single newline), so type is decided per
  // consecutive line-run, never per whole block.
  const lineType = (l) => (l.trim().startsWith('|') ? 'table' : l.trim().startsWith('- ') ? 'list' : 'text');
  const blocks = text.split(/\n{2,}/);
  return blocks.map((b, i) => {
    const lines = b.split('\n').filter((l) => l.trim());
    const runs = [];
    for (const l of lines) {
      const t = lineType(l);
      if (runs.length && runs[runs.length - 1].type === t) runs[runs.length - 1].lines.push(l);
      else runs.push({ type: t, lines: [l] });
    }
    return (
      <div key={i} style={{ margin: '4px 0' }}>
        {runs.map((run, j) => {
          if (run.type === 'table' && run.lines.length >= 2) return renderTable(run.lines, j);
          if (run.type === 'list') {
            return (
              <ul key={j} style={{ margin: '4px 0', paddingLeft: 18 }}>
                {run.lines.map((l, k) => <li key={k} style={{ margin: '2px 0' }}>{inline(l.trim().slice(2))}</li>)}
              </ul>
            );
          }
          return run.lines.map((l, k) => {
            const h = l.trim().match(/^#{2,4}\s+(.*)$/);
            if (h) return <div key={`${j}-${k}`} style={{ fontFamily: theme.fontMono, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.1em', color: theme.ink2, margin: '8px 0 2px' }}>{inline(h[1])}</div>;
            return <p key={`${j}-${k}`} style={{ margin: '2px 0' }}>{inline(l)}</p>;
          });
        })}
      </div>
    );
  });
}

const STARTERS = ["what's happening right now?", 'why was the last story rejected?', 'what needs me?'];

function GhostAvatar({ theme, floating }) {
  return (
    <span
      className={floating ? 'seance-float' : undefined}
      style={{
        flexShrink: 0, width: 30, height: 30, borderRadius: '50%',
        background: theme.fog, border: `1px solid ${theme.hairline}`,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <Ghost size={15} color={theme.ink1} />
    </span>
  );
}

function Chat({ api, ws, theme }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [focused, setFocused] = useState(false);
  const msgsRef = useRef(null);
  const taRef = useRef(null);

  useEffect(() => {
    // an answer can take minutes and the send may have been started by a
    // previous mount of this tab — restore both the transcript and the
    // in-flight indicator, and refresh whenever the main process reports
    // the transcript changed
    const refresh = () => {
      api.ipc.invoke('chat:history', ws).then(setMessages).catch(() => setMessages([]));
      api.ipc.invoke('chat:pending', ws).then((p) => setPending(Boolean(p))).catch(() => {});
    };
    refresh();
    const off = api.ipc.on('chat:changed', (p) => {
      if (p?.wsPath === ws) refresh();
    });
    return () => off();
  }, [api, ws]);

  useEffect(() => {
    // scroll only the message list — scrollIntoView also scrolls the host
    // app's ancestor containers, which reads as the whole screen jumping
    const el = msgsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, maxWidth: 760, width: '100%', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', paddingBottom: 6 }}>
        <button
          onClick={() => void api.ipc.invoke('chat:reset', ws).then(() => setMessages([]))}
          disabled={pending}
          title="forget this conversation"
          style={{ background: 'transparent', border: 'none', color: theme.ink2, fontSize: 11, cursor: pending ? 'default' : 'pointer', padding: '2px 4px', fontFamily: 'inherit' }}
        >
          + new séance
        </button>
      </div>

      <div ref={msgsRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 15, padding: '4px 2px' }}>
        {messages.length === 0 && !pending && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', marginTop: 48 }}>
            <GhostAvatar theme={theme} floating />
            <div style={{ fontSize: 13, color: theme.ink2 }}>ask the séance anything about this workspace</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
              {STARTERS.map((s) => (
                <button key={s} onClick={() => void sendMessage(s)} className="seance-chip" style={{
                  background: 'transparent', border: `1px solid ${theme.hairline2}`, color: theme.ink1,
                  borderRadius: theme.rPill, fontSize: 12, padding: '6px 12px', cursor: 'pointer', fontFamily: 'inherit',
                }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: m.role === 'user' ? 'flex-end' : 'flex-start', gap: 10 }}>
            {m.role !== 'user' && <GhostAvatar theme={theme} />}
            <div style={{
              maxWidth: '78%', whiteSpace: 'pre-wrap',
              background: m.role === 'user' ? theme.vellum : 'transparent',
              border: m.role === 'user' ? `1px solid ${theme.hairline2}` : m.role === 'error' ? `1px solid ${theme.oxblood}` : 'none',
              color: m.role === 'error' ? theme.pillOxbloodFg : m.role === 'user' ? theme.ink0 : theme.ink1,
              borderRadius: m.role === 'user' ? '12px 12px 3px 12px' : 8,
              padding: m.role === 'user' ? '9px 13px' : m.role === 'error' ? '9px 13px' : '3px 0',
              fontSize: 13.5, lineHeight: 1.55,
            }}>
              <ChatText text={m.text} theme={theme} onLink={(url) => api.openExternal(url)} />
            </div>
          </div>
        ))}
        {pending && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <GhostAvatar theme={theme} floating />
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', padding: '4px 0' }}>
              {[0, 1, 2].map((n) => (
                <span key={n} className="seance-typing" style={{ animationDelay: `${n * 160}ms`, width: 6, height: 6, borderRadius: '50%', background: theme.ink3, display: 'inline-block' }} />
              ))}
            </span>
          </div>
        )}
      </div>

      {/* single bordered container, borderless textarea + embedded send — mirrors the host chat */}
      <div
        style={{
          display: 'flex', alignItems: 'flex-end', gap: 8, marginTop: 10,
          background: theme.paper, border: `1px solid ${focused ? theme.hairline3 : theme.hairline2}`,
          borderRadius: theme.rMd, padding: '6px 6px 6px 13px', transition: 'border-color 120ms',
        }}
      >
        <MessageSquare size={15} color={theme.ink3} style={{ flexShrink: 0, marginBottom: 9 }} />
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
            width: 30, height: 30, flexShrink: 0, marginBottom: 2, borderRadius: theme.rSm, border: 'none',
            background: draft.trim() && !pending ? theme.neon : theme.fog,
            color: draft.trim() && !pending ? '#0E0F12' : theme.ink3,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            cursor: pending || !draft.trim() ? 'not-allowed' : 'pointer',
          }}
        >
          <ArrowUp size={15} />
        </button>
      </div>
    </div>
  );
}

// ---- shell -------------------------------------------------------------

const TABS = [
  { id: 'board', label: 'board', Icon: LayoutGrid },
  { id: 'hood', label: 'under the hood', Icon: Cpu },
  { id: 'chat', label: 'chat', Icon: MessageSquare },
  { id: 'config', label: 'config', Icon: Cog },
];

function NoWorkspace({ theme, onCreate }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: 40 }}>
      <Ghost size={48} color={theme.ink2} className="seance-float" />
      <div style={{ textAlign: 'center', maxWidth: 400 }}>
        <div style={{ fontFamily: theme.fontDisplay, fontWeight: 600, fontSize: 20, letterSpacing: '-0.02em', color: theme.ink0, marginBottom: 6 }}>
          no séance in progress
        </div>
        <p style={{ fontSize: 13, color: theme.ink2, lineHeight: 1.5, margin: 0 }}>
          the séance binds to a workspace, opens a worktree per agent, and works the backlog until you call it back.
        </p>
      </div>
      <Btn theme={theme} variant="primary" icon={<Sparkles size={13} />} onClick={onCreate}>create a workspace</Btn>
    </div>
  );
}

// ---- overview / dashboard --------------------------------------------------

// lane tone -> token, reusing the board's COLUMNS vocabulary so the overview
// bar reads the same as the per-workspace board.
function laneColor(theme, tone) {
  return {
    outline: theme.ink2, neon: theme.neon, fog: theme.ink1, moss: theme.moss, oxblood: theme.oxblood,
  }[tone] ?? theme.ink2;
}

const NEEDS_YOU_META = {
  attention: [AlertTriangle, 'needs you', 'oxblood'],
  spec_review: [ScanEye, 'spec review', 'neon'],
  question: [MessageSquare, 'question', 'neon'],
  feature_pr: [GitBranch, 'feature PR', 'moss'],
};

function StatTile({ theme, label, value, tone }) {
  const accent = tone === 'neon' ? theme.neonInk
    : tone === 'moss' ? theme.pillMossFg
      : tone === 'oxblood' ? theme.pillOxbloodFg
        : theme.ink0;
  return (
    <div style={{
      background: theme.vellum, border: `1px solid ${theme.hairline}`, borderRadius: theme.rMd,
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0,
    }}>
      <Eyebrow theme={theme}>{label}</Eyebrow>
      <span style={{ fontFamily: theme.fontMono, fontSize: 23, fontWeight: 600, lineHeight: 1, color: accent }}>{value}</span>
    </div>
  );
}

// compact segmented bar of the five lanes; segments are proportional to counts
function LaneBar({ theme, lanes }) {
  const total = COLUMNS.reduce((n, c) => n + (lanes?.[c.key] ?? 0), 0);
  return (
    <div style={{ display: 'flex', height: 6, borderRadius: theme.rPill, overflow: 'hidden', background: theme.fog, gap: total > 0 ? 2 : 0 }}>
      {total > 0 && COLUMNS.map((c) => (lanes[c.key] > 0 ? (
        <div key={c.key} title={`${c.label} · ${lanes[c.key]}`}
          style={{ flexGrow: lanes[c.key], flexBasis: 0, background: laneColor(theme, c.tone) }} />
      ) : null))}
    </div>
  );
}

function LaneCounts({ theme, lanes }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px' }}>
      {COLUMNS.map((c) => (
        <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: theme.fontMono, fontSize: 11, color: theme.ink2 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: laneColor(theme, c.tone), flexShrink: 0 }} />
          {c.label}
          <span style={{ color: (lanes?.[c.key] ?? 0) > 0 ? theme.ink0 : theme.ink3, fontWeight: 600 }}>{lanes?.[c.key] ?? 0}</span>
        </span>
      ))}
    </div>
  );
}

function WorkspaceCard({ theme, ws, onEnter }) {
  const [hover, setHover] = useState(false);

  if (ws.error) {
    return (
      <button type="button" onClick={() => onEnter(ws.path, 'board')}
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{
          textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
          background: theme.oxbloodMist, border: `1px solid ${theme.oxblood}`,
          borderRadius: theme.rLg, padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 8,
          opacity: hover ? 0.92 : 1, transition: 'opacity 120ms',
        }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <HeartCrack size={14} color={theme.oxblood} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</span>
          <span style={{ flex: 1 }} />
          <Pill theme={theme} tone="oxblood">unreadable</Pill>
        </div>
        <span style={{ fontFamily: theme.fontMono, fontSize: 11, color: theme.pillOxbloodFg, overflowWrap: 'anywhere', lineHeight: 1.45 }}>{ws.error}</span>
      </button>
    );
  }

  const dot = ws.healthy ? theme.neon : ws.running ? theme.oxblood : theme.ink3;
  const health = ws.healthy ? 'healthy' : ws.running ? 'stale' : 'stopped';
  return (
    <button type="button" onClick={() => onEnter(ws.path, 'board')}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{
        textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
        background: theme.vellum, border: `1px solid ${hover ? theme.hairline3 : theme.hairline}`,
        borderRadius: theme.rLg, padding: '13px 15px', display: 'flex', flexDirection: 'column', gap: 11,
        transition: 'border-color 120ms',
      }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <span className={ws.healthy ? 'seance-pulse' : undefined}
          style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 600, color: theme.ink0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ws.name}</span>
        <span style={{ flex: 1 }} />
        <span title={health} style={{ fontFamily: theme.fontMono, fontSize: 10.5, color: ws.healthy ? theme.ink2 : theme.pillOxbloodFg, whiteSpace: 'nowrap' }}>
          tick {relTime(ws.lastTickTs)}
        </span>
      </div>

      <LaneBar theme={theme} lanes={ws.lanes} />
      <LaneCounts theme={theme} lanes={ws.lanes} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        <Pill theme={theme} tone={ws.liveAgents > 0 ? 'neon' : 'outline'}>
          {ws.liveAgents > 0 && <span className="seance-dot" style={{ width: 5, height: 5, borderRadius: '50%', background: theme.neon }} />}
          {ws.liveAgents} live
        </Pill>
        {ws.requirementsInFlight > 0 && <Pill theme={theme} tone="fog">{ws.requirementsInFlight} in flight</Pill>}
        <span style={{ flex: 1 }} />
        {ws.blocked > 0 && <Pill theme={theme} tone="oxblood">{ws.blocked} blocked</Pill>}
        {ws.needsYou > 0 && <Pill theme={theme} tone="neon">{ws.needsYou} needs you</Pill>}
      </div>
    </button>
  );
}

function NeedsYouStrip({ theme, items, onEnter }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Sparkles size={12} color={theme.neon} />
        <Eyebrow theme={theme}>needs you · {items.length}</Eyebrow>
      </div>
      {items.map((it, i) => {
        const [Icon, label, tone] = NEEDS_YOU_META[it.kind] ?? [AlertTriangle, it.kind, 'oxblood'];
        const color = tone === 'neon' ? theme.neonInk : tone === 'moss' ? theme.pillMossFg : theme.pillOxbloodFg;
        return (
          <button key={`${it.path}-${it.kind}-${it.id}-${i}`} type="button"
            onClick={() => onEnter(it.path, it.tab ?? 'board')}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left', width: '100%', cursor: 'pointer',
              background: theme.vellum, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rMd,
              padding: '9px 13px', fontFamily: 'inherit',
            }}>
            <Icon size={14} color={color} style={{ flexShrink: 0 }} />
            <Pill theme={theme} tone={tone}>{label}</Pill>
            <span style={{ fontSize: 12.5, color: theme.ink0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it.title || it.id}
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: theme.fontMono, fontSize: 10.5, color: theme.ink2, whiteSpace: 'nowrap' }}>
              {it.workspace}
              <ArrowRight size={12} color={theme.ink3} />
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AllQuiet({ theme }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, textAlign: 'center',
      background: theme.vellum, border: `1px solid ${theme.hairline}`, borderRadius: theme.rLg, padding: '30px 24px',
    }}>
      <Moon size={22} color={theme.ink2} className="seance-float" />
      <div style={{ fontSize: 13.5, fontWeight: 600, color: theme.ink0 }}>all quiet</div>
      <div style={{ fontSize: 12.5, color: theme.ink2, maxWidth: 420, lineHeight: 1.5 }}>
        the fleet is resting — no agents running, no lanes active, nothing waiting on you. summon a requirement in any workspace to wake it.
      </div>
    </div>
  );
}

function OverviewSkeleton({ theme }) {
  const block = (h) => (
    <div style={{ background: theme.vellum, border: `1px solid ${theme.hairline}`, borderRadius: theme.rMd, height: h }} />
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
        {[0, 1, 2, 3, 4].map((i) => <div key={i}>{block(74)}</div>)}
      </div>
      {block(64)}
      <SkeletonNote theme={theme} text="reading the fleet…" />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {[0, 1, 2].map((i) => <div key={i}>{block(150)}</div>)}
      </div>
    </div>
  );
}

function Overview({ theme, api, onEnter }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      setData(await api.ipc.invoke('overview'));
      setError(null);
    } catch (e) {
      setError(String(e?.message ?? e));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    // refresh on the existing per-workspace change events plus a periodic
    // re-aggregate; a dedicated cross-workspace watcher is out of scope.
    const off = api.ipc.on('changed', () => void refresh());
    const t = setInterval(() => void refresh(), 12000);
    return () => { off(); clearInterval(t); };
  }, [api, refresh]);

  if (!data && error) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        background: theme.oxbloodMist, border: `1px solid ${theme.oxblood}`,
        borderRadius: theme.rMd, padding: '11px 15px', fontSize: 12.5, color: theme.pillOxbloodFg,
      }}>
        <AlertTriangle size={14} color={theme.oxblood} style={{ flexShrink: 0 }} />
        <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>could not read the fleet — {error}</span>
      </div>
    );
  }
  if (!data) return <OverviewSkeleton theme={theme} />;

  const { totals, needsYou, workspaces } = data;
  const active = totals.liveAgents + totals.needsYou + totals.requirementsInFlight
    + totals.lanes.backlog + totals.lanes.building + totals.lanes.verifying + totals.lanes.blocked;
  const quiet = active === 0;

  return (
    <div className="seance-scroll-col" style={{ display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto', minHeight: 0, paddingBottom: 4 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 12 }}>
        <StatTile theme={theme} label="workspaces" value={totals.workspaces} />
        <StatTile theme={theme} label="healthy" value={totals.healthy} tone={totals.healthy > 0 ? 'moss' : undefined} />
        <StatTile theme={theme} label="live agents" value={totals.liveAgents} tone={totals.liveAgents > 0 ? 'neon' : undefined} />
        <StatTile theme={theme} label="in flight" value={totals.requirementsInFlight} />
        <StatTile theme={theme} label="needs you" value={totals.needsYou} tone={totals.needsYou > 0 ? 'neon' : undefined} />
      </div>

      <Panel theme={theme} title="stories" subtitle="across the fleet">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
          <LaneBar theme={theme} lanes={totals.lanes} />
          <LaneCounts theme={theme} lanes={totals.lanes} />
        </div>
      </Panel>

      {needsYou.length > 0 ? (
        <NeedsYouStrip theme={theme} items={needsYou} onEnter={onEnter} />
      ) : quiet ? (
        <AllQuiet theme={theme} />
      ) : null}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {workspaces.map((w) => <WorkspaceCard key={w.path} theme={theme} ws={w} onEnter={onEnter} />)}
      </div>
    </div>
  );
}

function App({ api }) {
  const theme = useTheme(api);
  const [workspaces, setWorkspaces] = useState(null); // null = loading
  const [ws, setWs] = useState(null);
  const [snap, setSnap] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ id: '', title: '', priority: 'normal', body: '' });
  const [steerText, setSteerText] = useState('');
  const [notice, setNotice] = useState(null);
  const [tab, setTab] = useState('board');
  const [scope, setScope] = useState('overview');        // 'overview' | 'workspace'
  const [creating, setCreating] = useState(false);       // create view open?
  const [createBusy, setCreateBusy] = useState(false);
  const [createError, setCreateError] = useState(null);
  const [createClones, setCreateClones] = useState(null);

  const createWorkspace = async ({ name, config }) => {
    setCreateBusy(true); setCreateError(null);
    try {
      const r = await api.ipc.invoke('workspace:create', name, config);
      const list = await api.ipc.invoke('workspaces:list');
      setWorkspaces(list);
      setSnap(null); setWs(r.wsPath); setCreating(false); setScope('workspace');
      const allOk = !r.clones?.some((c) => !c.ok);
      if (allOk) {
        setTab('board'); setCreateClones(null);
      } else {
        setTab('config'); setCreateClones(r.clones);
      }
    } catch (e) { setCreateError(String(e?.message ?? e)); }
    finally { setCreateBusy(false); }
  };

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
    // restore the last workspace + tab + scope so navigating away and back
    // lands the user exactly where they were: inside a workspace on its tab,
    // or on the overview.
    Promise.all([
      api.ipc.invoke('workspaces:list'),
      api.settings.get('lastWorkspace').catch(() => null),
      api.settings.get('lastTab').catch(() => null),
      api.settings.get('lastScope').catch(() => null),
    ]).then(([list, lastWs, lastTab, lastScope]) => {
      if (!alive) return;
      setWorkspaces(list);
      if (typeof lastTab === 'string' && ['board', 'hood', 'chat', 'config'].includes(lastTab)) {
        setTab(lastTab);
      }
      const saved = list.length ? list.find((w) => w.path === lastWs) : null;
      // only land inside a workspace when the saved scope says so AND that
      // workspace still exists; otherwise fall back to the overview.
      if (lastScope === 'workspace' && saved) {
        setWs((cur) => cur ?? saved.path);
        setScope('workspace');
      } else {
        setScope('overview');
      }
    }).catch((e) => {
      setWorkspaces([]);
      setError(String(e?.message ?? e));
    });
    return () => { alive = false; };
  }, [api]);

  useEffect(() => {
    if (ws) void Promise.resolve(api.settings.set('lastWorkspace', ws)).catch(() => {});
  }, [ws, api]);
  useEffect(() => {
    void Promise.resolve(api.settings.set('lastTab', tab)).catch(() => {});
  }, [tab, api]);
  useEffect(() => {
    void Promise.resolve(api.settings.set('lastScope', scope)).catch(() => {});
  }, [scope, api]);

  // enter a workspace from an overview card or a needs-you item — sets the
  // selected workspace (+ tab) and flips scope; all three are then persisted.
  const enterWorkspace = (path, nextTab) => {
    setSnap(null);
    setWs(path);
    if (nextTab) setTab(nextTab);
    setScope('workspace');
  };
  const goToOverview = () => setScope('overview');

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
  const healthy = hb.running && (tickAge < 900 || pendingWork === 0);

  const noWorkspace = workspaces !== null && workspaces.length === 0;

  return (
    <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 0, color: theme.ink0, fontFamily: 'inherit', height: '100%', boxSizing: 'border-box' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, paddingBottom: 14 }}>
        <button
          type="button"
          onClick={goToOverview}
          title={!noWorkspace && scope === 'workspace' ? 'back to all workspaces' : undefined}
          style={{
            background: 'transparent', border: 'none', padding: 0,
            fontFamily: theme.fontDisplay, fontSize: 17, fontWeight: 600, letterSpacing: '-0.02em',
            color: theme.ink0, cursor: !noWorkspace && scope === 'workspace' ? 'pointer' : 'default',
          }}
        >séance</button>
        {!noWorkspace && workspaces !== null && scope === 'overview' && (
          <Eyebrow theme={theme}>overview</Eyebrow>
        )}
        {!noWorkspace && workspaces !== null && scope === 'workspace' && (
          <>
            <Btn theme={theme} variant="ghost" icon={<LayoutGrid size={13} />} onClick={goToOverview}>overview</Btn>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 8,
              background: theme.vellum, border: `1px solid ${theme.hairline2}`, borderRadius: theme.rMd,
              padding: '5px 8px 5px 11px',
            }}>
              <GitBranch size={13} color={theme.neon} />
              <select
                value={ws ?? ''}
                onChange={(e) => { setSnap(null); setWs(e.target.value); }}
                style={{
                  background: 'transparent', border: 'none', outline: 'none', cursor: 'pointer',
                  color: theme.ink0, fontFamily: theme.fontMono, fontSize: 12, maxWidth: 220,
                }}
              >
                {workspaces.map((w) => <option key={w.path} value={w.path}>{w.name}</option>)}
              </select>
            </span>
          </>
        )}
        {workspaces !== null && (
          <Btn theme={theme} variant="ghost" onClick={() => setCreating(true)}>+ new</Btn>
        )}
        {!noWorkspace && snap && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontFamily: theme.fontMono, fontSize: 11, color: healthy ? theme.ink2 : theme.pillOxbloodFg }}>
            <span
              className={healthy ? 'seance-pulse' : undefined}
              style={{ width: 7, height: 7, borderRadius: '50%', background: healthy ? theme.neon : hb.running ? theme.oxblood : theme.ink3, display: 'inline-block' }}
            />
            {hb.running ? `tick ${relTime(snap?.lastTickTs)}` : `heartbeat stopped · last tick ${relTime(snap?.lastTickTs)}`}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!noWorkspace && snap && hb.running && (
          <Btn theme={theme} variant="ghost" icon={<Square size={12} />} onClick={() => act(() => api.ipc.invoke('heartbeat:stop', ws))}>
            stop heartbeat
          </Btn>
        )}
      </div>

      {creating ? (
        <div style={{ overflowY: 'auto', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            <Eyebrow theme={theme}>new workspace</Eyebrow>
            <span style={{ flex: 1 }} />
            <Btn theme={theme} variant="ghost" disabled={createBusy} onClick={() => setCreating(false)}>cancel</Btn>
          </div>
          <WorkspaceForm theme={theme} mode="create" busy={createBusy} error={createError}
            cloneResults={createClones} onSubmit={createWorkspace} />
        </div>
      ) : noWorkspace ? (
        <NoWorkspace theme={theme} onCreate={() => setCreating(true)} />
      ) : scope === 'overview' ? (
        <Overview theme={theme} api={api} onEnter={enterWorkspace} />
      ) : (
        <>
          {/* tabs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 2, borderBottom: `1px solid ${theme.hairline}`, marginBottom: 14 }}>
            {TABS.map(({ id, label, Icon }) => {
              const on = tab === id;
              return (
                <button
                  key={id}
                  onClick={() => setTab(id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
                    border: 'none', background: 'transparent', padding: '9px 13px',
                    color: on ? theme.ink0 : theme.ink2,
                    fontFamily: 'inherit', fontSize: 13, fontWeight: on ? 600 : 500,
                    borderBottom: `2px solid ${on ? theme.neon : 'transparent'}`,
                    marginBottom: -1,
                  }}
                >
                  <Icon size={14} color={on ? theme.neon : 'currentColor'} />
                  {label}
                </button>
              );
            })}
          </div>

          {(error || (notice && tab === 'board')) && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
              background: theme.oxbloodMist, border: `1px solid ${theme.oxblood}`,
              borderRadius: theme.rMd, padding: '9px 13px', fontSize: 12.5, color: theme.pillOxbloodFg,
            }}>
              <AlertTriangle size={14} color={theme.oxblood} style={{ flexShrink: 0 }} />
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{error ?? notice}</span>
            </div>
          )}

          {tab === 'board' && ws && (
            <Board
              theme={theme} snap={snap} hb={hb} ws={ws} act={act} api={api}
              form={form} setForm={setForm} steerText={steerText} setSteerText={setSteerText}
            />
          )}
          {tab === 'hood' && ws && <UnderTheHood theme={theme} api={api} ws={ws} />}
          {tab === 'chat' && ws && <Chat api={api} ws={ws} theme={theme} />}
          {tab === 'config' && ws && (
            <ConfigTab theme={theme} api={api} ws={ws}
              initialCloneResults={createClones} onConsumedCloneResults={() => setCreateClones(null)} />
          )}
        </>
      )}
    </div>
  );
}

const KEYFRAMES = `
@keyframes seance-pulse-kf { 0%,100%{ box-shadow:0 0 0 0 rgba(197,255,61,0.5);} 50%{ box-shadow:0 0 0 4px rgba(197,255,61,0);} }
.seance-pulse { animation: seance-pulse-kf 2.4s cubic-bezier(.4,0,.2,1) infinite; }
@keyframes seance-blink { 0%,100%{opacity:1;} 50%{opacity:0.15;} }
.seance-dot { animation: seance-blink 1.6s ease-in-out infinite; display:inline-block; }
@keyframes seance-typing-kf { 0%,60%,100%{ transform:translateY(0); opacity:.4;} 30%{ transform:translateY(-4px); opacity:1;} }
.seance-typing { animation: seance-typing-kf 1.1s ease-in-out infinite; }
@keyframes seance-float-kf { 0%,100%{ transform:translateY(0);} 50%{ transform:translateY(-3px);} }
.seance-float { animation: seance-float-kf 3s ease-in-out infinite; }
/* a scroll container's flex children must never shrink — default flex-shrink:1
   compresses them when content exceeds the viewport and their contents overlap */
.seance-scroll-col > * { flex-shrink: 0; }
`;

export function mount(el, api) {
  // Always rewrite the sheet: the element outlives unmount, so a create-once
  // guard would keep serving a previous version's CSS after an in-place
  // plugin update (0.4.4's flex-shrink fix never landed for updaters).
  let style = document.getElementById('seance-plugin-kf');
  if (!style) {
    style = document.createElement('style');
    style.id = 'seance-plugin-kf';
    document.head.appendChild(style);
  }
  style.textContent = KEYFRAMES;
  const root = createRoot(el);
  root.render(<App api={api} />);
  return () => root.unmount();
}
