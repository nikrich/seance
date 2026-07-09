# Séance plugin: create & edit workspaces from the UI

**Date:** 2026-07-09
**Status:** approved

## Problem

Spinning up a Séance workspace is a manual terminal ritual: mkdir the
directory contract under `~/seance/<name>`, copy `templates/config.yaml`,
symlink the skills, clone each repo. The plugin can only *use* workspaces
that already exist. Workspace creation — and config changes like adding a
repo — must be fully doable from the plugin.

## Scope (agreed)

- **Create** workspaces from the plugin, including git-cloning the repos.
  Clone failures are non-fatal and retryable; the scaffold survives.
- **Full config editor**: repos (url, branch, integration, test command),
  limits (`max_builders`, `max_critics`, `max_planner`, `max_agent_minutes`,
  `attempt_cap`), per-role `models`, and `sleep` cadence.
- The same editor **opens existing workspaces** (parsed from `config.yaml`)
  and saves back. Adding a repo to a live workspace is: edit, save.

## Design

### 1. Main process — `src/lib/workspace.cjs`

New module holding all logic, testable via injected exec (same pattern as
`chat.cjs`'s `runClaude`). Uses the `yaml` npm package (bundled into
`dist/main.cjs` by esbuild).

**Config form model** (what IPC carries; mapped to/from the template's YAML
shape — `repos` array in the model, named map in the file):

```js
{
  workspace: string,
  repos: [{ name, url, default_branch, integration: 'pr'|'merge', test_command }],
  max_builders: number, max_critics: number, max_planner: number,
  max_agent_minutes: number, attempt_cap: number,
  models: { manager, planner, builder, critic },   // claude CLI aliases
  sleep: { active: number, idle: number },          // seconds
}
```

**Exports:**

- `parseConfig(yamlText)` / `configToYaml(model)` — round-trip between the
  file and the form model. Unknown top-level keys in an existing file are
  preserved on save (parsed into the model as `extra` and re-emitted).
- `scaffoldWorkspace({ root, name, config, seanceRepo, runGit })` —
  validates the name (`/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`, no existing
  dir), creates the directory contract (`inbox/processed`,
  `state/{requirements,stories,agents}`, `attention`, `journal`, `repos`,
  `worktrees`, `logs`, `.claude`), writes `config.yaml`, symlinks
  `.claude/skills → <seanceRepo>/skills` (error names the `seanceRepoPath`
  plugin setting if the skills dir is missing), then delegates to
  `syncRepos`. Returns `{ wsPath, clones: [{ name, ok, error? }] }`.
- `syncRepos(wsPath, config, runGit)` — for each config repo with no
  `repos/<name>/` directory, `git clone --branch <default_branch> <url>
  repos/<name>` (a wrong branch name fails that repo's clone with git's
  error — retryable after fixing the field). Sequential; each failure
  recorded, never thrown. Never deletes checkouts for repos removed from
  the config.

**IPC handlers in `main.cjs`:**

| channel | payload | returns |
|---|---|---|
| `workspace:create` | `(name, configModel)` | `{ wsPath, clones }` |
| `workspace:config:read` | `(wsPath)` | `configModel` |
| `workspace:config:write` | `(wsPath, configModel)` | `{ clones }` (missing repos cloned) |

Git runs via `execFile('git', args, { env: withClaudePath(), timeout: 10min })`
— the same PATH augmentation the claude spawns use, injected as `runGit`.

The `main.cjs` header comment is updated: the plugin's write surface is now
inbox/ + `dataDir` + workspace scaffolding/`config.yaml` (creation and the
config editor only — all other workspace state stays read-only).

### 2. Renderer — "config" tab + create mode

- Tab strip gains a fourth tab **config** (cog icon), visible when a
  workspace is selected. It loads `workspace:config:read` and renders
  `WorkspaceForm` pre-filled; **save** calls `workspace:config:write`,
  shows per-repo clone results (moss ok / oxblood error rows) and a saved
  notice.
- **Create mode**: a "+ new" ghost button beside the workspace picker and
  the no-workspace state's CTA open the same `WorkspaceForm` blank, plus a
  workspace-name field (create-only; renaming an existing workspace is out
  of scope), with a primary "create workspace" button. While
  creating (clones can take minutes) the form disables with a
  "summoning workspace…" spinner. On success: refresh the workspace list,
  select the new workspace, land on the board.
- Form layout (DS-styled panels): **repos** — repeatable rows (name
  auto-derived from URL basename and editable, url, branch, pr/merge
  segmented control, test command, add/remove); **limits** — numeric
  inputs; **models** — four role selects (haiku/sonnet/opus); **cadence** —
  active/idle seconds.
- Client-side validation: name pattern, at least one repo with a url,
  positive numbers.

### 3. Error handling

- Existing workspace name → error banner, nothing written.
- Clone failure → workspace still created; per-repo error shown with an
  auth hint ("check ssh keys / gh auth"); retry = save from the config tab
  (`syncRepos` clones only what's missing).
- Missing/invalid `seanceRepoPath` → actionable error naming the setting.
- Skills symlink already present and correct → idempotent no-op.
- Comments in a hand-edited `config.yaml` are lost the first time the
  editor saves (yaml round-trip keeps values, not comments) — documented
  trade-off.

### 4. Testing & shipping

- Unit tests (`test/workspace.test.mjs`) on a tmpdir with a fake `runGit`
  that records calls and can simulate failure: scaffold tree + config +
  symlink correctness; YAML round-trip (values + unknown-key preservation);
  `syncRepos` clones only missing repos; name validation; non-fatal clone
  failure shape.
- Renderer verified via the mock-host harness (new channels mocked;
  screenshots of the config tab and create view).
- Plugin version → 0.3.0. Ship via PR, squash-merge, like #1/#2.

## Alternatives considered

- **Raw YAML textarea** (validated on save): cheapest, preserves comments,
  but no structure — rejected in favour of the structured form.
- **Structured create-only** (no edit): avoids YAML parsing but leaves
  "add a repo" as a terminal task — rejected; create + edit was the point.
