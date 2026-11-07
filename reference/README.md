# Reference material

This folder holds material that informs the implementation but is **not part of the product**. It is not built, linted, tested, packaged or deployed. Tooling configured in step 0 of the [implementation plan](../docs/implementation-plan.md) excludes `reference/`.

## `codex-db-workbench/`

An earlier prototype of Database Workbench (package version 0.1.0, 7 November 2026), generated with Codex. Its own status notes are in [`codex-db-workbench/docs/implementation-status.md`](codex-db-workbench/docs/implementation-status.md).

The project starts fresh rather than evolving this code. Consult it for:

- PostgreSQL and MySQL adapter details (cursors, streaming, cancellation, read-only transactions);
- the SQL splitter and the 1,200-row preview and export test fixtures;
- Keycloak realm generation, token validation and MCP OAuth findings;
- MCP disclosure-approval behavior and its tests.

Rules for reuse:

- Copy code into `packages/` only on purpose, adapt it to the new structure, and cover it with tests in the same pull request.
- Do not import from `reference/` at build or run time.
- `package-lock.json` was left out so that dependency scanners do not raise alerts for code that never runs. Versions in its `package.json` are historical, not pinned for the new project.
