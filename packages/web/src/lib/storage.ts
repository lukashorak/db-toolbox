/**
 * Browser storage for per-user conveniences (open tabs, SQL drafts). It can be unavailable
 * (private windows, blocked site data), so every access is guarded and the app works without it.
 */
/** Even reading `localStorage` can throw (SecurityError) when site data is blocked. */
function defaultStore(): Storage | undefined {
  return globalThis.localStorage;
}

export function read<T>(key: string, fallback: T, store?: Storage): T {
  try {
    const raw = (store ?? defaultStore())?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function write(key: string, value: unknown, store?: Storage): boolean {
  try {
    (store ?? defaultStore())?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export interface RunSettings {
  captureMode: 'preview' | 'full';
  transactionMode: 'per_statement' | 'atomic';
  continueOnError: boolean;
  timeoutSeconds: number | null;
  /** null: working results (24 h); a number keeps them that many days. */
  retainDays: number | null;
}

export interface DraftTab {
  id: string;
  title: string;
  sql: string;
  connectionId: string | null;
  settings?: RunSettings;
  /** Executions started from this tab, newest first. */
  runs?: string[];
  /**
   * The request key of a submission the server has not answered yet (or whose answer was lost): it
   * may have started there. The next Run sends it again, so the server returns that execution
   * instead of starting the same SQL twice. Kept here, it survives a reload or another page.
   */
  pendingRequestKey?: string;
}

export const DEFAULT_SETTINGS: RunSettings = {
  captureMode: 'preview',
  transactionMode: 'per_statement',
  continueOnError: false,
  timeoutSeconds: null,
  retainDays: null,
};

const TABS = 'workbench.tabs.v1';

/** Tabs and drafts are kept per signed-in user, so a shared browser does not mix them. */
export function loadTabs(subject: string, store?: Storage): { tabs: DraftTab[]; active: string | null } {
  return read(`${TABS}.${subject}`, { tabs: [], active: null }, store);
}

export function saveTabs(
  subject: string,
  state: { tabs: DraftTab[]; active: string | null },
  store?: Storage,
): boolean {
  return write(`${TABS}.${subject}`, state, store);
}
