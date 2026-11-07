import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Prefixes make identifiers recognizable in logs, URLs and MCP responses. */
export const ID_PREFIXES = {
  connection: 'cn',
  profile: 'mcp',
  folder: 'f',
  query: 'q',
  execution: 'ex',
  export: 'exp',
  approval: 'apr',
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

function encodeTime(ms: number): string {
  let value = ms;
  let out = '';
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[value % 32] + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out.slice(0, 16);
}

/** ULID-style identifier: 10 characters of time, 16 of randomness, sortable by creation time. */
export function newId(kind: IdKind, now: Date = new Date()): string {
  return `${ID_PREFIXES[kind]}_${encodeTime(now.getTime())}${encodeRandom(randomBytes(10))}`;
}

export const ID_PATTERN = /^[a-z]{1,4}_[0-9A-HJKMNP-TV-Z]{26}$/;
