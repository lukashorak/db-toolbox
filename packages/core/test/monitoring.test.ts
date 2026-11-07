import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { EXECUTION_TAG, rates } from '../src/monitoring/service.js';

describe('counter rates', () => {
  it('has no rate for the first sample', () => {
    const r = rates(undefined, { at: 1000, values: { commits: 10 }, marker: 'a' }, 'a');
    assert.deepEqual([r.intervalSeconds, r.reset, r.perSecond.commits], [null, false, null]);
  });

  it('computes per-second rates between samples', () => {
    const r = rates(
      { at: 1000, values: { commits: 10, reads: 0 }, marker: 'a' },
      { at: 3000, values: { commits: 30, reads: 5 }, marker: 'a' },
      'a',
    );
    assert.deepEqual([r.intervalSeconds, r.perSecond.commits, r.perSecond.reads], [2, 10, 2.5]);
  });

  it('treats a changed reset marker or a falling counter as a reset, without a rate', () => {
    const marker = rates(
      { at: 0, values: { commits: 10 }, marker: 'a' },
      { at: 1000, values: { commits: 20 }, marker: 'b' },
      'b',
    );
    assert.deepEqual([marker.reset, marker.perSecond.commits], [true, null]);
    const falling = rates(
      { at: 0, values: { commits: 10, uptime: 500 }, marker: null },
      { at: 1000, values: { commits: 12, uptime: 3 }, marker: null },
      null,
    );
    assert.deepEqual([falling.reset, falling.perSecond.commits], [true, null]);
  });

  it('recognises execution tags in application names and query comments', () => {
    assert.equal(EXECUTION_TAG.exec('database-workbench ex_01ABCDEF')?.[1], 'ex_01ABCDEF');
    assert.equal(EXECUTION_TAG.exec('/* database-workbench ex_9Z */ SELECT 1')?.[1], 'ex_9Z');
    assert.equal(EXECUTION_TAG.exec('psql'), null);
  });
});
