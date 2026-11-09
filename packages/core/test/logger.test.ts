import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import { createLogger, REDACTED } from '../src/logger.js';

const capture = () => {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, logger: createLogger({ level: 'info', destination }) };
};

describe('createLogger', () => {
  it('redacts credentials, tokens, SQL, parameters and rows', () => {
    const { lines, logger } = capture();
    logger.info(
      {
        executionId: 'ex_1',
        password: 'hunter2',
        connection: { password: 's3cret', host: 'pg.example.test' },
        token: 'eyJhbGciOi',
        req: { headers: { authorization: 'Bearer eyJhbGciOi', cookie: 'sid=abc' } },
        sql: 'SELECT secret FROM vault',
        params: ['4111 1111 1111 1111'],
        result: { rows: [['private']] },
      },
      'submitted',
    );
    const out = lines.join('');
    for (const value of ['hunter2', 's3cret', 'eyJhbGciOi', 'sid=abc', 'SELECT secret', '4111', 'private']) {
      assert.ok(!out.includes(value), `log contains ${value}`);
    }
    const entry = JSON.parse(out) as Record<string, unknown>;
    assert.equal(entry.password, REDACTED);
    assert.equal(entry.executionId, 'ex_1');
    assert.equal((entry.connection as Record<string, unknown>).host, 'pg.example.test');
    assert.equal(entry.service, 'database-workbench');
  });
});
