# 0007. CSV: NULL is an empty unquoted field

Status: Accepted · 7 November 2026

## Context

CSV has no native NULL. Exports must keep NULL and empty text distinguishable.

## Decision

NULL is written as an empty unquoted field; an empty string is written as `""`. Files use RFC 4180 quoting and UTF-8.

## Consequences

The export format reference documents the rule, and tests cover NULL versus empty text.
