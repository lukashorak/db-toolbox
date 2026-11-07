# 0006. Keep "Export preview only", clearly labelled

Status: Accepted · 7 November 2026

## Context

Users sometimes want the rows they already see without capturing the full result. A preview must never pass for a complete export.

## Decision

Offer "Export preview only". The file name contains `PREVIEW-ONLY`, JSON states `"completeness": "preview_only"`, and the GUI never calls it "Export all".

## Consequences

"Export full result" stays available only for complete captured results.
