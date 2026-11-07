# 0023. Result values are captured as the engine's text form

Status: Accepted · 7 November 2026

## Context

Results feed previews, MCP responses and CSV exports. Converting to JavaScript types loses information: `bigint` and `numeric` beyond 2^53, time zones, `interval`, arrays and JSON formatting.

## Decision

Adapters return every value as text in the engine's own text form, or `null`.

- PostgreSQL: the text output of each type (type parsing in node-postgres is off).
- MySQL: the bytes the server sends, decoded as UTF-8 (big numbers and dates as strings).
- Binary columns (`bytea`; MySQL binary strings, BLOBs, `BIT` and `GEOMETRY`) are `\x` followed by lowercase hex, and the column is flagged `binary`.

Each column carries the engine's type name.

## Consequences

- Values are lossless and the same in the preview, MCP and exports. CSV writes them unchanged, and `NULL` is an empty field without quotes ([0007](0007-csv-null-representation.md)).
- Clients that want numbers or dates convert them using the column type.
