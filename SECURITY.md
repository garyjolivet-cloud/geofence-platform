# Security Policy

## Reporting a vulnerability

Email **gary.jolivet@gmail.com** with details. Please do not open a public issue for
security problems. Expect an acknowledgement within a few days.

## Secret-handling rules (enforced by CI + a local pre-commit hook)

- **Never** commit Cloudflare account IDs, API tokens, `ADMIN_TOKEN`, `RESEMBLE_API_TOKEN`,
  `RESEND_API_KEY`, or any other credential.
- Production secrets live only in Cloudflare, set via `npx wrangler secret put <NAME>`.
- Local development secrets live only in `.dev.vars` at the repo root — this file is
  gitignored and must never be tracked.
- The D1 `database_id` in `wrangler.jsonc` and the Google OAuth **client ID** are public by
  design and are allowlisted in `.gitleaks.toml`.

### Tooling

- `.github/workflows/secret-scan.yml` runs [gitleaks](https://github.com/gitleaks/gitleaks)
  on every push and PR to `main`.
- `.githooks/pre-commit` runs `gitleaks protect --staged` locally. Enable it once per clone:

  ```
  git config core.hooksPath .githooks
  ```

  Install the gitleaks binary from https://github.com/gitleaks/gitleaks/releases (a Windows
  build is provided). If it is not on `PATH` the hook warns and allows the commit — CI still
  catches it.

## Supported

Only the `main` branch / the currently deployed Worker is supported.
