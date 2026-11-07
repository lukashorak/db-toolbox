import { session } from './session.svelte';
import { loadTabs, saveTabs, type DraftTab } from './storage';

/** Workbench tabs, shared so the explorer and saved queries can open SQL in a new tab. */
export const workbench = $state<{ tabs: DraftTab[]; active: string | null; loadedFor: string | null }>({
  tabs: [],
  active: null,
  loadedFor: null,
});

const subject = () => session.user?.subject ?? 'anonymous';

export function ensureLoaded(): void {
  if (workbench.loadedFor === subject()) return;
  const saved = loadTabs(subject());
  workbench.tabs = saved.tabs.length ? saved.tabs : [newTab(1)];
  workbench.active =
    saved.active && workbench.tabs.some((t) => t.id === saved.active)
      ? saved.active
      : (workbench.tabs[0]?.id ?? null);
  workbench.loadedFor = subject();
}

export function persist(): void {
  if (workbench.loadedFor)
    saveTabs(subject(), { tabs: $state.snapshot(workbench.tabs), active: workbench.active });
}

function newTab(n: number, init: Partial<DraftTab> = {}): DraftTab {
  return { id: crypto.randomUUID(), title: `Query ${n}`, sql: '', connectionId: null, ...init };
}

export function openTab(init: Partial<DraftTab>): void {
  ensureLoaded();
  const tab = newTab(workbench.tabs.length + 1, init);
  workbench.tabs.push(tab);
  workbench.active = tab.id;
  persist();
}

export function closeTab(id: string): void {
  const at = workbench.tabs.findIndex((t) => t.id === id);
  if (at === -1) return;
  workbench.tabs.splice(at, 1);
  if (!workbench.tabs.length) workbench.tabs.push(newTab(1));
  if (workbench.active === id) workbench.active = workbench.tabs[Math.max(0, at - 1)]?.id ?? null;
  persist();
}

export function addTab(): void {
  openTab({});
}
