import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { assert } from './types.js';

export class SecretBox {
  private key: Buffer;
  constructor(encodedKey: string) {
    this.key = Buffer.from(encodedKey, 'base64');
    assert(
      this.key.length === 32,
      'INVALID_KEY',
      'Encryption key must contain 32 base64-encoded random bytes.',
    );
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
  }
  open<T>(value: string): T {
    const [iv, tag, body] = value.split('.').map((s) => Buffer.from(s, 'base64'));
    assert(iv && tag && body, 'INVALID_SECRET', 'Invalid encrypted connection.');
    const cipher = createDecipheriv('aes-256-gcm', this.key, iv);
    cipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString('utf8')) as T;
  }
}
