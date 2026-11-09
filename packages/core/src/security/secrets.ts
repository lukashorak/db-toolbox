import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../domain/errors.js';

const VERSION = 'v1';

/**
 * Authenticated encryption (AES-256-GCM) for stored credentials. The key comes from the
 * deployment, never from SQLite. Binding each ciphertext to its record through associated data
 * prevents copying a sealed secret onto another connection.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('SecretBox requires a 32-byte key');
    this.#key = Buffer.from(key);
  }

  seal(value: unknown, associatedData: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(Buffer.from(associatedData, 'utf8'));
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), body.toString('base64url')].join(
      '.',
    );
  }

  open<T>(sealed: string, associatedData: string): T {
    const [version, iv, tag, body] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || body === undefined) {
      throw new AppError('secret_unreadable', 'A stored secret has an unknown format.');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
      decipher.setAAD(Buffer.from(associatedData, 'utf8'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]);
      return JSON.parse(plain.toString('utf8')) as T;
    } catch {
      throw new AppError(
        'secret_unreadable',
        'A stored secret cannot be decrypted. The encryption key may have changed.',
      );
    }
  }
}
