# 0001. Start fresh; keep the Codex prototype as reference

Status: Accepted · 7 November 2026

## Context

An earlier Codex prototype (0.1.0) implements much of the core but has a single-file GUI and a structure that does not match the agreed component boundaries or the design prototype.

## Decision

Build a new code base. Keep the Codex source in `reference/codex-db-workbench/` as read-only material.

## Consequences

Code from the reference is copied on purpose, adapted and tested in the same pull request. Nothing imports from `reference/`; tooling and the Docker context exclude it.
