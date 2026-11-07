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

async function resync(): Promise<void> {
  const list = await api<ExecutionSummary[]>('GET', '/executions?limit=20');
  jobs.items = list.map(toJob);
  if (can('disclosure.decide')) {
    jobs.pendingApprovals = (await api<unknown[]>('GET', '/approvals?status=pending')).length;
  }
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
      if (job) {
        job.status = event.data.status;
        job.transactionOutcome = event.data.transactionOutcome;
      } else {
        void api<ExecutionSummary>('GET', `/executions/${event.data.id}`)
          .then((e) => {
            if (!jobs.items.some((j) => j.id === e.id)) jobs.items = [toJob(e), ...jobs.items].slice(0, 20);
          })
          .catch(() => undefined);
      }
    },
  });
}
