# Exports: format reference

Exports are written from captured results only. They never run SQL, so creating, repeating or regenerating one cannot change the database or create another execution. Code: `packages/core/src/execution/exports.ts`.

## When an export is possible

| Result completeness                               | Full export             | "Export preview only" |
| ------------------------------------------------- | ----------------------- | --------------------- |
| `complete`                                        | yes                     | yes                   |
| `preview_limited`, `quota_limited`, `interrupted` | no (`not_complete`)     | yes                   |
| `capturing`                                       | no (`export_not_ready`) | no                    |
| `expired`, `deleted`                              | no (`result_expired`)   | no                    |

A preview-only export says so in two places:

- the file name ends in `-PREVIEW-ONLY.csv` or `-PREVIEW-ONLY.json`;
- JSON states `"completeness": "preview_only"` and `"moreAvailable"`.

## Lifecycle

`generating` → `ready` or `failed`, and later `expired` (with its result) or `deleted` (when the result is deleted).

- Files go to `<EXPORT_DIR>/<execution id>/`. They are written as `<export id>.part` and renamed to the final name only when complete. The file name is published only then.
- Failures:
  - `disk_full`;
  - `write_permission`;
  - `generation_failed`, for any other error.

  No partial file is left behind.

- **Regenerate** rebuilds the file from the captured rows.
- A download checks access and that the file exists (`export_missing`). It never regenerates the file.
- Deleting a stored result removes its rows and export files, and revokes any pending or active disclosure. The execution and its statements stay in history.

## CSV

- RFC 4180, UTF-8 without a byte order mark, CRLF line endings, and a header row.
- `NULL` is an empty field without quotes. An empty string is `""` ([decision 0007](decisions/0007-csv-null-representation.md)).
- A field is quoted when it is empty or contains `"`, `,`, CR or LF. A `"` inside it is doubled.
- Values are written exactly as captured ([decision 0023](decisions/0023-values-as-text.md)):
  - numbers keep every digit (`9223372036854775807`, `12345678901234567890.1234567890`);
  - timestamps appear as the database returned them;
  - binary values are `\x` followed by lowercase hex.
- Duplicate column names stay duplicated.
- Values that begin with `=`, `+`, `-` or `@` are not altered either. Spreadsheet programs can treat such a cell as a formula, so import untrusted data as text, or use JSON ([security.md](security.md#accepted-risks)).

## JSON

```json
{
  "format": "database-workbench.result.v1",
  "completeness": "complete",
  "capturedRows": 1200,
  "exportedRows": 1200,
  "moreAvailable": false,
  "execution": { "id": "ex_…", "title": "…", "connection": "…", "engine": "postgresql", "submittedAt": "…" },
  "resultIndex": 0,
  "columns": [
    { "name": "id", "type": "int4", "binary": false },
    { "name": "id", "type": "int4", "binary": false }
  ],
  "rows": [["1", "10"]]
}
```

- Rows are arrays, so duplicate column names survive.
- `null` is NULL.
- Values are strings with their exact digits.
- Binary values are `{ "base64": "…" }`.
- `completeness` is `complete` or `preview_only`.

## Retention

Exports expire with their result: working results after 24 hours, retained results after their days (at most 7). Cleanup runs every 10 minutes:

1. export files of expired results are removed first;
2. then the captured rows;
3. after 90 days, the execution metadata and its export folder.
