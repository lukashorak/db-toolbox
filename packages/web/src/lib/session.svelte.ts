import { SvelteMap } from 'svelte/reactivity';
import { api } from './api';
import type { ClientConfig } from './auth';
import { ACTIVE } from './labels';
import { connectLive } from './live';

export interface SessionUser {
  subject: string;
  username: string;
  displayName: string;
  roles: string[];
}

export const session = $state<{
  status: 'loading' | 'signed_in' | 'denied' | 'failed' | 'lost';
  user: SessionUser | null;
  permissions: string[];
  config: ClientConfig | null;
  error: string | null;
}>({ status: 'loading', user: null, permissions: [], config: null, error: null });

export const can = (permission: string) => session.permissions.includes(permission);

export interface Job {
  id: string;
  title: string;
  status: string;
  transactionOutcome: string;
  connection: string;
  submittedAt: string;
}

/** Recent executions of the signed-in user, kept current by server-sent events. */
export const jobs = $state<{
  items: Job[];
  live: 'connecting' | 'live' | 'offline';
  pendingApprovals: number;
  /** Bumped on every approval change, so open screens can reload. */
  approvalChanges: number;
}>({
  items: [],
  live: 'connecting',
  pendingApprovals: 0,
  approvalChanges: 0,
});

export const runningJobs = () => jobs.items.filter((j) => ACTIVE.has(j.status)).length;

interface ExecutionSummary {
  id: string;
  title: string;
  status: string;
  transactionOutcome: string;
  connection: { name: string };
  submittedAt: string;
}

const toJob = (e: ExecutionSummary): Job => ({
  id: e.id,
  title: e.title,
  status: e.status,
  transactionOutcome: e.transactionOutcome,
  connection: e.connection.name,
  submittedAt: e.submittedAt,
});

type Progress = Pick<Job, 'status' | 'transactionOutcome'>;

const STAGE: Record<string, number> = { queued: 0, running: 1, cancel_requested: 2 };
/** How far an execution has come: statuses only move forward, and a finished one never changes. */
const stage = (status: string) => STAGE[status] ?? 3;

/**
 * Shows `update` on `job` unless the job already shows a later status. Answers to requests and
 * live events can arrive out of order, and an older one must not undo a newer one. `newer` says
 * the update is at least as recent as what the job shows (a live event; events arrive in order),
 * so it also wins at the same stage.
 */
function advance(job: Job, update: Progress, newer: boolean): void {
  const ahead = stage(update.status) - stage(job.status);
  if (ahead < 0 || (ahead === 0 && !newer)) return;
  job.status = update.status;
  job.transactionOutcome = update.transactionOutcome;
}

/** Newest first, as the server lists them. */
const newestFirst = (a: Job, b: Job) =>
  b.submittedAt.localeCompare(a.submittedAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

async function resync(): Promise<void> {
  const known = new Set(jobs.items.map((j) => j.id));
  const list = await api<ExecutionSummary[]>('GET', '/executions?limit=20');
  // Events that arrived while the list loaded can be newer than it: keep the later status.
  const shown = new Map(
    jobs.items.map((j) => [j.id, { status: j.status, transactionOutcome: j.transactionOutcome }]),
  );
  const listed = new Set(list.map((e) => e.id));
  // Executions first seen in events while the list loaded can be missing from it: they stay.
  const added = jobs.items.filter((j) => !known.has(j.id) && !listed.has(j.id)).map((j) => ({ ...j }));
  jobs.items = [
    ...added,
    ...list.map((e) => {
      const job = toJob(e);
      const before = shown.get(e.id);
      if (before) advance(job, before, false);
      return job;
    }),
  ]
    .sort(newestFirst)
    .slice(0, 20);
  if (can('disclosure.decide')) {
    jobs.pendingApprovals = (await api<unknown[]>('GET', '/approvals?status=pending')).length;
  }
}

/** Executions being looked up, with the newest event received for each meanwhile. */
const lookups = new SvelteMap<string, Progress>();

/**
 * Adds an execution first seen in an event: one lookup at a time. The newest event received
 * meanwhile then applies where it is further along than the answer.
 */
function lookUp(id: string, event: Progress): void {
  const running = lookups.has(id);
  lookups.set(id, event);
  if (running) return;
  void api<ExecutionSummary>('GET', `/executions/${id}`)
    .then((e) => {
      if (!jobs.items.some((j) => j.id === id)) jobs.items = [toJob(e), ...jobs.items].slice(0, 20);
      const job = jobs.items.find((j) => j.id === id);
      const latest = lookups.get(id);
      if (!job) return;
      advance(job, e, false);
      if (latest) advance(job, latest, false);
    })
    .catch(() => undefined)
    .finally(() => lookups.delete(id));
}

/** Starts following live status; returns a function that stops it. */
export function followJobs(): () => void {
  return connectLive({
    onState: (state) => (jobs.live = state),
    // After every (re)connect, fetch the current state by ID: nothing is lost while offline.
    onConnected: () => void resync().catch(() => undefined),
    onEvent: (event) => {
      if (event.type === 'approval') {
        jobs.approvalChanges++;
        if (can('disclosure.decide'))
          void api<unknown[]>('GET', '/approvals?status=pending')
            .then((list) => (jobs.pendingApprovals = list.length))
            .catch(() => undefined);
        return;
      }
      if (event.type !== 'execution') return;
      const job = jobs.items.find((j) => j.id === event.data.id);
      if (job) advance(job, event.data, true);
      else lookUp(event.data.id, event.data);
    },
  });
}
