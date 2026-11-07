# 0008. MCP disclosure approval covers one result set

Status: Accepted · 7 November 2026

## Context

Disclosing more than the preview allowance to an MCP client needs a separate human approval that is narrowly scoped.

## Decision

An approval covers one result set of one execution for one MCP profile, with an amount and an expiry (1 hour suggested, bounded by result retention).

## Consequences

The approval key is `(execution_id, result_set, profile_id)`. Other result sets of the same execution need their own approval.
