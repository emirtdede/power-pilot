# Contributing to Power Pilot

Power Pilot is proprietary software. This guide is for maintainers and
contributors who have been authorized by Vellium. Do not submit code,
artifacts, or customer data unless you have permission to do so.

## Prerequisites

- Windows 10/11 (the product target)
- Node.js 24.18.1 (see `.nvmrc`)
- npm 11+
- Git
- For packaging: the Windows SDK and signing environment described in
  [`docs/release/RELEASE_SIGNING.md`](../docs/release/RELEASE_SIGNING.md)

## Setup

```powershell
npm ci
npm start
```

`npm ci` runs `electron-rebuild` for the native modules. Use the same Node
major version as CI; mixing Node versions is the most common cause of native
module failures.

## Branches and commits

Use short-lived branches from `main`:

```text
feat/<scope>
fix/<scope>
chore/<scope>
docs/<scope>
release/<version>
```

Write Conventional Commits:

```text
feat(timer): add per-task grace period
fix(api): reject expired nonce
docs(release): clarify signing steps
chore(deps): update electron-builder
```

Keep commits focused. Do not mix formatting-only changes with behavior changes.

## Quality gates

Run the relevant gates before opening a pull request:

| Command                 | When                                          |
| ----------------------- | --------------------------------------------- |
| `npm test`              | Every change                                  |
| `npm run test:security` | Every change                                  |
| `npm run release:check` | Every change                                  |
| `npm run locales:check` | UI text or locale changes                     |
| `npm run test:e2e`      | UI, IPC, startup, or packaging changes        |
| `npm run coverage`      | Changes to main-process services              |
| `npm run verify:pack`   | Packaging or build-config changes             |

CI runs the full Windows matrix, including packaging and installer E2E. A pull
request is not ready to merge while a required check is failing or flaky.

## Pull requests

- Keep one logical change per pull request.
- Fill in the pull request template, including the exact commands you ran.
- Link the issue or work package (`WP-xx`) the change implements.
- Add or update tests for the behavior you changed.
- Update `docs/` when behavior, configuration, or operations change. Add new
  pages to [`docs/README.md`](../docs/README.md).
- Add a `CHANGELOG.md` entry for user-facing changes.
- Include before/after screenshots for UI changes.
- Never commit secrets, certificates, `dist/`, `coverage/`, `test-results/`, or
  the local design/store assets ignored by `.gitignore`.

## Documentation

Documentation lives under `docs/`:

- the index is [`docs/README.md`](../docs/README.md);
- architecture and security design in `docs/architecture/`;
- release and signing procedures in `docs/release/`;
- operations in `docs/runbooks/`;
- API contract in `docs/openapi/`.

Use relative links and update the index when you add or remove a document.
Historical/planning notes belong in `CHANGELOG.md`, not in `docs/`.

## Security reports

Do not open a public issue for a vulnerability. Follow
[`SECURITY.md`](SECURITY.md).

## Release engineering

Only maintainers publish releases. The process, signing requirements, SBOM, and
artifact checks are documented in
[`docs/release/RELEASE_SIGNING.md`](../docs/release/RELEASE_SIGNING.md).
