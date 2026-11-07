# 0009. Node.js 24 LTS and strict TypeScript

Status: Accepted · 7 November 2026

## Context

The requirements propose TypeScript on a supported Node.js LTS release.

## Decision

Use Node.js 24 (pinned in `.nvmrc`, `engines` and CI) and TypeScript 6 in strict mode with ESM and NodeNext resolution.

## Consequences

TypeScript 7 (native compiler) is not used until svelte-check and typescript-eslint support it.
