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

let lastMs = -1;
let lastRandom: Buffer = Buffer.alloc(10);

/** Adds one to a big-endian number; it would only wrap after 2^80 identifiers in one millisecond. */
function increment(bytes: Buffer): Buffer {
  const next = Buffer.from(bytes);
  for (let i = next.length - 1; i >= 0; i--) {
    if (next[i] === 255) next[i] = 0;
    else {
      next[i] = (next[i] as number) + 1;
      break;
    }
  }
  return next;
}

/**
 * ULID-style identifier: 10 characters of time, 16 of randomness, sortable by creation time.
 * Within one millisecond the random part counts up (monotonic ULID), so identifiers made in the
 * same millisecond still sort in creation order; the queue relies on that for first in, first out.
 */
export function newId(kind: IdKind, now: Date = new Date()): string {
  const ms = now.getTime();
  lastRandom = ms === lastMs ? increment(lastRandom) : randomBytes(10);
  lastMs = ms;
  return `${ID_PREFIXES[kind]}_${encodeTime(ms)}${encodeRandom(lastRandom)}`;
}

export const ID_PATTERN = /^[a-z]{1,4}_[0-9A-HJKMNP-TV-Z]{26}$/;
