import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '../src/lib/live';
import { followJobs, jobs } from '../src/lib/session.svelte';

/** Every API request waits until the test answers it. */
const pending = vi.hoisted(() => [] as { url: string; answer: (value: unknown) => void }[]);
const api = vi.hoisted(() =>
  vi.fn((_method: string, url: string) => new Promise((resolve) => pending.push({ url, answer: resolve }))),
);
vi.mock('../src/lib/api', () => ({ api, ApiError: class extends Error {} }));

/** The handlers the shell gives the live connection; the test plays the server's side. */
const live = vi.hoisted(() => ({
  handlers: null as null | { onEvent: (event: LiveEvent) => void; onConnected?: () => void },
}));
vi.mock('../src/lib/live', () => ({
  connectLive: (handlers: NonNullable<typeof live.handlers>) => {
    live.handlers = handlers;
    return () => undefined;
  },
}));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Executions `ex_1`, `ex_2`, … were submitted a minute apart, in that order. */
const summary = (status: string, id = 'ex_1') => ({
  id,
  title: 'Load',
  status,
  transactionOutcome: status === 'succeeded' ? 'committed' : 'not_started',
  connection: { name: 'app' },
  submittedAt: `2026-11-08T10:0${id.slice(3)}:00.000Z`,
});
const event = (status: string, id = 'ex_1'): LiveEvent => ({
  type: 'execution',
  data: { id, status, transactionOutcome: summary(status).transactionOutcome },
});
/** Answers the oldest open request for `url`. */
async function answer(url: string, value: unknown) {
  const at = pending.findIndex((p) => p.url === url);
  expect(at, `a request for ${url}`).toBeGreaterThanOrEqual(0);
  pending.splice(at, 1)[0]?.answer(value);
  await flush();
}

describe('shell job status', () => {
  beforeEach(() => {
    pending.length = 0;
    api.mockClear();
    jobs.items = [];
    followJobs();
  });

  it('keeps the newest status of an execution first seen in events while it is looked up', async () => {
    const handlers = live.handlers!;
    handlers.onEvent(event('queued'));
    handlers.onEvent(event('running'));
    handlers.onEvent(event('succeeded'));
    // The first answer was taken before the run finished; every lookup is answered in order.
    await answer('/executions/ex_1', summary('queued'));
    while (pending.some((p) => p.url === '/executions/ex_1'))
      await answer('/executions/ex_1', summary('succeeded'));
    expect(jobs.items.map((j) => [j.id, j.status, j.transactionOutcome])).toEqual([
      ['ex_1', 'succeeded', 'committed'],
    ]);
    // One lookup for the execution, not one per event.
    expect(api.mock.calls.filter(([, url]) => url === '/executions/ex_1')).toHaveLength(1);
  });

  it('does not let a list taken before a live event undo that event', async () => {
    const handlers = live.handlers!;
    handlers.onConnected?.();
    await answer('/executions?limit=20', [summary('running')]);
    expect(jobs.items[0]?.status).toBe('running');
    // A reconnect asks for the list while the run is still running…
    handlers.onConnected?.();
    // …and the run finishes before that answer arrives.
    handlers.onEvent(event('succeeded'));
    await answer('/executions?limit=20', [summary('running')]);
    expect(jobs.items[0]?.status).toBe('succeeded');
    expect(jobs.items[0]?.transactionOutcome).toBe('committed');
  });

  it('keeps an execution first seen while the list loaded, though the list does not have it', async () => {
    const handlers = live.handlers!;
    handlers.onConnected?.();
    await answer('/executions?limit=20', [summary('succeeded')]);
    // A reconnect asks for the list; then a new execution starts, finishes and is looked up…
    handlers.onConnected?.();
    handlers.onEvent(event('queued', 'ex_2'));
    handlers.onEvent(event('succeeded', 'ex_2'));
    await answer('/executions/ex_2', summary('succeeded', 'ex_2'));
    expect(jobs.items.map((j) => j.id)).toEqual(['ex_2', 'ex_1']);
    // …before the list, taken earlier, arrives without it. No later event would bring it back.
    await answer('/executions?limit=20', [summary('succeeded')]);
    expect(jobs.items.map((j) => [j.id, j.status])).toEqual([
      ['ex_2', 'succeeded'],
      ['ex_1', 'succeeded'],
    ]);
  });

  it('drops jobs that were shown before but the newer list no longer has', async () => {
    const handlers = live.handlers!;
    handlers.onConnected?.();
    await answer('/executions?limit=20', [summary('succeeded', 'ex_2'), summary('succeeded')]);
    handlers.onConnected?.();
    // ex_1 fell out of the twenty newest since; it is not kept for having been shown before.
    await answer('/executions?limit=20', [summary('succeeded', 'ex_3'), summary('succeeded', 'ex_2')]);
    expect(jobs.items.map((j) => j.id)).toEqual(['ex_3', 'ex_2']);
  });

  it('still takes a later status from the list than the one shown', async () => {
    const handlers = live.handlers!;
    handlers.onConnected?.();
    await answer('/executions?limit=20', [summary('running')]);
    // While offline the run finished; the list after the reconnect says so.
    handlers.onConnected?.();
    await answer('/executions?limit=20', [summary('succeeded')]);
    expect(jobs.items[0]?.status).toBe('succeeded');
  });
});
