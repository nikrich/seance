'use strict';
// Workspace scaffolding + config.yaml round-trip for the Séance plugin.
// Everything effectful takes injected deps (runGit) so tests run on a tmpdir
// with a fake git — same pattern as chat.cjs's injected runClaude.

const { existsSync, mkdirSync, writeFileSync, symlinkSync } = require('node:fs');
const { join } = require('node:path');
const YAML = require('yaml');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KNOWN_KEYS = [
  'workspace', 'repos', 'max_builders', 'max_critics', 'max_planner',
  'max_agent_minutes', 'attempt_cap', 'models', 'sleep', 'inbox_feeds',
];
const DEFAULT_MODELS = { manager: 'haiku', planner: 'opus', builder: 'sonnet', critic: 'opus' };
const DEFAULT_SLEEP = { active: 60, idle: 600 };

function parseConfig(text) {
  const doc = YAML.parse(text) ?? {};
  const repos = Object.entries(doc.repos ?? {}).map(([name, r]) => ({
    name,
    url: r?.url ?? '',
    default_branch: r?.default_branch ?? 'main',
    integration: ['merge', 'feature-pr'].includes(r?.integration) ? r.integration : 'pr',
    test_command: r?.test_command ?? '',
  }));
  const extra = {};
  for (const [k, v] of Object.entries(doc)) {
    if (!KNOWN_KEYS.includes(k)) extra[k] = v;
  }
  return {
    workspace: doc.workspace ?? '',
    repos,
    max_builders: doc.max_builders ?? 3,
    max_critics: doc.max_critics ?? 2,
    max_planner: doc.max_planner ?? 1,
    max_agent_minutes: doc.max_agent_minutes ?? 45,
    attempt_cap: doc.attempt_cap ?? 3,
    models: { ...DEFAULT_MODELS, ...(doc.models ?? {}) },
    sleep: { ...DEFAULT_SLEEP, ...(doc.sleep ?? {}) },
    inbox_feeds: Array.isArray(doc.inbox_feeds) ? doc.inbox_feeds : [],
    extra,
  };
}

function configToYaml(model) {
  const repos = {};
  for (const r of model.repos ?? []) {
    repos[r.name] = {
      url: r.url,
      default_branch: r.default_branch,
      integration: r.integration,
      test_command: r.test_command,
    };
  }
  return YAML.stringify({
    workspace: model.workspace,
    repos,
    max_builders: model.max_builders,
    max_critics: model.max_critics,
    max_planner: model.max_planner,
    max_agent_minutes: model.max_agent_minutes,
    attempt_cap: model.attempt_cap,
    models: model.models,
    sleep: model.sleep,
    ...(model.inbox_feeds?.length > 0 ? { inbox_feeds: model.inbox_feeds } : {}),
    ...Object.fromEntries(Object.entries(model.extra ?? {}).filter(([k]) => !KNOWN_KEYS.includes(k))),
  });
}

function validateConfigModel(m) {
  if (!m || typeof m !== 'object') return ['config required'];
  const errors = [];
  const repos = Array.isArray(m.repos) ? m.repos : [];
  if (repos.length === 0) errors.push('at least one repo is required');
  for (const r of repos) {
    if (!r?.name || !NAME_RE.test(r.name)) errors.push(`repo name "${r?.name ?? ''}" is invalid`);
    if (!r?.url) errors.push(`repo ${r?.name ?? '?'}: url is required`);
    else if (r.url.startsWith('-')) errors.push(`repo ${r?.name ?? '?'}: url must not start with "-"`);
    if (!['pr', 'merge', 'feature-pr'].includes(r?.integration)) {
      errors.push(`repo ${r?.name ?? '?'}: integration must be "pr", "merge", or "feature-pr"`);
    }
    if (!r?.default_branch || r.default_branch.startsWith('-')) {
      errors.push(`repo ${r?.name ?? '?'}: default_branch is invalid`);
    }
  }
  const names = repos.map((r) => r?.name);
  if (new Set(names).size !== names.length) errors.push('repo names must be unique');
  for (const k of ['max_builders', 'max_critics', 'max_planner', 'max_agent_minutes', 'attempt_cap']) {
    if (!Number.isInteger(m[k]) || m[k] < 1) errors.push(`${k} must be a positive integer`);
  }
  for (const k of ['active', 'idle']) {
    if (!Number.isInteger(m.sleep?.[k]) || m.sleep[k] < 1) errors.push(`sleep.${k} must be a positive integer`);
  }
  const feeds = Array.isArray(m.inbox_feeds) ? m.inbox_feeds : [];
  if (feeds.some((f) => typeof f !== 'string' || !f.startsWith('/'))) {
    errors.push('inbox_feeds entries must be absolute paths');
  }
  return errors;
}

