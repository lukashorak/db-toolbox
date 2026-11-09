# 0020. GitHub Actions with service containers

Status: Accepted · 7 November 2026

## Context

The repository is on GitHub.

## Decision

GitHub Actions runs format, lint, type check, unit tests and build on every pull request. Integration jobs with service containers are enabled from step 2.

## Consequences

A self-hosted runner is an option later if container start-up time becomes a problem.
