import { DbError } from './errors.js';

/** How long a statement's connection may stay silent after a cancel or the time limit. */
export const STALL_GRACE_MS = 5000;

/**
 * A cancel request on the control connection gives up after this long without an answer, and that
 * connection is closed, not reused: a stalled one cannot hold the control pool and every later
 * cancel behind it. Waiting for a control connection is bounded too (MySQL: this long; PostgreSQL:
 * the connection timeout), and a request still waiting then is withdrawn, so it cannot run later.
 */
export const CONTROL_TIMEOUT_MS = 5000;

/** True if the promise settles (either way) within `ms`. */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return settled;
}

/**
 * Bounds the waits on a statement's own connection once the statement is interrupted. A cancel
 * travels over another connection: it stops the statement on the server, but cannot end a read on a
 * connection that stopped answering without closing (a network partition, a frozen host). Once
 * interrupted, a wait on the connection that does not settle within the grace period closes the
 * connection (`abandon`), which ends the wait as a lost connection: whether the statement took
 * effect is unknown, and the session is discarded.
 */
export class StallGuard {
  /** The connection was closed because it stopped answering. */
  abandoned = false;
  #interrupted = false;
  #waiting = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly abandon: () => void,
    private readonly graceMs = STALL_GRACE_MS,
  ) {}

  /** The statement was cancelled, reached its time limit or was stopped. */
  interrupted(): void {
    this.#interrupted = true;
    this.#arm();
  }

  /** Waits for work on the connection; bounded once the statement is interrupted. */
  async wait<T>(work: Promise<T>): Promise<T> {
    this.#waiting++;
    this.#arm();
    try {
      return await work;
    } finally {
      if (--this.#waiting === 0) this.stop();
    }
  }

  stop(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** The error a statement ends with when its connection was closed for not answering. */
  error(): DbError {
    return new DbError(
      'connectivity',
      `The database server stopped answering after the statement was interrupted; the connection was closed after ${this.graceMs} ms. Whether the statement took effect is unknown.`,
    );
  }

  #arm(): void {
    if (!this.#interrupted || this.#waiting === 0 || this.#timer || this.abandoned) return;
    this.#timer = setTimeout(() => {
      this.abandoned = true;
      this.abandon();
    }, this.graceMs);
  }
}