const CONTRACT_DIRS = [
  'inbox/processed', 'state/requirements', 'state/stories', 'state/agents',
  'attention', 'journal', 'repos', 'worktrees', 'logs', '.claude', 'questions',
];

async function syncRepos(wsPath, config, runGit) {
  const clones = [];
  for (const r of config.repos ?? []) {
    const dest = join(wsPath, 'repos', r.name);
    if (existsSync(dest)) continue;
    const res = await runGit(['-c', 'protocol.ext.allow=never', 'clone', '--branch', r.default_branch, '--', r.url, dest]);
    clones.push({
      name: r.name,
      ok: res.code === 0,
      error: res.code === 0 ? undefined : (res.stderr || 'git clone failed').trim().slice(-500),
    });
  }
  return clones;
}

// Registers the Poltergeist vault MCP server for every claude agent spawned
// in this workspace (project-scoped .mcp.json). `ghostbrain-mcp` resolves
// from PATH at agent runtime; if it isn't installed the agents' knowledge
// chain treats the failed connection as "no answer" and moves on.
function ensureMcpConfig(wsPath) {
  const file = join(wsPath, '.mcp.json');
  if (existsSync(file)) return false;
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: { poltergeist: { command: 'ghostbrain-mcp', args: [] } } }, null, 2) + '\n',
  );
  return true;
}

// Headless `claude -p` agents (planner/builder/critic/manager) only load
// project-scoped MCP servers (.mcp.json) when the project is trusted; this
// settings file trusts it automatically so the poltergeist MCP server the
// agents rely on for the knowledge chain actually connects.
function ensureAgentSettings(wsPath) {
  const dir = join(wsPath, '.claude');
  const file = join(dir, 'settings.local.json');
  if (existsSync(file)) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, '{"enableAllProjectMcpServers": true}\n');
  return true;
}

async function scaffoldWorkspace({ root, name, config, seanceRepo, runGit }) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`invalid workspace name "${name}" — letters, digits, . _ - only`);
  }
  const wsPath = join(root, name);
  if (existsSync(wsPath)) throw new Error(`workspace already exists: ${wsPath}`);
  const skillsSrc = join(seanceRepo, 'skills');
  if (!existsSync(skillsSrc)) {
    throw new Error(`skills not found at ${skillsSrc} — set the seanceRepoPath plugin setting to your séance checkout`);
  }
  for (const d of CONTRACT_DIRS) mkdirSync(join(wsPath, d), { recursive: true });
  writeFileSync(join(wsPath, 'config.yaml'), configToYaml({ ...config, workspace: name }));
  ensureMcpConfig(wsPath);
  ensureAgentSettings(wsPath);
  try {
    symlinkSync(skillsSrc, join(wsPath, '.claude', 'skills'));
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  const clones = await syncRepos(wsPath, config, runGit);
  return { wsPath, clones };
}

module.exports = { NAME_RE, parseConfig, configToYaml, validateConfigModel, scaffoldWorkspace, syncRepos, ensureMcpConfig, ensureAgentSettings };
