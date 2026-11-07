# 0002. Manual transactions come after v1

Status: Accepted · 7 November 2026

## Context

The design prototype contains a manual transaction mode (Begin, Commit, Roll back, idle expiry) marked as a design proposal. It needs pinned sessions that survive several user actions, which adds risk to the first release.

## Decision

v1 supports one transaction per statement and one transaction for the script. Manual transactions are planned after v1.

## Consequences

The GUI shows no manual-mode controls in v1. The data model leaves room for a transaction session entity. The idle-transaction part of acceptance criterion 8 moves with this feature.
