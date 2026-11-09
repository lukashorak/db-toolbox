# 0018. Server-sent events with polling fallback

Status: Accepted · 7 November 2026

## Context

The GUI shows job status changes for executions that belong to the server and survive browser restarts.

## Decision

Use server-sent events for execution and export status, with polling as a fallback.

## Consequences

After reconnecting, the GUI reads current state by execution ID; events are a convenience, not the source of truth.
