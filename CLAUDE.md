# Agent instructions for `nikrich/seance`

## Shipping the Séance plugin — read this before touching `poltergeist-plugin/`

The Séance desktop plugin is distributed via **`market.getpoltergeist.com`**, a
static registry site. That site is built from a **separate repo**,
`nikrich/poltergeist-plugins` — not from this repo. Its `scripts/build-site.mjs`
clones `poltergeist-plugin/` out of this repo at `ref: main` (see
`plugins/seance.json`) and reads `manifest.json`'s `version` field live, at
build time. That version is what feeds the desktop app's update-availability
check, `isNewerVersion`, in
`poltergeist/desktop/src/main/plugins/registry.ts` (a third repo) — it compares
semver segments against the version installed users already have.

**Merging a feature PR into this repo's `main` is NOT enough to ship it** to
installed users. Every ship needs two more steps, every time:

1. Bump `poltergeist-plugin/manifest.json`'s `version` and merge that to this
   repo's `main`.
2. Trigger a publish on `nikrich/poltergeist-plugins` — a push or PR to its
   `main`, or a manual `workflow_dispatch` — so its `publish.yml` rebuilds
   `market.getpoltergeist.com/registry.json` from the new manifest and
   redeploys it via `wrangler deploy`.

Skipping either step means the feature is merged but nobody using the plugin
actually gets it.

### Recommendation: bump the version in the same PR

This gap has recurred three times now (REQ-SEANCE-3 → needed a follow-up
requirement to fix; REQ-SEANCE-5 → needed another). The root-cause fix: **every
feature story/PR that touches `poltergeist-plugin/` should bump the manifest
`version` as part of that same PR**, not as a separate follow-up task. Treat
the version bump as part of the change, not as release housekeeping to do
later — "later" is how this keeps happening.
