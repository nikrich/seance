'use strict';
// macOS launchd hands a GUI .app a stripped PATH (/usr/bin:/bin:/usr/sbin:/sbin),
// so spawning a bare `claude` — or heartbeat.sh, which shells out to it — is
// ENOENT whenever Poltergeist is launched from the Dock or Finder. Mirror the
// host's sidecar fix: prepend the usual install dirs (`/opt/homebrew/bin` on
// Apple Silicon, `/usr/local/bin` on Intel + manual installs, `~/.local/bin`
// for Claude Code's default install path).

function withClaudePath(env = process.env) {
  const home = env.HOME ?? '';
  const current = (env.PATH ?? '').split(':').filter(Boolean);
  const missing = ['/opt/homebrew/bin', '/usr/local/bin', home && `${home}/.local/bin`]
    .filter(Boolean)
    .filter((dir) => !current.includes(dir));
  return { ...env, PATH: [...missing, ...current].join(':') };
}

module.exports = { withClaudePath };
