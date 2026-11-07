/** Labels and tones for statuses, shared by pills across the app (Tokens artboard). */
export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export const EXECUTION: Record<string, [string, Tone]> = {
  queued: ['Queued', 'neutral'],
  running: ['Running', 'info'],
  cancel_requested: ['Cancel requested', 'warning'],
  succeeded: ['Succeeded', 'success'],
  failed: ['Failed', 'danger'],
  rejected: ['Rejected', 'danger'],
  preflight_rejected: ['Rejected by policy', 'danger'],
  cancelled: ['Cancelled', 'neutral'],
  timed_out: ['Timed out', 'warning'],
  interrupted: ['Interrupted', 'warning'],
  unknown: ['Outcome unknown', 'warning'],
};

export const TRANSACTION: Record<string, [string, Tone]> = {
  not_started: ['Not started', 'neutral'],
  none: ['No writes', 'neutral'],
  committed: ['Committed', 'success'],
  rolled_back: ['Rolled back', 'neutral'],
  partial_commit: ['Partial commit', 'warning'],
  unknown: ['Commit unknown', 'warning'],
};

export const CAPTURE: Record<string, [string, Tone]> = {
  complete: ['Complete', 'success'],
  preview_limited: ['Preview-limited', 'info'],
  capturing: ['Capturing', 'info'],
  interrupted: ['Interrupted · incomplete', 'warning'],
  quota_limited: ['Quota-limited · incomplete', 'warning'],
  expired: ['Expired', 'neutral'],
  deleted: ['Deleted', 'neutral'],
};

export const MONITORING: Record<string, [string, Tone]> = {
  available: ['Available', 'success'],
  limited: ['Limited', 'warning'],
  unavailable: ['Unavailable', 'neutral'],
};

export const TONE_ICON: Record<Tone, string> = {
  neutral: '○',
  info: '◔',
  success: '✓',
  warning: '!',
  danger: '✕',
};

export const ACTIVE = new Set(['queued', 'running', 'cancel_requested']);
