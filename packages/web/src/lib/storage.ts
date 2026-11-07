/**
 * Browser storage for per-user conveniences (open tabs, SQL drafts). It can be unavailable
 * (private windows, blocked site data), so every access is guarded and the app works without it.
 */
export function read<T>(key: string, fallback: T, store: Storage | undefined = globalThis.localStorage): T {
  try {
    const raw = store?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function write(
  key: string,
  value: unknown,
  store: Storage | undefined = globalThis.localStorage,
): boolean {
  try {
    store?.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export interface DraftTab {
  id: string;
  title: string;
  sql: string;
  connectionId: string | null;
}

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
