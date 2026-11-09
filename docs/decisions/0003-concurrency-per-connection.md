# 0003. Two running executions per connection, shared by GUI and MCP

Status: Accepted · 7 November 2026

## Context

Executions must not overload a target database, and queued work needs a clear position and reason.

## Decision

At most 2 executions run at once per stored connection (configurable through `CONCURRENCY_PER_CONNECTION`). Further submissions wait in a FIFO queue for that connection. GUI and MCP share the same slots; there is no reserved slot per source.

## Consequences

The queue position and reason are visible in the GUI and through MCP. Authorization is checked again when queued work starts. A global safety cap may still apply.
