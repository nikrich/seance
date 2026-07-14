# Rotating `SEANCE_DISPATCH_TOKEN`

## What it does, and what breaks when it dies

`SEANCE_DISPATCH_TOKEN` authenticates the `repository_dispatch` call that
`.github/workflows/marketplace-publish-dispatch.yml` fires at
`nikrich/poltergeist-plugins` (`event_type: seance-manifest-updated`)
whenever `poltergeist-plugin/manifest.json` changes on `main`. That dispatch
is what makes poltergeist-plugins' `publish.yml` rebuild and redeploy
`market.getpoltergeist.com`. If the token is dead:

- The **Marketplace Publish Dispatch** run fails, and (per OUIJA-26-s1)
  its `::error::` annotation names the HTTP status and points here.
  Symptom before that hardening landed: an opaque `curl` exit code 22 with
  no visible status — a real publish was blocked with no clear cause.
- The weekly **token canary** workflow,
  `.github/workflows/dispatch-token-canary.yml` (added by OUIJA-26-s2),
  fails on its scheduled run, which is the early-warning signal — it's
  designed to catch this before a real publish needs the token.

## Where the secret lives

- Repo: `nikrich/seance`
- GitHub Actions repository secret, name: `SEANCE_DISPATCH_TOKEN`
- Path: repo Settings → Secrets and variables → Actions → Repository secrets

## Token type and required permission

**Unknown — verify before rotating.** The exact credential type (fine-grained
PAT, classic PAT, or GitHub App token) and expiry date of the current token
were not confirmable when this runbook was written. Before rotating, check
`github.com/settings/tokens` (both the fine-grained and classic tabs) under
the account that owns the token to identify what it actually is — do not
assume.

Whatever the type, it must be able to trigger `repository_dispatch` on
`nikrich/poltergeist-plugins`:

- **Fine-grained PAT:** repository access to `nikrich/poltergeist-plugins`
  with permission **"Contents: Read and write"**.
- **Classic PAT:** the `repo` scope.

## Rotation steps

1. Go to `github.com/settings/tokens` and identify the current token's type
   (see caveat above), then generate a new token of the same type with the
   permission listed above (repository access to `nikrich/poltergeist-plugins`
   with "Contents: Read and write" for fine-grained, or `repo` scope for
   classic).
2. In `nikrich/seance` → Settings → Secrets and variables → Actions, update
   the `SEANCE_DISPATCH_TOKEN` repository secret with the new token value.
3. Verify the new token works **without** triggering a real publish: run
   `.github/workflows/dispatch-token-canary.yml` manually via its
   `workflow_dispatch` trigger (Actions tab → Dispatch Token Canary → Run
   workflow) and confirm it passes. Do not verify by pushing a manifest
   change or otherwise firing a real `repository_dispatch` — that publishes
   to the live marketplace.

## Confirming a suspected token failure

If a **Marketplace Publish Dispatch** or **Dispatch Token Canary** run fails:

1. Open the failed run in the Actions tab and read the job's `::error::`
   annotation. Since OUIJA-26-s1/s2, a token failure is annotated with the
   HTTP status code (401/403) and a message naming `SEANCE_DISPATCH_TOKEN`
   directly.
2. A 401/403 status in that annotation confirms the token is invalid,
   expired, or has lost repository access — proceed to the rotation steps
   above.
3. If the annotation shows a different status (e.g. a 5xx), the token is
   likely fine and the failure is transient on GitHub's API side; re-run the
   job before rotating anything.
