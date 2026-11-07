import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AppError } from '../src/domain/errors.js';
import { SecretBox } from '../src/security/secrets.js';

const box = new SecretBox(Buffer.alloc(32, 1));
const unreadable = (e: unknown) => e instanceof AppError && e.code === 'secret_unreadable';

describe('SecretBox', () => {
  it('round-trips a value bound to its record', () => {
    const sealed = box.seal({ password: 'p@ss' }, 'cn_1');
    assert.ok(!sealed.includes('p@ss'));
    assert.deepEqual(box.open(sealed, 'cn_1'), { password: 'p@ss' });
    assert.notEqual(box.seal({ password: 'p@ss' }, 'cn_1'), sealed, 'a fresh IV is used every time');
  });

  it('refuses a ciphertext copied onto another record', () => {
    assert.throws(() => box.open(box.seal({ password: 'x' }, 'cn_1'), 'cn_2'), unreadable);
  });

  it('refuses a different key, tampering and unknown formats', () => {
    const sealed = box.seal({ password: 'x' }, 'cn_1');
    assert.throws(() => new SecretBox(Buffer.alloc(32, 2)).open(sealed, 'cn_1'), unreadable);
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    assert.throws(() => box.open(parts.join('.'), 'cn_1'), unreadable);
    assert.throws(() => box.open('plain', 'cn_1'), unreadable);
  });

  it('requires a 32-byte key', () => {
    assert.throws(() => new SecretBox(Buffer.alloc(16)));
  });
});
