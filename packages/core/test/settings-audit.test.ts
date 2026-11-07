import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactDetails } from '../src/audit.js';
import { AppError } from '../src/domain/errors.js';
import { newId } from '../src/domain/ids.js';
import { admin, testCore, writer } from './helpers.js';

const code = (c: string) => (e: unknown) => e instanceof AppError && e.code === c;

describe('SettingsService', () => {
  it('starts from the agreed defaults and lets only administrators change them', () => {
    const core = testCore();
    assert.deepEqual(core.settings.defaults(), {
      ordinaryTimeoutMs: 30000,
      fullTimeoutMaxMs: 300000,
      concurrencyPerConnection: 2,
      workingRetentionHours: 24,
      retainedMaxDays: 7,
      metadataRetentionDays: 90,
      monitoringRefreshSeconds: 15,
    });
    assert.throws(
      () => core.settings.updateDefaults(writer, { concurrencyPerConnection: 1 }),
      code('forbidden'),
    );
    assert.equal(
      core.settings.updateDefaults(admin, { concurrencyPerConnection: 1 }).concurrencyPerConnection,
      1,
    );
    const [event] = core.audit.list(admin, { actionPrefix: 'settings.' });
    assert.deepEqual(event?.details, { changed: { concurrencyPerConnection: { from: 2, to: 1 } } });
  });

  it('keeps defaults inside the deployment limits', () => {
    const core = testCore();
    assert.throws(
      () => core.settings.updateDefaults(admin, { fullTimeoutMaxMs: 600000 }),
      code('validation_failed'),
    );
    assert.throws(
      () => core.settings.updateDefaults(admin, { ordinaryTimeoutMs: 400000 }),
      code('validation_failed'),
    );
  });
});

describe('AuditLog', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redactDetails({
      password: 'p',
      nested: { accessToken: 't', host: 'h', list: [{ secret: 's', ok: 1 }] },
      sql: 'SELECT 1',
      params: [1],
      rows: [[1]],
      credential: 'replaced',
    }) as Record<string, unknown>;
    assert.deepEqual(out, {
      password: '[redacted]',
      nested: { accessToken: '[redacted]', host: 'h', list: [{ secret: '[redacted]', ok: 1 }] },
      sql: '[redacted]',
      params: '[redacted]',
      rows: '[redacted]',
      credential: 'replaced',
    });
  });

  it('lists events newest first with filters and cursor pagination, for administrators', () => {
    const core = testCore();
    for (let i = 0; i < 5; i++)
      core.audit.record({ actor: writer, action: `query.create`, outcome: 'succeeded' });
    core.audit.record({ actor: 'system', action: 'retention.cleanup', outcome: 'succeeded' });
    assert.throws(() => core.audit.list(writer), code('forbidden'));
    const page = core.audit.list(admin, { limit: 2 });
    assert.equal(page[0]?.action, 'retention.cleanup');
    assert.equal(page[0]?.actorLabel, 'System');
    assert.equal(page[0]?.source, 'server');
    const next = core.audit.list(admin, { limit: 10, before: page[1]?.id, actionPrefix: 'query.' });
    assert.equal(next.length, 4);
    assert.equal(core.audit.list(admin, { source: 'server' }).length, 1);
  });
});

describe('ids', () => {
  it('are prefixed and sort by creation time', () => {
    const a = newId('execution', new Date(Date.UTC(2026, 10, 7, 10)));
    const b = newId('execution', new Date(Date.UTC(2026, 10, 7, 11)));
    assert.match(a, /^ex_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.ok(a < b);
  });
});
