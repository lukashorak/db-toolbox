# 0005. Environment labels: Production and Development only

Status: Accepted · 7 November 2026

## Context

Each connection carries an environment label shown with a color band. A Staging label is not needed yet.

## Decision

The environment enum has `production` and `development`.

## Consequences

The enum stays extensible; adding Staging later needs a migration and a token, nothing else.
