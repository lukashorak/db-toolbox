import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, type Actor, type Cell, type Result } from './types.js';
import { Store, type ExportRecord } from './store.js';

function csv(cell: Cell): string {
  if (cell === null) return '\\N';
  const value = typeof cell === 'object' ? `base64:${cell.base64}` : String(cell);
  // Quote all non-null values so an actual string "\\N" is distinct from NULL.
  return `"${value.replaceAll('"', '""')}"`;
}
export async function exportResult(
  store: Store,
  result: Result,
  actor: Actor,
  directory: string,
  format: 'csv' | 'json',
): Promise<ExportRecord> {
  assert(
    result.completeness === 'complete' && result.expiresAt > Date.now(),
    'RESULT_INCOMPLETE',
    'A complete, unexpired result is required for full export.',
    409,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const path = join(directory, `${id}.${format}`);
  const temporary = path + '.partial';
  const file = await open(temporary, 'wx', 0o600);
  try {
    if (format === 'csv')
      await file.write(result.columns.map((c) => csv(c.name)).join(',') + '\r\n');
    else
      await file.write(
        JSON.stringify({
          columns: result.columns,
          executionId: result.executionId,
          resultId: result.id,
        }).slice(0, -1) + ',"rows":[',
      );
    let count = 0;
    for (const row of store.rows(result.id)) {
      await file.write(
        format === 'csv'
          ? row.map(csv).join(',') + '\r\n'
          : (count ? ',' : '') + JSON.stringify(row),
      );
      count++;
    }
    assert(count === result.rows, 'RESULT_INCOMPLETE', 'Captured rows changed during export.', 409);
    if (format === 'json') await file.write(']}');
    await file.sync();
    await file.close();
    await rename(temporary, path);
    const value: ExportRecord = {
      id,
      owner: actor.subject,
      resultId: result.id,
      format,
      path,
      bytes: (await stat(path)).size,
      rows: result.rows,
      expiresAt: result.expiresAt,
      createdAt: Date.now(),
    };
    store.addExport(value);
    store.audit(actor, 'result.export', result.id, { exportId: id, format, rows: result.rows });
    return value;
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    await rm(path, { force: true });
    throw error;
  }
}
