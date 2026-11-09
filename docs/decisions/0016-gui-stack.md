# 0016. Svelte 5 + Vite SPA with CodeMirror 6

Status: Accepted · 7 November 2026

## Context

The GUI is a desktop-first single-page app served by the same process.

## Decision

Use Svelte 5 with Vite (no server rendering), CodeMirror 6 with `@codemirror/lang-sql`, `sql-formatter`, and an own virtualized grid limited to the 1,000-row display cap.

## Consequences

SvelteKit with the static adapter was the alternative; routing stays simple without it.
